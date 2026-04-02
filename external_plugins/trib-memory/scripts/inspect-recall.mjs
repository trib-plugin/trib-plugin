#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { getMemoryStore } from '../lib/memory.mjs'
import {
  buildTemporalOverride,
  configureBenchmarkEmbedding,
  parseTimerange,
  prepareBenchmarkStore,
  prepareWritableDataDir,
  resolveDataDir,
} from './lib/benchmark-runtime.mjs'

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

function loadQueries(args) {
  const directQueries = toArray(args.query).map(value => String(value).trim()).filter(Boolean)
  const inlineQueries = toArray(args.queries)
    .flatMap(value => String(value).split('||'))
    .map(value => value.trim())
    .filter(Boolean)
  const fileQueries = toArray(args.queries_file).flatMap(filePath => {
    const raw = readFileSync(String(filePath), 'utf8')
    return raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
  })
  return [...directQueries, ...inlineQueries, ...fileQueries]
}

function countHints(hints = '') {
  return String(hints)
    .split(/\r?\n/)
    .filter(line => line.startsWith('<hint '))
    .length
}

function compactItemLabel(item) {
  const type = String(item?.type ?? 'unknown')
  const subtype = String(item?.subtype ?? '').trim()
  return subtype ? `${type}/${subtype}` : type
}

function compactItemText(item, maxLen = 72) {
  const content = String(item?.content ?? item?.text ?? '').replace(/\s+/g, ' ').trim()
  if (content.length <= maxLen) return content
  return `${content.slice(0, Math.max(0, maxLen - 3))}...`
}

function renderCompact(records, options = {}) {
  const topN = Math.max(1, Number(options.topN ?? 3))
  const lines = []
  for (const [index, record] of records.entries()) {
    const debug = record.debug ?? {}
    const stages = debug.stages ?? {}
    const plan = stages.plan ?? {}
    const finalItems = Array.isArray(stages.final) ? stages.final : []
    const fallbackResults = Array.isArray(record.results) ? record.results : []
    const topItems = (finalItems.length > 0 ? finalItems : fallbackResults).slice(0, topN)
    const hintCount = countHints(record.hints ?? '')
    const candidateCount = Number(stages.candidates?.sparse_count ?? 0) + Number(stages.candidates?.dense_count ?? 0)
    lines.push(`[#${index + 1}] ${record.query}`)
    lines.push(`stage=${debug.stopped_at ?? record.until_stage ?? 'final'} intent=${plan.intent ?? stages.intent?.primary ?? '-'} retriever=${plan.retriever ?? '-'} candidates=${candidateCount} hints=${hintCount}`)
    if (stages.refinement?.attempted) {
      lines.push(`refine=${stages.refinement.selected ? 'selected' : 'rejected'} ${stages.refinement.from_intent ?? '-'}->${stages.refinement.to_intent ?? '-'}`)
    }
    if (stages.rerank?.attempted) {
      lines.push(`rerank=attempted input=${Array.isArray(stages.rerank.input_top) ? stages.rerank.input_top.length : 0} output=${Array.isArray(stages.rerank.output_top) ? stages.rerank.output_top.length : 0}`)
    }
    if (topItems.length === 0) {
      lines.push('top=(empty)')
    } else {
      for (const [itemIndex, item] of topItems.entries()) {
        const score = item?.rerank_score ?? item?.weighted_score ?? item?.score
        const scoreText = Number.isFinite(Number(score)) ? Number(score).toFixed(3) : '-'
        lines.push(`top${itemIndex + 1} ${compactItemLabel(item)} score=${scoreText} ${compactItemText(item)}`)
      }
    }
    if (index < records.length - 1) lines.push('')
  }
  return lines.join('\n')
}

const args = parseArgs(process.argv.slice(2))
const sourceDataDir = resolveDataDir(args.data_dir)
if (!sourceDataDir) {
  process.stderr.write('inspect-recall: data dir not found\n')
  process.exit(1)
}
const dataDir = prepareWritableDataDir(sourceDataDir, { refresh: Boolean(args.refresh_copy) })
configureBenchmarkEmbedding(Boolean(args.allow_ml_service))

const queries = loadQueries(args)
if (queries.length === 0) {
  process.stderr.write('inspect-recall: --query, --queries, or --queries-file is required\n')
  process.exit(1)
}

const store = getMemoryStore(dataDir)
await prepareBenchmarkStore(store, 'inspect_recall_prepare_dense')
const limit = Math.max(1, Number(args.limit ?? 5))
const { trStart, trEnd } = parseTimerange(args.timerange)
const temporalOverride = buildTemporalOverride(trStart, trEnd)
const metadataFilters = {
  memory_kind: args.memory_kind,
  task_status: args.task_status,
  source_type: args.source_type,
  session_id: args.session_id,
  start_ts: args.start_ts,
  end_ts: args.end_ts,
}
const records = []

for (const query of queries) {
  const output = {
    query,
    source_data_dir: sourceDataDir,
    data_dir: dataDir,
    timerange: args.timerange ?? null,
    temporal: temporalOverride,
    until_stage: args.until_stage ?? 'final',
    filters: metadataFilters,
  }

  if (args.with_hints) {
    output.hints = await store.buildInboundMemoryContext(query, {
      skipLowSignal: true,
      channelId: args.channel_id,
      userId: args.user_id,
      limit,
    })
  }

  const hybrid = await store.searchRelevantHybrid(query, limit * 2, {
    debug: true,
    untilStage: args.until_stage,
    temporal: temporalOverride,
    filters: metadataFilters,
    channelId: args.channel_id,
    userId: args.user_id,
    recordRetrieval: false,
  })

  output.results = hybrid?.results ?? []
  output.debug = hybrid?.debug ?? null
  records.push(output)
}

const format = String(args.format ?? (records.length > 1 ? 'compact' : 'json')).toLowerCase()
if (format === 'compact') {
  process.stdout.write(`${renderCompact(records, { topN: args.top })}\n`)
} else if (records.length === 1) {
  process.stdout.write(`${JSON.stringify(records[0], null, 2)}\n`)
} else {
  process.stdout.write(`${JSON.stringify(records, null, 2)}\n`)
}
