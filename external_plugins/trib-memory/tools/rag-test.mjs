#!/usr/bin/env node
/**
 * rag-test.mjs — RAG pipeline stage-by-stage test harness
 *
 * Usage:
 *   node rag-test.mjs --query "검색어"
 *   node rag-test.mjs --query "검색어" --expect "키워드1,키워드2"
 *   node rag-test.mjs --query "검색어" --mask 0x070
 *   node rag-test.mjs --sample 5
 *   node rag-test.mjs --batch
 *   node rag-test.mjs --batch --verbose
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { homedir } from 'os'
import { performance } from 'perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'util'

// ── Resolve lib path ──
const LIB = new URL('../lib/', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')

// ── Bitmask stages ──
const STAGES = {
  INGEST:        0x001,
  EMBED:         0x002,
  CLASSIFY:      0x004,
  QUERY_VARIANT: 0x008,
  FTS:           0x010,
  VECTOR_KNN:    0x020,
  RRF_FUSION:    0x040,
  TIME_DECAY:    0x080,
  IMPORTANCE:    0x100,
  MMR:           0x200,
  RERANKER:      0x400,
  ALL:           0x7FF,
}

// ── Built-in test query set ──
const TEST_QUERIES = [
  { query: '프로젝트 구조', expect: ['구조', '디렉토리', 'structure'] },
  { query: 'Discord 채널 모드', expect: ['채널', 'channel', 'discord'] },
  { query: 'RAG 파이프라인', expect: ['RAG', '검색', 'embedding'] },
  { query: '메모리 시스템', expect: ['memory', '메모리', 'recall'] },
  { query: '권한 설정', expect: ['permission', 'access', '권한'] },
  { query: '작업 상태', expect: ['task', '작업', 'status', '상태'] },
  { query: '스케줄 설정', expect: ['schedule', 'cron', '스케줄'] },
  { query: '임베딩 모델', expect: ['embedding', 'bge', 'vector', '임베딩'] },
]

// ── CLI parse ──
const { values: opts } = parseArgs({
  options: {
    query:   { type: 'string', short: 'q' },
    sample:  { type: 'string', short: 's' },
    batch:   { type: 'boolean', short: 'b', default: false },
    mask:    { type: 'string', short: 'm', default: '0x7FF' },
    expect:  { type: 'string', short: 'e' },
    verbose: { type: 'boolean', short: 'v', default: false },
    help:    { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
  allowPositionals: true,
})

if (opts.help) {
  console.log(`
rag-test.mjs — RAG pipeline test harness

Options:
  --query  "검색어"            Single query test
  --sample N                   Sample N recent episodes from DB (ingest test)
  --batch                      Run built-in test query set
  --mask   0x7FF               Bitmask (default: ALL)
  --expect "키워드1,키워드2"    Keywords for MRR evaluation
  --verbose                    Detailed per-stage output
  --help                       Show this message

Stages (bitmask):
  0x001 INGEST        0x002 EMBED         0x004 CLASSIFY
  0x008 QUERY_VARIANT 0x010 FTS           0x020 VECTOR_KNN
  0x040 RRF_FUSION    0x080 TIME_DECAY    0x100 IMPORTANCE
  0x200 MMR           0x400 RERANKER      0x7FF ALL
`)
  process.exit(0)
}

const MASK = Number(opts.mask) || STAGES.ALL
const VERBOSE = opts.verbose

// ── Resolve data directory ──
const PLUGIN_DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || (() => {
  const candidates = [
    join(homedir(), '.claude', 'plugins', 'data', 'trib-memory-trib-plugin'),
    join(homedir(), '.claude', 'plugins', 'data', 'trib-memory-trib-memory'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'memory.sqlite'))) return c
  }
  return candidates[0]
})()

const DB_PATH = join(PLUGIN_DATA_DIR, 'memory.sqlite')

// ── Dynamic imports from lib ──
const libUrl = (f) => pathToFileURL(join(LIB, f)).href
const { getMemoryStore, cleanMemoryText } = await import(libUrl('memory.mjs'))
const { embedText, configureEmbedding, getEmbeddingModelId } = await import(libUrl('embedding-provider.mjs'))
const { generateQueryVariants, buildFtsQuery, getShortTokensForLike, candidateScore, splitMessageIntoCandidateUnits, tokenizeMemoryText } = await import(libUrl('memory-text-utils.mjs'))
const { computeFinalScore, computeImportanceBoost, getTagFactor } = await import(libUrl('memory-score-utils.mjs'))
const { cosineSimilarity, vecToHex } = await import(libUrl('memory-vector-utils.mjs'))
const { mergeMemoryTuning } = await import(libUrl('memory-tuning.mjs'))

// ── Configure embedding from config.json ──
try {
  const mainConfig = JSON.parse(readFileSync(join(PLUGIN_DATA_DIR, 'config.json'), 'utf8'))
  const embeddingConfig = mainConfig?.embedding ?? {}
  if (embeddingConfig.provider || embeddingConfig.ollamaModel) {
    configureEmbedding({
      provider: embeddingConfig.provider,
      ollamaModel: embeddingConfig.ollamaModel,
    })
  }
} catch { /* no config.json, use defaults */ }

// ── Read-only DB access ──
let readDb
try {
  readDb = new DatabaseSync(DB_PATH, { readOnly: true })
  readDb.exec('PRAGMA busy_timeout = 2000;')
} catch (err) {
  console.error(`DB open failed: ${err.message}`)
  console.error(`Path: ${DB_PATH}`)
  process.exit(1)
}

// Load sqlite-vec if available
let sqliteVec = null
let vecEnabled = false
try {
  sqliteVec = await import('sqlite-vec')
  sqliteVec.load(readDb)
  vecEnabled = true
} catch { /* sqlite-vec not available */ }

// ── Helpers ──
function fmt(ms) { return ms < 1 ? '<0.1ms' : `${ms.toFixed(1)}ms` }
function trunc(text, len = 60) {
  const s = String(text ?? '').replace(/\n/g, ' ').trim()
  return s.length > len ? s.slice(0, len) + '...' : s
}
function enabledStages(mask) {
  return Object.entries(STAGES)
    .filter(([k, v]) => k !== 'ALL' && (mask & v))
    .map(([k]) => k)
}
function stageEnabled(stage) { return Boolean(MASK & STAGES[stage]) }

function getDbStats() {
  const episodeCount = readDb.prepare('SELECT COUNT(*) AS cnt FROM episodes').get()?.cnt ?? 0
  const classCount = readDb.prepare('SELECT COUNT(*) AS cnt FROM classifications WHERE status = ?').get('active')?.cnt ?? 0
  const vectorCount = readDb.prepare('SELECT COUNT(*) AS cnt FROM memory_vectors').get()?.cnt ?? 0
  return { episodeCount, classCount, vectorCount }
}

function printHeader(query, stats) {
  const stageNames = enabledStages(MASK)
  console.log()
  console.log('='.repeat(50))
  console.log('  RAG Pipeline Test')
  console.log('='.repeat(50))
  console.log(`Query: "${query}"`)
  console.log(`Mask: 0x${MASK.toString(16).toUpperCase()} (${stageNames.join(', ')})`)
  console.log(`DB: memory.sqlite (${stats.episodeCount.toLocaleString()} episodes, ${stats.classCount.toLocaleString()} classifications, ${stats.vectorCount.toLocaleString()} vectors)`)
  console.log(`Model: ${getEmbeddingModelId()}`)
  console.log()
}

// ── Stage runners ──

async function stageQueryVariant(query) {
  if (!stageEnabled('QUERY_VARIANT')) return { variants: [query], skipped: true }
  const t0 = performance.now()
  const variants = generateQueryVariants(query)
  const elapsed = performance.now() - t0
  if (VERBOSE) {
    console.log(`[STAGE: QUERY_VARIANT] ${variants.length} variants | ${fmt(elapsed)}`)
    for (const v of variants) console.log(`  -> "${trunc(v, 80)}"`)
    console.log()
  }
  return { variants, elapsed }
}

function stageFts(variants) {
  if (!stageEnabled('FTS')) return { results: [], skipped: true }
  const t0 = performance.now()
  const seen = new Set()
  const results = []

  for (const q of variants) {
    const ftsQuery = buildFtsQuery(q)
    const shortTokens = getShortTokensForLike(q)
    if (!ftsQuery && shortTokens.length === 0) continue

    if (ftsQuery) {
      try {
        const classHits = readDb.prepare(`
          SELECT 'classification' AS type, c.classification AS subtype, c.id AS entity_id,
                 trim(c.element || ' | ' || c.topic || CASE WHEN c.importance IS NOT NULL AND c.importance != '' THEN ' | ' || c.importance ELSE '' END || CASE WHEN c.state IS NOT NULL AND c.state != '' THEN ' | ' || c.state ELSE '' END) AS content,
                 bm25(classifications_fts) AS score, c.updated_at, c.confidence AS quality_score,
                 c.importance, c.retrieval_count, e.ts AS source_ts
          FROM classifications_fts
          JOIN classifications c ON c.id = classifications_fts.rowid
          LEFT JOIN episodes e ON e.id = c.episode_id
          WHERE classifications_fts MATCH ? AND c.status = 'active'
          ORDER BY score LIMIT 20
        `).all(ftsQuery)
        for (const r of classHits) {
          const key = `classification:${r.entity_id}`
          if (!seen.has(key)) { seen.add(key); results.push(r) }
        }
      } catch {}

      try {
        const episodeHits = readDb.prepare(`
          SELECT 'episode' AS type, e.role AS subtype, e.id AS entity_id, e.content,
                 bm25(episodes_fts) AS score, e.created_at AS updated_at, 0 AS retrieval_count,
                 e.ts AS source_ts
          FROM episodes_fts
          JOIN episodes e ON e.id = episodes_fts.rowid
          WHERE episodes_fts MATCH ?
            AND e.kind IN ('message', 'turn')
            AND LENGTH(e.content) >= 10
          ORDER BY score LIMIT 12
        `).all(ftsQuery)
        for (const r of episodeHits) {
          const key = `episode:${r.entity_id}`
          if (!seen.has(key)) { seen.add(key); results.push(r) }
        }
      } catch {}
    }

    // Short-token LIKE supplement
    if (shortTokens.length > 0) {
      try {
        const likeHits = readDb.prepare(`
          SELECT 'classification' AS type, c.classification AS subtype, c.id AS entity_id,
                 trim(c.element || ' | ' || c.topic) AS content,
                 0 AS score, c.updated_at, c.confidence AS quality_score,
                 c.importance, c.retrieval_count, e.ts AS source_ts
          FROM classifications c
          LEFT JOIN episodes e ON e.id = c.episode_id
          WHERE c.status = 'active'
            AND (${shortTokens.map(() => '(c.classification LIKE ? OR c.topic LIKE ? OR c.element LIKE ?)').join(' OR ')})
          LIMIT 8
        `).all(...shortTokens.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`]))
        for (const r of likeHits) {
          const key = `classification:${r.entity_id}`
          if (!seen.has(key)) { seen.add(key); results.push(r) }
        }
      } catch {}
    }
  }

  const elapsed = performance.now() - t0
  if (VERBOSE) {
    console.log(`[STAGE: FTS] ${results.length} results | ${fmt(elapsed)}`)
    for (let i = 0; i < Math.min(results.length, 5); i++) {
      const r = results[i]
      console.log(`  #${i + 1} score=${Number(r.score).toFixed(2)} [${r.type}] "${trunc(r.content)}"`)
    }
    if (results.length > 5) console.log(`  ... (${results.length - 5} more)`)
    console.log()
  }
  return { results, elapsed }
}

async function stageVectorKnn(query, queryVector) {
  if (!stageEnabled('VECTOR_KNN')) return { results: [], skipped: true }
  const t0 = performance.now()
  const vector = queryVector ?? await embedText(query)
  if (!Array.isArray(vector) || vector.length === 0) {
    const elapsed = performance.now() - t0
    if (VERBOSE) console.log(`[STAGE: VECTOR_KNN] no embedding available | ${fmt(elapsed)}\n`)
    return { results: [], elapsed }
  }

  const model = getEmbeddingModelId()
  const results = []

  if (vecEnabled) {
    try {
      const hex = vecToHex(vector)
      const knnRows = readDb.prepare(
        `SELECT rowid, distance FROM vec_memory WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT 24`
      ).all()

      const typeMap = { 1: 'fact', 2: 'task', 3: 'signal', 4: 'episode', 5: 'proposition', 6: 'entity', 7: 'relation', 8: 'classification' }
      for (const knn of knnRows) {
        const typeNum = Math.floor(knn.rowid / 100000000)
        const entityType = typeMap[typeNum] ?? 'unknown'
        const entityId = knn.rowid % 100000000
        if (entityType !== 'classification' && entityType !== 'episode') continue

        const similarity = 1 - knn.distance
        let meta = null
        if (entityType === 'classification') {
          meta = readDb.prepare(`
            SELECT 'classification' AS type, c.classification AS subtype, c.id AS entity_id,
                   trim(c.element || ' | ' || c.topic || CASE WHEN c.importance IS NOT NULL AND c.importance != '' THEN ' | ' || c.importance ELSE '' END) AS content,
                   c.updated_at, c.confidence AS quality_score, c.importance, c.retrieval_count,
                   e.ts AS source_ts, mv.vector_json
            FROM classifications c
            JOIN memory_vectors mv ON mv.entity_type = 'classification' AND mv.entity_id = c.id AND mv.model = ?
            LEFT JOIN episodes e ON e.id = c.episode_id
            WHERE c.id = ? AND c.status = 'active'
          `).get(model, entityId)
        } else {
          meta = readDb.prepare(`
            SELECT 'episode' AS type, e.role AS subtype, e.id AS entity_id, e.content,
                   e.created_at AS updated_at, 0 AS retrieval_count, e.ts AS source_ts, mv.vector_json
            FROM episodes e
            JOIN memory_vectors mv ON mv.entity_type = 'episode' AND mv.entity_id = e.id AND mv.model = ?
            WHERE e.id = ? AND e.kind IN ('message', 'turn')
          `).get(model, entityId)
        }
        if (meta) results.push({ ...meta, score: -similarity, similarity })
      }
    } catch {}
  } else {
    // Fallback: JS cosine scan
    try {
      const rows = [
        ...readDb.prepare(`
          SELECT 'classification' AS type, c.classification AS subtype, c.id AS entity_id,
                 trim(c.element || ' | ' || c.topic) AS content,
                 c.updated_at, c.confidence AS quality_score, c.importance, c.retrieval_count,
                 e.ts AS source_ts, mv.vector_json
          FROM memory_vectors mv
          JOIN classifications c ON c.id = mv.entity_id
          LEFT JOIN episodes e ON e.id = c.episode_id
          WHERE mv.entity_type = 'classification' AND mv.model = ? AND c.status = 'active'
        `).all(model),
        ...readDb.prepare(`
          SELECT 'episode' AS type, e.role AS subtype, e.id AS entity_id, e.content,
                 e.created_at AS updated_at, 0 AS retrieval_count, e.ts AS source_ts, mv.vector_json
          FROM memory_vectors mv
          JOIN episodes e ON e.id = mv.entity_id
          WHERE mv.entity_type = 'episode' AND mv.model = ? AND e.kind IN ('message', 'turn')
        `).all(model),
      ]
      for (const row of rows) {
        try {
          const rv = JSON.parse(row.vector_json)
          const similarity = cosineSimilarity(vector, rv)
          results.push({ ...row, score: -similarity, similarity, vector_json: undefined })
        } catch {}
      }
      results.sort((a, b) => b.similarity - a.similarity)
      results.splice(24)
    } catch {}
  }

  const elapsed = performance.now() - t0
  if (VERBOSE) {
    console.log(`[STAGE: VECTOR_KNN] ${results.length} results | ${fmt(elapsed)}`)
    for (let i = 0; i < Math.min(results.length, 5); i++) {
      const r = results[i]
      console.log(`  #${i + 1} sim=${(r.similarity ?? 0).toFixed(3)} [${r.type}] "${trunc(r.content)}"`)
    }
    if (results.length > 5) console.log(`  ... (${results.length - 5} more)`)
    console.log()
  }
  return { results, elapsed, queryVector: vector }
}

function stageRrfFusion(ftsResults, vecResults) {
  if (!stageEnabled('RRF_FUSION')) {
    const passthrough = [...ftsResults, ...vecResults]
    return { results: passthrough, skipped: true }
  }
  const t0 = performance.now()
  const K = 60

  const sparseRanks = new Map()
  const denseRanks = new Map()
  ftsResults.forEach((item, i) => {
    const key = `${item.type}:${item.entity_id}`
    if (!sparseRanks.has(key)) sparseRanks.set(key, i + 1)
  })
  vecResults.forEach((item, i) => {
    const key = `${item.type}:${item.entity_id}`
    if (!denseRanks.has(key)) denseRanks.set(key, i + 1)
  })

  const seen = new Map()
  for (const item of [...ftsResults, ...vecResults]) {
    const key = `${item.type}:${item.entity_id}`
    if (seen.has(key)) {
      if (item.vector_json && !seen.get(key).vector_json) {
        seen.get(key).vector_json = item.vector_json
      }
      continue
    }
    const sparseRank = sparseRanks.get(key)
    const denseRank = denseRanks.get(key)
    const rrfSparse = sparseRank ? 1 / (K + sparseRank) : 0
    const rrfDense = denseRank ? 1 / (K + denseRank) : 0
    const baseScore = rrfSparse + rrfDense
    seen.set(key, { ...item, keyword_score: rrfSparse, embedding_score: rrfDense, base_score: baseScore })
  }

  const results = [...seen.values()].sort((a, b) => b.base_score - a.base_score)
  const dedupedCount = (ftsResults.length + vecResults.length) - results.length
  const elapsed = performance.now() - t0

  if (VERBOSE) {
    console.log(`[STAGE: RRF_FUSION] ${ftsResults.length + vecResults.length}->${results.length} results (${dedupedCount} deduped) | ${fmt(elapsed)}`)
    for (let i = 0; i < Math.min(results.length, 5); i++) {
      const r = results[i]
      console.log(`  #${i + 1} rrf=${r.base_score.toFixed(4)} (sparse=${r.keyword_score.toFixed(4)} dense=${r.embedding_score.toFixed(4)}) [${r.type}] "${trunc(r.content)}"`)
    }
    console.log()
  }
  return { results, elapsed, dedupedCount }
}

function stageTimeDecay(items, query) {
  if (!stageEnabled('TIME_DECAY')) return { results: items, skipped: true }
  const t0 = performance.now()
  const results = items.map(item => {
    let timeFactor = 1.0
    const ts = item.source_ts || item.ts
    if (ts) {
      const ageDays = Math.max(0, (Date.now() - new Date(ts).getTime()) / 86400000)
      const decay = 1 / Math.pow(1 + ageDays / 30, 0.3)
      const tagFactor = getTagFactor(item.importance)
      const actualLoss = (1 - decay) * tagFactor
      timeFactor = 1 - actualLoss
      return { ...item, pre_decay_score: item.base_score, base_score: item.base_score * timeFactor, ageDays, timeFactor }
    }
    return { ...item, pre_decay_score: item.base_score, ageDays: 0, timeFactor: 1.0 }
  })
  results.sort((a, b) => b.base_score - a.base_score)
  const elapsed = performance.now() - t0

  if (VERBOSE) {
    console.log(`[STAGE: TIME_DECAY] applied | ${fmt(elapsed)}`)
    for (let i = 0; i < Math.min(results.length, 5); i++) {
      const r = results[i]
      const ageDays = r.ageDays ?? 0
      const ageStr = ageDays < 1 ? '<1d' : `${Math.round(ageDays)}d`
      console.log(`  #${i + 1} ${(r.pre_decay_score ?? 0).toFixed(4)}->${r.base_score.toFixed(4)} (age: ${ageStr})`)
    }
    console.log()
  }
  return { results, elapsed }
}

function stageImportance(items, query) {
  if (!stageEnabled('IMPORTANCE')) return { results: items, skipped: true }
  const t0 = performance.now()
  const results = items.map(item => {
    const boost = computeImportanceBoost(item.importance)
    const newScore = item.base_score * boost
    return { ...item, pre_importance_score: item.base_score, base_score: newScore, importanceBoost: boost }
  })
  results.sort((a, b) => b.base_score - a.base_score)
  const elapsed = performance.now() - t0

  if (VERBOSE) {
    console.log(`[STAGE: IMPORTANCE] applied | ${fmt(elapsed)}`)
    for (let i = 0; i < Math.min(results.length, 5); i++) {
      const r = results[i]
      const imp = r.importance || '-'
      console.log(`  #${i + 1} ${(r.pre_importance_score ?? 0).toFixed(4)}->${r.base_score.toFixed(4)} (${imp}, boost=${r.importanceBoost.toFixed(2)})`)
    }
    console.log()
  }
  return { results, elapsed }
}

function stageMMR(items, lambda = 0.7) {
  if (!stageEnabled('MMR')) return { results: items, skipped: true }
  const t0 = performance.now()
  if (items.length <= 1) {
    const elapsed = performance.now() - t0
    if (VERBOSE) console.log(`[STAGE: MMR] ${items.length} results (no filtering needed) | ${fmt(elapsed)}\n`)
    return { results: items, elapsed, filtered: 0 }
  }

  const selected = [items[0]]
  const remaining = items.slice(1)

  while (selected.length < items.length && remaining.length > 0) {
    let bestIdx = -1
    let bestScore = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      const maxSim = Math.max(...selected.map(s => {
        const a = String(s.content || '').toLowerCase()
        const b = String(candidate.content || '').toLowerCase()
        if (!a || !b) return 0
        const wordsA = new Set(a.split(/\s+/))
        const wordsB = new Set(b.split(/\s+/))
        const intersection = [...wordsA].filter(w => wordsB.has(w)).length
        const union = new Set([...wordsA, ...wordsB]).size
        return union > 0 ? intersection / union : 0
      }))
      const mmrScore = lambda * (candidate.base_score || 0) - (1 - lambda) * maxSim
      if (mmrScore > bestScore) { bestScore = mmrScore; bestIdx = i }
    }
    if (bestIdx >= 0) selected.push(remaining.splice(bestIdx, 1)[0])
    else break
  }

  const filtered = items.length - selected.length
  const elapsed = performance.now() - t0
  if (VERBOSE) {
    console.log(`[STAGE: MMR] ${items.length}->${selected.length} results (${filtered} filtered) | ${fmt(elapsed)}`)
    for (let i = 0; i < Math.min(selected.length, 5); i++) {
      const r = selected[i]
      console.log(`  #${i + 1} ${r.base_score.toFixed(4)} [${r.type}] "${trunc(r.content)}"`)
    }
    console.log()
  }
  return { results: selected, elapsed, filtered }
}

async function stageReranker(items, query) {
  if (!stageEnabled('RERANKER')) return { results: items, skipped: true }
  const t0 = performance.now()
  let reranked = items
  try {
    const { rerank } = await import(join(LIB, 'reranker.mjs'))
    const top = items.slice(0, 5)
    const rest = items.slice(5)
    const scored = await rerank(query, top, 5)
    if (scored.length > 0) {
      reranked = [...scored.map(s => ({
        ...s,
        pre_rerank_score: s.base_score,
        base_score: s.reranker_score ?? s.base_score,
      })), ...rest]
    }
  } catch (err) {
    if (VERBOSE) console.log(`[STAGE: RERANKER] failed: ${err.message}`)
  }
  const elapsed = performance.now() - t0
  if (VERBOSE) {
    console.log(`[STAGE: RERANKER] reranked | ${fmt(elapsed)}`)
    for (let i = 0; i < Math.min(reranked.length, 5); i++) {
      const r = reranked[i]
      console.log(`  #${i + 1} ${(r.base_score ?? 0).toFixed(4)} [${r.type}] "${trunc(r.content)}"`)
    }
    console.log()
  }
  return { results: reranked, elapsed }
}

// ── Ingest simulation ──
function stageIngest(sampleCount) {
  if (!stageEnabled('INGEST')) return { results: [], skipped: true }
  const t0 = performance.now()
  const episodes = readDb.prepare(`
    SELECT id, ts, day_key, role, content FROM episodes
    WHERE kind IN ('message', 'turn') AND LENGTH(content) >= 10
    ORDER BY ts DESC LIMIT ?
  `).all(sampleCount)

  const candidates = []
  for (const ep of episodes) {
    const units = splitMessageIntoCandidateUnits(ep.content)
    for (const unit of units) {
      const score = candidateScore(unit, ep.role)
      if (score > 0) {
        candidates.push({ episodeId: ep.id, ts: ep.ts, dayKey: ep.day_key, role: ep.role, content: unit, score })
      }
    }
  }
  const elapsed = performance.now() - t0
  if (VERBOSE) {
    console.log(`[STAGE: INGEST] ${episodes.length} episodes -> ${candidates.length} candidates | ${fmt(elapsed)}`)
    for (let i = 0; i < Math.min(candidates.length, 5); i++) {
      const c = candidates[i]
      console.log(`  #${i + 1} score=${c.score.toFixed(3)} [${c.role}] "${trunc(c.content)}"`)
    }
    if (candidates.length > 5) console.log(`  ... (${candidates.length - 5} more)`)
    console.log()
  }
  return { results: candidates, elapsed }
}

async function stageEmbed(text) {
  if (!stageEnabled('EMBED')) return { vector: null, skipped: true }
  const t0 = performance.now()
  const vector = await embedText(text)
  const elapsed = performance.now() - t0
  const dims = vector?.length ?? 0
  if (VERBOSE) {
    console.log(`[STAGE: EMBED] ${dims} dims | ${fmt(elapsed)}`)
    if (dims > 0) {
      const preview = vector.slice(0, 4).map(v => v.toFixed(4)).join(', ')
      console.log(`  -> [${preview}, ...]`)
    }
    console.log()
  }
  return { vector, elapsed, dims }
}

// ── Metrics ──
function computeMetrics(results, expectKeywords) {
  if (!expectKeywords || expectKeywords.length === 0) return null
  const lowerExpect = expectKeywords.map(k => k.toLowerCase())

  const hitAt = (rank) => {
    const items = results.slice(0, rank)
    return items.some(r => {
      const content = String(r.content || '').toLowerCase()
      return lowerExpect.some(k => content.includes(k))
    })
  }

  const top5Hits = results.slice(0, 5).filter(r => {
    const content = String(r.content || '').toLowerCase()
    return lowerExpect.some(k => content.includes(k))
  }).length

  // MRR: reciprocal rank of first hit
  let mrr = 0
  for (let i = 0; i < results.length; i++) {
    const content = String(results[i].content || '').toLowerCase()
    if (lowerExpect.some(k => content.includes(k))) {
      mrr = 1 / (i + 1)
      break
    }
  }

  return {
    top1Hit: hitAt(1),
    top5Hits,
    top5Total: Math.min(5, results.length),
    mrr,
  }
}

// ── Single query pipeline ──
async function runPipeline(query, expectKeywords = []) {
  const stats = getDbStats()
  const stageTimes = {}
  const totalT0 = performance.now()

  if (VERBOSE) printHeader(query, stats)

  // INGEST stage is only for --sample mode, skip here
  // EMBED
  const embedResult = await stageEmbed(query)
  if (embedResult.elapsed) stageTimes.EMBED = embedResult.elapsed

  // QUERY_VARIANT
  const variantResult = await stageQueryVariant(query)
  if (variantResult.elapsed) stageTimes.QUERY_VARIANT = variantResult.elapsed
  const variants = variantResult.variants

  // FTS
  const ftsResult = stageFts(variants)
  if (ftsResult.elapsed) stageTimes.FTS = ftsResult.elapsed

  // VECTOR_KNN
  const vecResult = await stageVectorKnn(query, embedResult.vector)
  if (vecResult.elapsed) stageTimes.VECTOR_KNN = vecResult.elapsed

  // RRF_FUSION
  const rrfResult = stageRrfFusion(ftsResult.results, vecResult.results)
  if (rrfResult.elapsed) stageTimes.RRF_FUSION = rrfResult.elapsed

  // TIME_DECAY
  const decayResult = stageTimeDecay(rrfResult.results, query)
  if (decayResult.elapsed) stageTimes.TIME_DECAY = decayResult.elapsed

  // IMPORTANCE
  const importanceResult = stageImportance(decayResult.results, query)
  if (importanceResult.elapsed) stageTimes.IMPORTANCE = importanceResult.elapsed

  // MMR
  const mmrResult = stageMMR(importanceResult.results.slice(0, 12))
  if (mmrResult.elapsed) stageTimes.MMR = mmrResult.elapsed

  // RERANKER
  const rerankerResult = await stageReranker(mmrResult.results, query)
  if (rerankerResult.elapsed) stageTimes.RERANKER = rerankerResult.elapsed

  const finalResults = rerankerResult.results
  const totalElapsed = performance.now() - totalT0
  const activeStageCount = Object.keys(stageTimes).length
  const totalStageCount = Object.keys(STAGES).length - 1 // exclude ALL

  // Bottleneck
  let bottleneck = { stage: '-', time: 0, pct: 0 }
  for (const [stage, time] of Object.entries(stageTimes)) {
    if (time > bottleneck.time) {
      bottleneck = { stage, time, pct: totalElapsed > 0 ? (time / totalElapsed) * 100 : 0 }
    }
  }

  // Metrics
  const metrics = computeMetrics(finalResults, expectKeywords)

  if (VERBOSE) {
    console.log('='.repeat(50))
    console.log('  BENCH SUMMARY')
    console.log('='.repeat(50))
    console.log(`Total: ${fmt(totalElapsed)} | Stages: ${activeStageCount}/${totalStageCount}`)
    console.log(`Bottleneck: ${bottleneck.stage} (${fmt(bottleneck.time)}, ${bottleneck.pct.toFixed(1)}%)`)
    console.log(`Results: ${finalResults.length} final`)
    console.log()

    if (metrics) {
      console.log('='.repeat(50))
      console.log('  METRICS')
      console.log('='.repeat(50))
      console.log(`Top-1 Hit: ${metrics.top1Hit ? 'Y' : 'N'} (expect: ${expectKeywords.join(', ')})`)
      console.log(`Top-5 Hit: ${metrics.top5Hits}/${metrics.top5Total} (${Math.round(metrics.top5Hits / metrics.top5Total * 100)}%)`)
      console.log(`MRR: ${metrics.mrr.toFixed(3)}`)
      console.log()
    }

    // Final results listing
    if (finalResults.length > 0) {
      console.log('='.repeat(50))
      console.log('  FINAL RESULTS')
      console.log('='.repeat(50))
      for (let i = 0; i < finalResults.length; i++) {
        const r = finalResults[i]
        console.log(`  #${i + 1} score=${(r.base_score ?? 0).toFixed(4)} [${r.type}/${r.subtype ?? '-'}] "${trunc(r.content, 70)}"`)
      }
      console.log()
    }
  } else {
    // Non-verbose: compact output
    console.log()
    console.log(`Query: "${trunc(query, 50)}" | ${fmt(totalElapsed)} | ${finalResults.length} results`)
    if (metrics) {
      console.log(`  Top-1: ${metrics.top1Hit ? 'Y' : 'N'} | Top-5: ${metrics.top5Hits}/${metrics.top5Total} | MRR: ${metrics.mrr.toFixed(3)}`)
    }
    for (let i = 0; i < Math.min(finalResults.length, 3); i++) {
      const r = finalResults[i]
      console.log(`  #${i + 1} [${r.type}] "${trunc(r.content, 60)}"`)
    }
  }

  return { results: finalResults, metrics, totalElapsed, stageTimes, bottleneck }
}

// ── Batch mode ──
async function runBatch() {
  const stats = getDbStats()
  console.log()
  console.log('='.repeat(60))
  console.log('  RAG Pipeline Batch Test')
  console.log('='.repeat(60))
  console.log(`DB: memory.sqlite (${stats.episodeCount.toLocaleString()} episodes, ${stats.classCount.toLocaleString()} classifications)`)
  console.log(`Mask: 0x${MASK.toString(16).toUpperCase()} (${enabledStages(MASK).join(', ')})`)
  console.log(`Model: ${getEmbeddingModelId()}`)
  console.log()

  const rows = []
  for (const tc of TEST_QUERIES) {
    try {
      const result = await runPipeline(tc.query, tc.expect)
      rows.push({
        query: tc.query,
        top1: result.metrics?.top1Hit ?? false,
        top5Hits: result.metrics?.top5Hits ?? 0,
        top5Total: result.metrics?.top5Total ?? 0,
        mrr: result.metrics?.mrr ?? 0,
        time: result.totalElapsed,
        resultCount: result.results.length,
      })
    } catch (err) {
      rows.push({
        query: tc.query,
        top1: false, top5Hits: 0, top5Total: 0, mrr: 0, time: 0, resultCount: 0,
        error: err.message,
      })
    }
  }

  // Print table
  console.log()
  console.log('='.repeat(60))
  console.log('  BATCH RESULTS')
  console.log('='.repeat(60))
  const hdr = '| Query                      | Top-1 | Top-5 | MRR  | Time    | #   |'
  const sep = '|----------------------------|-------|-------|------|---------|-----|'
  console.log(hdr)
  console.log(sep)
  for (const r of rows) {
    const q = r.query.padEnd(26).slice(0, 26)
    const t1 = r.top1 ? '  Y  ' : '  N  '
    const t5 = `${r.top5Hits}/${r.top5Total}`.padStart(3).padEnd(5)
    const mrr = r.mrr.toFixed(2).padStart(4)
    const time = fmt(r.time).padStart(7)
    const cnt = String(r.resultCount).padStart(3)
    console.log(`| ${q} | ${t1} | ${t5} | ${mrr} | ${time} | ${cnt} |`)
  }
  console.log(sep)

  // Aggregates
  const validRows = rows.filter(r => !r.error)
  if (validRows.length > 0) {
    const avgMrr = validRows.reduce((s, r) => s + r.mrr, 0) / validRows.length
    const avgTop5 = validRows.reduce((s, r) => s + (r.top5Total > 0 ? r.top5Hits / r.top5Total : 0), 0) / validRows.length
    const avgTime = validRows.reduce((s, r) => s + r.time, 0) / validRows.length
    console.log()
    console.log(`Avg MRR: ${avgMrr.toFixed(2)}`)
    console.log(`Avg Top-5: ${(avgTop5 * 100).toFixed(0)}%`)
    console.log(`Avg Time: ${fmt(avgTime)}`)
  }
  console.log()
}

// ── Sample mode ──
async function runSample(n) {
  const stats = getDbStats()
  console.log()
  console.log('='.repeat(50))
  console.log('  RAG Ingest Simulation')
  console.log('='.repeat(50))
  console.log(`DB: memory.sqlite (${stats.episodeCount.toLocaleString()} episodes)`)
  console.log(`Sample: ${n} recent episodes`)
  console.log()

  const ingestResult = stageIngest(n)

  if (stageEnabled('CLASSIFY') && VERBOSE) {
    console.log(`[STAGE: CLASSIFY] (simulation — read existing classifications for sampled episodes)`)
    const episodeIds = ingestResult.results.map(c => c.episodeId)
    const uniqueEpIds = [...new Set(episodeIds)]
    let classCount = 0
    for (const epId of uniqueEpIds.slice(0, 20)) {
      const cls = readDb.prepare(`
        SELECT classification, topic, element, importance FROM classifications WHERE episode_id = ? AND status = 'active'
      `).get(epId)
      if (cls) {
        classCount++
        if (VERBOSE) {
          console.log(`  ep#${epId}: ${cls.classification}/${cls.topic} "${trunc(cls.element)}" [${cls.importance || '-'}]`)
        }
      }
    }
    console.log(`  ${classCount}/${uniqueEpIds.length} episodes have classifications`)
    console.log()
  }

  console.log('Done.')
  console.log()
}

// ── Main ──
async function main() {
  try {
    if (opts.batch) {
      await runBatch()
    } else if (opts.sample) {
      await runSample(Number(opts.sample) || 5)
    } else if (opts.query) {
      const expectKeywords = opts.expect ? opts.expect.split(',').map(s => s.trim()).filter(Boolean) : []
      await runPipeline(opts.query, expectKeywords)
    } else {
      console.error('Usage: rag-test.mjs --query "..." | --batch | --sample N')
      console.error('Run with --help for details.')
      process.exit(1)
    }
  } finally {
    try { readDb?.close() } catch {}
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`)
  process.exit(1)
})
