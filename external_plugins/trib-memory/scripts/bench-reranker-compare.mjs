#!/usr/bin/env node
/**
 * Reranker comparison benchmark
 * Usage: node scripts/bench-reranker-compare.mjs --port 3370 --gap 0.005 --top 5
 */

import { getMemoryStore } from '../lib/memory.mjs'
import { loadCases, runBenchmarkCases } from './lib/benchmark-core.mjs'
import { prepareBenchmarkStore, prepareWritableDataDir, resolveDataDir, configureBenchmarkEmbedding } from './lib/benchmark-runtime.mjs'
import http from 'http'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith('--') && arr[i + 1]) acc.push([arg.slice(2), arr[i + 1]])
    return acc
  }, [])
)

const PORT = Number(args.port ?? 3370)
const GAP = Number(args.gap ?? 0.005)
const TOP = Number(args.top ?? 5)
const LABEL = args.label ?? 'reranker'

const dir = prepareWritableDataDir(resolveDataDir(), {})
configureBenchmarkEmbedding(false)
const store = getMemoryStore(dir)

let rerankCount = 0, skipCount = 0

const origSearch = store.searchRelevantHybrid.bind(store)
store.searchRelevantHybrid = async function (query, limit, options) {
  const results = await origSearch(query, limit, options)
  if (results.length < 2) return results

  const gap = (results[0]?.weighted_score || 0) - (results[1]?.weighted_score || 0)
  if (gap >= GAP) { skipCount++; return results }

  const topN = results.slice(0, TOP)
  const rest = results.slice(TOP)
  const docs = topN.map(r => String(r.content || '').slice(0, 240))
  const body = JSON.stringify({ query, documents: docs, top_k: limit })
  try {
    const reranked = await new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${PORT}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 30000,
      }, (res) => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          const parsed = JSON.parse(data)
          rerankCount++
          const reordered = parsed.results?.map(r => topN[r.index]).filter(Boolean) || topN
          resolve([...reordered, ...rest])
        })
      })
      req.on('error', () => resolve(results))
      req.on('timeout', () => { req.destroy(); resolve(results) })
      req.write(body)
      req.end()
    })
    return reranked
  } catch { return results }
}

await prepareBenchmarkStore(store, `reranker_${LABEL}`)

const cases100 = loadCases('scripts/benchmarks/natural-100-cases.jsonl')
const r100 = await runBenchmarkCases(store, cases100, { limit: 5, topK: 3 })
const stat100 = `hit@1=${(r100.summary.hit_at_1 * 100).toFixed(1)}% hit@3=${(r100.summary.hit_at_k * 100).toFixed(1)}% mrr=${r100.summary.mrr.toFixed(3)}`
const rr100 = rerankCount, sk100 = skipCount

rerankCount = 0; skipCount = 0
const cases80 = loadCases('scripts/benchmarks/natural-80-cases.jsonl')
const r80 = await runBenchmarkCases(store, cases80, { limit: 5, topK: 3 })
const stat80 = `hit@1=${(r80.summary.hit_at_1 * 100).toFixed(1)}% hit@3=${(r80.summary.hit_at_k * 100).toFixed(1)}% mrr=${r80.summary.mrr.toFixed(3)}`

console.log(`[${LABEL}] gap=${GAP} top=${TOP}`)
console.log(`  natural-100: ${stat100} (reranked=${rr100} skipped=${sk100})`)
console.log(`  natural-80:  ${stat80} (reranked=${rerankCount} skipped=${skipCount})`)
