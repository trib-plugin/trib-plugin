#!/usr/bin/env node

import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { crossEncoderRerank, resetRerankerState } from '../lib/reranker.mjs'

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
    if (args[key] === undefined) {
      args[key] = next
    } else if (Array.isArray(args[key])) {
      args[key].push(next)
    } else {
      args[key] = [args[key], next]
    }
    i += 1
  }
  return args
}

function toArray(value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function loadPairs(filePath) {
  const raw = readFileSync(resolve(String(filePath)), 'utf8').trim()
  if (!raw) return []
  const parsed = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => JSON.parse(line))
  return parsed
    .map((item, index) => ({
      id: String(item.id ?? `pair-${index + 1}`),
      query: String(item.query ?? '').trim(),
      candidates: Array.isArray(item.candidates)
        ? item.candidates.map((candidate, candidateIndex) => ({
            entity_id: candidate.entity_id ?? candidateIndex + 1,
            content: String(candidate.content ?? candidate.text ?? '').trim(),
          })).filter(candidate => candidate.content)
        : [],
    }))
    .filter(item => item.query && item.candidates.length > 0)
}

function average(values) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function formatMs(value) {
  return `${Number(value).toFixed(1)}ms`
}

const args = parseArgs(process.argv.slice(2))
const models = toArray(args.models).length > 0
  ? toArray(args.models)
  : ['Xenova/bge-reranker-large']
const pairsFile = args.pairs_file
  || resolve(import.meta.dirname, 'benchmarks', 'reranker-latency-sample.jsonl')
const iterations = Math.max(1, Number(args.iterations ?? 3))
const warmIterations = Math.max(1, Number(args.warm_iterations ?? iterations))
const pairs = loadPairs(pairsFile)

if (pairs.length === 0) {
  process.stderr.write('measure-reranker-latency: no pairs found\n')
  process.exit(1)
}

const rows = []

for (const modelId of models) {
  process.env.TRIB_MEMORY_RERANKER_MODEL_ID = String(modelId)
  resetRerankerState()

  const coldTimes = []
  const warmTimes = []
  const candidateCounts = []

  for (const pair of pairs) {
    candidateCounts.push(pair.candidates.length)

    resetRerankerState()
    const coldStarted = performance.now()
    await crossEncoderRerank(pair.query, pair.candidates, { limit: pair.candidates.length })
    coldTimes.push(performance.now() - coldStarted)

    const warmRunTimes = []
    for (let index = 0; index < warmIterations; index += 1) {
      const warmStarted = performance.now()
      await crossEncoderRerank(pair.query, pair.candidates, { limit: pair.candidates.length })
      warmRunTimes.push(performance.now() - warmStarted)
    }
    warmTimes.push(average(warmRunTimes))
  }

  rows.push({
    model: modelId,
    pairs: pairs.length,
    avg_candidates: average(candidateCounts),
    cold_avg_ms: average(coldTimes),
    cold_max_ms: Math.max(...coldTimes),
    warm_avg_ms: average(warmTimes),
    warm_max_ms: Math.max(...warmTimes),
  })
}

if (String(args.format ?? 'compact').toLowerCase() === 'json') {
  process.stdout.write(`${JSON.stringify({ pairs_file: pairsFile, pairs: pairs.length, rows }, null, 2)}\n`)
  process.exit(0)
}

for (const row of rows) {
  process.stdout.write(
    `${row.model}\n` +
    `  pairs=${row.pairs} avg_candidates=${row.avg_candidates.toFixed(1)}\n` +
    `  cold_avg=${formatMs(row.cold_avg_ms)} cold_max=${formatMs(row.cold_max_ms)}\n` +
    `  warm_avg=${formatMs(row.warm_avg_ms)} warm_max=${formatMs(row.warm_max_ms)}\n`,
  )
}
