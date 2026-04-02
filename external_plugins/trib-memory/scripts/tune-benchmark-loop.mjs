#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getMemoryStore } from '../lib/memory.mjs'
import {
  configureBenchmarkEmbedding,
  prepareBenchmarkStore,
  prepareWritableDataDir as prepareRuntimeDataDir,
  resolveDataDir,
} from './lib/benchmark-runtime.mjs'
import { loadCases, runBenchmarkCases } from './lib/benchmark-core.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function listFilesRecursive(root, results = []) {
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === 'results') continue
      listFilesRecursive(full, results)
    } else {
      results.push(full)
    }
  }
  return results
}

function hashFiles(paths) {
  const hash = createHash('sha1')
  for (const file of paths.sort()) {
    hash.update(file)
    hash.update(readFileSync(file))
  }
  return hash.digest('hex')
}

function formatPercent(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`
}

function metricTuple(summary) {
  const final = summary?.final ?? {}
  const candidate = summary?.candidates ?? {}
  return [
    Number(final.hit_at_1 ?? 0),
    Number(final.mrr ?? 0),
    Number(candidate.hit_at_1 ?? 0),
    Number(candidate.hit_at_k ?? 0),
  ]
}

function compareTuple(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = Number(left[i] ?? 0)
    const b = Number(right[i] ?? 0)
    if (a > b) return 1
    if (a < b) return -1
  }
  return 0
}

function prepareWritableDataDir(sourceDir, iteration) {
  return prepareRuntimeDataDir(sourceDir, {
    refresh: true,
    suffix: `loop-${process.pid}-${iteration}`,
  })
}

const args = parseArgs(process.argv.slice(2))
const dataDir = resolveDataDir(args.data_dir)
const benchmarkDir = resolve(__dirname, 'benchmarks')
const caseFiles = toArray(args.case_files).length > 0
  ? toArray(args.case_files).map(value => resolve(String(value)))
  : [
      join(benchmarkDir, 'tribgames-merged-cases.jsonl'),
      join(benchmarkDir, 'tribgames-extended-cases.jsonl'),
      join(benchmarkDir, 'tribgames-2026-03-31-cases.jsonl'),
    ]
const maxIterations = Math.max(1, Number(args.max_iterations ?? 20))
const patience = Math.max(1, Number(args.patience ?? 4))
const topK = Math.max(1, Number(args.top_k ?? 3))
const waitMs = Math.max(0, Number(args.wait_ms ?? 0))
const saveFull = Boolean(args.save_full)
const resultsRoot = resolve(__dirname, 'results')
mkdirSync(resultsRoot, { recursive: true })
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = join(resultsRoot, `tune-loop-${runId}`)
mkdirSync(runDir, { recursive: true })

const watchedFiles = [
  ...listFilesRecursive(resolve(__dirname, '../lib')),
  ...listFilesRecursive(resolve(__dirname, '../services')),
  ...listFilesRecursive(resolve(__dirname, 'benchmarks')),
].filter(file => /\.(mjs|md|jsonl|py)$/i.test(file))

let best = null
let noImprovement = 0
const lines = []

for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
  const sourceHash = hashFiles(watchedFiles)
  lines.push(`iteration=${iteration} source_hash=${sourceHash}`)
  const iterationDataDir = prepareWritableDataDir(dataDir, iteration)
  lines.push(`  data_dir=${iterationDataDir}`)
  configureBenchmarkEmbedding(false)
  const store = getMemoryStore(iterationDataDir)
  await prepareBenchmarkStore(store, 'tune_loop_prepare_dense')
  const suite = []
  for (const caseFile of caseFiles) {
    const label = relative(benchmarkDir, caseFile)
    const cases = loadCases(caseFile)
    const parsed = await runBenchmarkCases(store, cases, {
      topK,
      includeCases: saveFull,
      includeTop: saveFull,
    })
    suite.push({ label, parsed })
    writeFileSync(
      join(runDir, `iter-${String(iteration).padStart(2, '0')}-${label.replace(/[\\/]/g, '_')}.json`),
      `${JSON.stringify({ source_data_dir: dataDir, data_dir: iterationDataDir, top_k: topK, ...parsed }, null, 2)}\n`,
    )
  }
  try { store.close?.() } catch {}
  try { rmSync(iterationDataDir, { recursive: true, force: true }) } catch {}

  const merged = suite.find(item => item.label === 'tribgames-merged-cases.jsonl') ?? suite[0]
  const mergedSummary = merged.parsed.summary
  const tuple = metricTuple(mergedSummary)
  const summaryLine =
    `  merged final=${formatPercent(mergedSummary.final.hit_at_1)}/${formatPercent(mergedSummary.final.hit_at_k)} ` +
    `candidate=${formatPercent(mergedSummary.candidates.hit_at_1)}/${formatPercent(mergedSummary.candidates.hit_at_k)}`
  lines.push(summaryLine)

  const current = {
    iteration,
    sourceHash,
    tuple,
    suite: suite.map(item => ({
      label: item.label,
      summary: item.parsed.summary,
    })),
  }

  if (!best || compareTuple(tuple, best.tuple) > 0) {
    best = current
    noImprovement = 0
    writeFileSync(join(runDir, 'best-summary.json'), JSON.stringify(best, null, 2))
    lines.push('  status=best')
  } else {
    noImprovement += 1
    lines.push(`  status=no_improvement (${noImprovement}/${patience})`)
  }

  writeFileSync(join(runDir, 'loop.log'), `${lines.join('\n')}\n`)

  if (noImprovement >= patience) {
    lines.push('stopped=patience')
    break
  }
  if (iteration < maxIterations && waitMs > 0) {
    await sleep(waitMs)
  }
}

writeFileSync(join(runDir, 'loop.log'), `${lines.join('\n')}\n`)

const bestLine = best
  ? `best_iteration=${best.iteration} merged_final=${formatPercent(best.suite.find(item => item.label === 'tribgames-merged-cases.jsonl')?.summary?.final?.hit_at_1 ?? 0)} merged_candidate=${formatPercent(best.suite.find(item => item.label === 'tribgames-merged-cases.jsonl')?.summary?.candidates?.hit_at_1 ?? 0)}`
  : 'best_iteration=none'

process.stdout.write(`${bestLine}\nresults_dir=${runDir}\n`)
