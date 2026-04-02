#!/usr/bin/env node

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadCycle1Cases, runCycle1Benchmark } from './lib/cycle1-core.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2).replace(/-/g, '_')
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
      continue
    }
    args[key] = next
    i += 1
  }
  return args
}

function formatPercent(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`
}

const args = parseArgs(process.argv.slice(2))
if (!args.cases_file) {
  process.stderr.write('cycle1-benchmark: --cases-file is required\n')
  process.exit(1)
}

const cases = loadCycle1Cases(resolve(String(args.cases_file)))
if (cases.length === 0) {
  process.stderr.write('cycle1-benchmark: no cases found\n')
  process.exit(1)
}

const benchmark = await runCycle1Benchmark(cases, {
  timeout: args.timeout ? Number(args.timeout) : undefined,
})

if (String(args.format ?? 'compact').toLowerCase() === 'json') {
  process.stdout.write(`${JSON.stringify(benchmark, null, 2)}\n`)
  process.exit(0)
}

const lines = []
lines.push(`cases=${cases.length}`)
for (const [key, value] of Object.entries(benchmark.summary)) {
  lines.push(`${key.padEnd(10)} hit@1=${formatPercent(value.hit_at_1)} recall=${formatPercent(value.avg_recall)}`)
}
process.stdout.write(`${lines.join('\n')}\n`)
