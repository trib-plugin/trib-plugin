#!/usr/bin/env node
// Aggregated test runner. Discovers every scripts/test-*.mjs, runs each in
// a child node process concurrently (workers = CPU count, capped at 8),
// captures the `PASS n/m` marker, and reports totals.
//
// Conventions each test script must follow:
//   • Print a `PASS n/m` line somewhere in stdout on success.
//   • Exit with a non-zero code when at least one assertion fails.
//
// Scripts without a `PASS` marker are tagged SKIPPED — they don't fail the
// suite. Scripts whose PASS marker is partial AND whose exit code is
// non-zero are counted as FAIL.
//
// Usage:
//   node scripts/run-all-tests.mjs                          # run everything
//   node scripts/run-all-tests.mjs --only=ast,bash-accuracy # filter
//   TEST_TIMEOUT_MS=60000 node scripts/run-all-tests.mjs    # override timeout
//   TEST_CONCURRENCY=1 node scripts/run-all-tests.mjs       # force serial

import { readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { cpus } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = __dirname

const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 120_000)
const CONCURRENCY = Math.max(1, Number(process.env.TEST_CONCURRENCY || Math.min(8, cpus().length)))

const filterArg = process.argv.find(a => a.startsWith('--only='))
const filterTokens = filterArg
  ? filterArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean)
  : null

const PASS_RE = /PASS\s+(\d+)\s*\/\s*(\d+)/

const files = readdirSync(SCRIPTS_DIR)
  .filter(f => f.startsWith('test-') && f.endsWith('.mjs'))
  .filter(f => !filterTokens || filterTokens.some(t => f.includes(t)))
  .sort()

if (files.length === 0) {
  console.error('No matching test scripts.')
  process.exit(0)
}

function runOne(file) {
  const started = Date.now()
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = spawn(process.execPath, [join(SCRIPTS_DIR, file)], {
      cwd: SCRIPTS_DIR,
      // TRIB_BRIDGE_TRACE_DISABLE keeps test fixture sessionIds (s1..s7,
      // m1..m3) and other test-driven trace events out of the production
      // bridge-trace.jsonl. See bridge-trace.mjs:appendBridgeTrace.
      env: { ...process.env, TRIB_BRIDGE_TRACE_DISABLE: '1' },
    })
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
    }, TIMEOUT_MS)
    child.stdout.on('data', d => { stdout += d.toString('utf8') })
    child.stderr.on('data', d => { stderr += d.toString('utf8') })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        file, error: err, timedOut,
        elapsed: ((Date.now() - started) / 1000).toFixed(1),
      })
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({
        file, stdout, stderr,
        exitCode: code,
        signal,
        timedOut: timedOut || signal === 'SIGTERM',
        elapsed: ((Date.now() - started) / 1000).toFixed(1),
      })
    })
  })
}

// Worker pool: pull indices off a shared counter until exhausted.
async function runPool() {
  const results = new Array(files.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= files.length) break
      results[i] = await runOne(files[i])
    }
  }
  const n = Math.min(CONCURRENCY, files.length)
  await Promise.all(Array.from({ length: n }, worker))
  return results
}

const wallStart = Date.now()
const results = await runPool()
const wallElapsed = ((Date.now() - wallStart) / 1000).toFixed(1)

let totalPass = 0
let totalAsserts = 0
let failedScripts = 0
let skipped = 0
const statuses = []

// Print in original file order so output stays deterministic even though
// execution was concurrent.
for (const r of results) {
  if (!r) continue
  const out = `${r.stdout || ''}\n${r.stderr || ''}`
  const match = out.match(PASS_RE)
  process.stdout.write(`▶ ${r.file.padEnd(40)} `)

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
console.log(`         ${failedScripts} failed, ${skipped} skipped (no marker)`)

if (failedScripts > 0) {
  console.log()
  console.log('Failed / errored:')
  for (const r of statuses) {
    if (r.status !== 'pass' && r.status !== 'skipped') {
      console.log(`  • ${r.file} — ${r.status}${r.exitCode != null ? ` exit=${r.exitCode}` : ''}${r.err ? ` (${r.err})` : ''}`)
    }
  }
}

process.exit(failedScripts === 0 ? 0 : 1)
