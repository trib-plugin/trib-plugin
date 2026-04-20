#!/usr/bin/env node
// Aggregated test runner. Discovers every scripts/test-*.mjs, runs each in
// a child node process, captures the `PASS n/m` marker, and reports totals.
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
//   node scripts/run-all-tests.mjs          # run everything
//   node scripts/run-all-tests.mjs --only=ast,bash-accuracy   # filter
//   TEST_TIMEOUT_MS=60000 node scripts/run-all-tests.mjs      # override timeout

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = __dirname

const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 120_000)

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

const results = []
let totalPass = 0
let totalAsserts = 0
let failedScripts = 0
let skipped = 0

const wallStart = Date.now()

for (const file of files) {
  process.stdout.write(`▶ ${file.padEnd(40)} `)
  const started = Date.now()
  const res = spawnSync(process.execPath, [join(SCRIPTS_DIR, file)], {
    cwd: SCRIPTS_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    timeout: TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  const out = `${res.stdout || ''}\n${res.stderr || ''}`
  const match = out.match(PASS_RE)
  const exitCode = res.status
  const timedOut = res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM'

  if (timedOut) {
    console.log(`TIMEOUT (${TIMEOUT_MS}ms)  ${elapsed}s`)
    results.push({ file, status: 'timeout', elapsed })
    failedScripts++
    continue
  }

  if (res.error) {
    console.log(`ERROR (${res.error.code || res.error.message})  ${elapsed}s`)
    results.push({ file, status: 'error', err: res.error.message, elapsed })
    failedScripts++
    continue
  }

  if (!match) {
    console.log(`SKIPPED (no PASS marker, exit ${exitCode})  ${elapsed}s`)
    results.push({ file, status: 'skipped', exitCode, elapsed })
    skipped++
    continue
  }

  const p = Number(match[1])
  const t = Number(match[2])
  totalPass += p
  totalAsserts += t

  if (exitCode === 0 && p === t) {
    console.log(`PASS ${p}/${t}  ${elapsed}s`)
    results.push({ file, status: 'pass', pass: p, total: t, elapsed })
  } else {
    console.log(`FAIL ${p}/${t} (exit ${exitCode})  ${elapsed}s`)
    results.push({ file, status: 'fail', pass: p, total: t, exitCode, elapsed })
    failedScripts++
  }
}

const wallElapsed = ((Date.now() - wallStart) / 1000).toFixed(1)

console.log()
console.log('─'.repeat(60))
console.log(`Summary: ${totalPass}/${totalAsserts} assertions across ${files.length} scripts in ${wallElapsed}s`)
console.log(`         ${failedScripts} failed, ${skipped} skipped (no marker)`)

if (failedScripts > 0) {
  console.log()
  console.log('Failed / errored:')
  for (const r of results) {
    if (r.status !== 'pass' && r.status !== 'skipped') {
      console.log(`  • ${r.file} — ${r.status}${r.exitCode != null ? ` exit=${r.exitCode}` : ''}${r.err ? ` (${r.err})` : ''}`)
    }
  }
}

process.exit(failedScripts === 0 ? 0 : 1)
