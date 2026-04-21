#!/usr/bin/env node
// Aggregated test runner. Discovers every scripts/test-*.mjs, runs each in
// child node processes, captures PASS markers, and reports totals.
//
// Usage:
//   node scripts/run-all-tests.mjs                           # run everything
//   node scripts/run-all-tests.mjs --only=ast,bash-accuracy  # filter
//   node scripts/run-all-tests.mjs --changed                 # reverse local-import graph from changed files → tests
//   node scripts/run-all-tests.mjs --failed-only             # rerun only tests that failed last time
//   node scripts/run-all-tests.mjs --slow-first              # run cached slowest tests first
//   TEST_TIMEOUT_MS=60000 node scripts/run-all-tests.mjs     # override timeout
//   TEST_CONCURRENCY=1 node scripts/run-all-tests.mjs        # force serial

import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, basename, extname, relative, resolve } from 'node:path'
import { cpus } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = __dirname
const REPO_ROOT = join(SCRIPTS_DIR, '..')
const CACHE_PATH = join(SCRIPTS_DIR, '.run-all-tests-cache.json')

const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 120_000)
const CONCURRENCY = Math.max(1, Number(process.env.TEST_CONCURRENCY || Math.min(8, cpus().length)))
const SLOW_MS = Number(process.env.TEST_SLOW_MS || 15_000)
const HEARTBEAT_MS = Number(process.env.TEST_HEARTBEAT_MS || 10_000)

const PASS_RE = /PASS\s+(\d+)\s*\/\s*(\d+)/
const PASSED_ONLY_RE = /(?:^|\n)[^\n]*?(\d+)\s+passed\b/i
const LOCAL_IMPORT_PATTERNS = [
  /\bimport\s+(?:[^'"]*?\s+from\s+)?(['"])(\.{1,2}\/[^'"]+)\1/g,
  /\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g,
  /\brequire\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g,
]
const GRAPH_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts']
const INDEX_CANDIDATES = GRAPH_EXTENSIONS.map((ext) => `index${ext}`)

function normalizeRepoRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

function loadCache() {
  try {
    if (!existsSync(CACHE_PATH)) return { durations: {}, failed: [] }
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    return {
      durations: raw && typeof raw.durations === 'object' ? raw.durations : {},
      failed: Array.isArray(raw?.failed) ? raw.failed : [],
    }
  } catch {
    return { durations: {}, failed: [] }
  }
}

function saveCache(cache) {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf8')
  } catch {
    // best-effort only
  }
}

function listChangedFiles() {
  try {
    const res = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (res.status !== 0) return []
    return String(res.stdout || '')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const body = line.slice(3)
        if (body.includes(' -> ')) return body.split(' -> ').pop()
        return body
      })
      .filter(Boolean)
      .map((p) => normalizeRepoRel(p))
  } catch {
    return []
  }
}

function parseLocalImportSpecifiers(text) {
  const specs = new Set()
  for (const re of LOCAL_IMPORT_PATTERNS) {
    re.lastIndex = 0
    let match = null
    while ((match = re.exec(text))) {
      if (match[2]) specs.add(match[2])
    }
  }
  return [...specs]
}

function collectGraphFiles(root) {
  const out = []
  function walk(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(full)
        continue
      }
      if (GRAPH_EXTENSIONS.includes(extname(ent.name))) {
        out.push(normalizeRepoRel(relative(root, full)))
      }
    }
  }
  walk(root)
  return out.sort()
}

function resolveLocalImport(root, importerRel, spec, graphSet) {
  const importerAbs = resolve(root, importerRel)
  const base = resolve(dirname(importerAbs), spec)
  const candidates = []
  const relBase = normalizeRepoRel(relative(root, base))
  candidates.push(relBase)
  for (const ext of GRAPH_EXTENSIONS) candidates.push(`${relBase}${ext}`)
  for (const idx of INDEX_CANDIDATES) {
    candidates.push(normalizeRepoRel(relative(root, join(base, idx))))
  }
  return candidates.find((candidate) => graphSet.has(candidate)) || null
}

function buildReverseImportGraph(root) {
  const files = collectGraphFiles(root)
  const graphSet = new Set(files)
  const reverse = new Map()
  for (const relFile of files) {
    let text = ''
    try { text = readFileSync(join(root, relFile), 'utf8') } catch { continue }
    for (const spec of parseLocalImportSpecifiers(text)) {
      const target = resolveLocalImport(root, relFile, spec, graphSet)
      if (!target) continue
      if (!reverse.has(target)) reverse.set(target, new Set())
      reverse.get(target).add(relFile)
    }
  }
  return { files, graphSet, reverse }
}

function selectChangedTestsFromGraph(root, changedFiles, graphInfo = buildReverseImportGraph(root)) {
  if (!changedFiles.length) return []
  const queue = []
  const seen = new Set()
  const selected = new Set()

  for (const changed of changedFiles.map(normalizeRepoRel)) {
    if (changed.startsWith('scripts/test-')) selected.add(basename(changed))
    if (graphInfo.graphSet.has(changed)) queue.push(changed)
  }

  while (queue.length) {
    const cur = queue.shift()
    if (!cur || seen.has(cur)) continue
    seen.add(cur)
    if (cur.startsWith('scripts/test-')) selected.add(basename(cur))
    for (const importer of graphInfo.reverse.get(cur) || []) {
      if (!seen.has(importer)) queue.push(importer)
    }
  }

  return [...selected].sort()
}

export const _internals = {
  parseLocalImportSpecifiers,
  collectGraphFiles,
  buildReverseImportGraph,
  selectChangedTestsFromGraph,
  listChangedFiles,
}

function listTestFiles() {
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => f.startsWith('test-') && f.endsWith('.mjs'))
    .sort()
}

function runOne(file) {
  const started = Date.now()
  return new Promise((resolveResult) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let slowWarned = false
    const child = spawn(process.execPath, [join(SCRIPTS_DIR, file)], {
      cwd: SCRIPTS_DIR,
      env: { ...process.env, TRIB_BRIDGE_TRACE_DISABLE: '1' },
    })
    process.stdout.write(`↳ START ${file} (pid=${child.pid ?? 'n/a'})\n`)
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
    }, TIMEOUT_MS)
    const slowTimer = setTimeout(() => {
      slowWarned = true
      process.stdout.write(`… SLOW  ${file} (${((Date.now() - started) / 1000).toFixed(1)}s elapsed)\n`)
    }, SLOW_MS)
    const heartbeat = setInterval(() => {
      process.stdout.write(`… WAIT  ${file} (${((Date.now() - started) / 1000).toFixed(1)}s elapsed)\n`)
    }, HEARTBEAT_MS)
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (err) => {
      clearTimeout(timer)
      clearTimeout(slowTimer)
      clearInterval(heartbeat)
      resolveResult({
        file,
        error: err,
        timedOut,
        slowWarned,
        elapsed: ((Date.now() - started) / 1000).toFixed(1),
      })
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(slowTimer)
      clearInterval(heartbeat)
      resolveResult({
        file,
        stdout,
        stderr,
        exitCode: code,
        signal,
        timedOut: timedOut || signal === 'SIGTERM',
        slowWarned,
        elapsed: ((Date.now() - started) / 1000).toFixed(1),
      })
    })
  })
}

async function runPoolForFiles(filesToRun) {
  const results = new Array(filesToRun.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= filesToRun.length) break
      results[i] = await runOne(filesToRun[i])
    }
  }
  const n = Math.min(CONCURRENCY, filesToRun.length)
  await Promise.all(Array.from({ length: n }, worker))
  return results
}

export async function main(argv = process.argv.slice(2)) {
  const cache = loadCache()
  const filterArg = argv.find((a) => a.startsWith('--only='))
  const filterTokens = filterArg
    ? filterArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean)
    : null
  const failedOnly = argv.includes('--failed-only')
  const slowFirst = argv.includes('--slow-first')
  const changedOnly = argv.includes('--changed')

  let files = listTestFiles()
    .filter((f) => !filterTokens || filterTokens.some((t) => f.includes(t)))

  if (failedOnly) {
    const failedSet = new Set(cache.failed || [])
    files = files.filter((f) => failedSet.has(f))
  }

  if (changedOnly) {
    const changedFiles = listChangedFiles()
    const related = selectChangedTestsFromGraph(REPO_ROOT, changedFiles)
    files = files.filter((f) => related.includes(f))
  }

  if (slowFirst) {
    files = [...files].sort((a, b) => Number(cache.durations?.[b] || 0) - Number(cache.durations?.[a] || 0) || a.localeCompare(b))
  }

  if (files.length === 0) {
    console.error('No matching test scripts.')
    return 0
  }

  const wallStart = Date.now()
  const results = await runPoolForFiles(files)
  const wallElapsed = ((Date.now() - wallStart) / 1000).toFixed(1)

  let totalPass = 0
  let totalAsserts = 0
  let failedScripts = 0
  let skipped = 0
  let slowScripts = 0
  const statuses = []

  for (const r of results) {
    if (!r) continue
    const out = `${r.stdout || ''}\n${r.stderr || ''}`
    const match = out.match(PASS_RE)
    const passedOnly = match ? null : out.match(PASSED_ONLY_RE)
    process.stdout.write(`▶ ${r.file.padEnd(40)} `)
    if (r.slowWarned) slowScripts++

    if (r.timedOut) {
      console.log(`TIMEOUT (${TIMEOUT_MS}ms)  ${r.elapsed}s`)
      statuses.push({ file: r.file, status: 'timeout', elapsed: r.elapsed })
      failedScripts++
      continue
    }
    if (r.error) {
      console.log(`ERROR (${r.error.code || r.error.message})  ${r.elapsed}s`)
      statuses.push({ file: r.file, status: 'error', err: r.error.message, elapsed: r.elapsed })
      failedScripts++
      continue
    }
    if (!match) {
      if (r.exitCode === 0 && passedOnly) {
        const p = Number(passedOnly[1])
        totalPass += p
        totalAsserts += p
        console.log(`PASS ${p}/${p} (inferred)  ${r.elapsed}s`)
        statuses.push({ file: r.file, status: 'pass', pass: p, total: p, inferred: true, elapsed: r.elapsed })
        continue
      }
      console.log(`SKIPPED (no PASS marker, exit ${r.exitCode})  ${r.elapsed}s`)
      statuses.push({ file: r.file, status: 'skipped', exitCode: r.exitCode, elapsed: r.elapsed })
      skipped++
      continue
    }
    const p = Number(match[1])
    const t = Number(match[2])
    totalPass += p
    totalAsserts += t
    if (r.exitCode === 0 && p === t) {
      console.log(`PASS ${p}/${t}  ${r.elapsed}s`)
      statuses.push({ file: r.file, status: 'pass', pass: p, total: t, elapsed: r.elapsed })
    } else {
      console.log(`FAIL ${p}/${t} (exit ${r.exitCode})  ${r.elapsed}s`)
      statuses.push({ file: r.file, status: 'fail', pass: p, total: t, exitCode: r.exitCode, elapsed: r.elapsed })
      failedScripts++
    }
  }

  console.log()
  console.log('─'.repeat(60))
  console.log(`Summary: ${totalPass}/${totalAsserts} assertions across ${files.length} scripts in ${wallElapsed}s (concurrency=${CONCURRENCY})`)
  console.log(`         ${failedScripts} failed, ${skipped} skipped (no marker), ${slowScripts} slow (>${(SLOW_MS / 1000).toFixed(0)}s)`)
  const slowest = [...statuses]
    .filter((r) => r.status === 'pass' || r.status === 'fail' || r.status === 'timeout' || r.status === 'error')
    .sort((a, b) => Number(b.elapsed || 0) - Number(a.elapsed || 0))
    .slice(0, 5)
  if (slowest.length) {
    console.log(`         slowest: ${slowest.map((r) => `${r.file}=${r.elapsed}s`).join(', ')}`)
  }

  if (failedScripts > 0) {
    console.log()
    console.log('Failed / errored:')
    for (const r of statuses) {
      if (r.status !== 'pass' && r.status !== 'skipped') {
        console.log(`  • ${r.file} — ${r.status}${r.exitCode != null ? ` exit=${r.exitCode}` : ''}${r.err ? ` (${r.err})` : ''}`)
      }
    }
  }

  saveCache({
    durations: Object.fromEntries(statuses.map((r) => [r.file, Number(r.elapsed) || 0])),
    failed: statuses.filter((r) => r.status !== 'pass').map((r) => r.file),
  })

  return failedScripts === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
