#!/usr/bin/env node
// Suppress experimental warnings (they go to stdout and break MCP stdio)
process.removeAllListeners('warning')
process.on('warning', () => {})
/**
 * memory-service.mjs — MCP server + HTTP hybrid memory service.
 *
 * Single Node.js process providing:
 *   MCP (stdio)  — search_memories, memory_cycle tools for Claude Code
 *   HTTP (tcp)   — /hints, /episode, /health for hooks + internal use
 *
 * Owns the MemoryStore singleton exclusively.
 * Port: 3350-3357 (written to $TMPDIR/trib-memory/memory-port)
 */

import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

// ── CPU throttle: prevent inference from hogging all cores ──
try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
try {
  const { env } = await import('@huggingface/transformers')
  env.backends.onnx.wasm.numThreads = 2
} catch {}
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { getMemoryStore } from '../lib/memory.mjs'
import { configureEmbedding, embedText } from '../lib/embedding-provider.mjs'
import { cosineSimilarity } from '../lib/memory-vector-utils.mjs'
import { startLlmWorker, stopLlmWorker } from '../lib/llm-worker-host.mjs'
import {
  sleepCycle,
  memoryFlush,
  rebuildRecent,
  rebuildClassifications,
  pruneToRecent,
  getCycleStatus,
  runCycle1,
  runCycle3,
  autoFlush,
  readMainConfig,
  parseInterval,
} from '../lib/memory-cycle.mjs'
import { localNow } from '../lib/memory-text-utils.mjs'
import {
  readMemoryOpsPolicy,
  readMemoryFeatureFlags,
  buildStartupBackfillOptions,
  shouldRunCycleCatchUp,
} from '../lib/memory-ops-policy.mjs'

// ── Configuration ────────────────────────────────────────────────────

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || process.argv[2]
  || (() => {
    // Fallback: find plugin data dir by convention
    const candidates = [
      path.join(os.homedir(), '.claude', 'plugins', 'data', 'trib-memory-tribgames'),
    ]
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'memory.sqlite'))) return c
    }
    return null
  })()
if (!DATA_DIR) {
  process.stderr.write('[memory-service] CLAUDE_PLUGIN_DATA not set and no fallback found\n')
  process.exit(1)
}
process.stderr.write(`[memory-service] DATA_DIR=${DATA_DIR}\n`)

const RUNTIME_DIR = path.join(os.tmpdir(), 'trib-memory')
try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }) } catch {}
const PORT_FILE = path.join(RUNTIME_DIR, 'memory-port')
const BASE_PORT = 3350
const MAX_PORT = 3357

// ── Store initialization ─────────────────────────────────────────────

const mainConfig = readMainConfig()
const opsPolicy = readMemoryOpsPolicy(mainConfig)
const featureFlags = readMemoryFeatureFlags(mainConfig)
const embeddingConfig = mainConfig?.embedding
if (embeddingConfig?.provider || embeddingConfig?.ollamaModel || embeddingConfig?.dtype) {
  configureEmbedding({
    provider: embeddingConfig.provider,
    ollamaModel: embeddingConfig.ollamaModel,
    dtype: embeddingConfig.dtype,
  })
}

const store = getMemoryStore(DATA_DIR)
store.syncHistoryFromFiles()
startLlmWorker()

// WORKSPACE_PATH for cycle functions that call backfillProject(ws).
// If the ws path doesn't resolve to a valid project dir, backfillProject
// falls back to backfillAllProjects() which scans all project dirs directly.
// This works on macOS, Windows, and WSL without slug-to-path conversion issues.
const WORKSPACE_PATH = process.env.TRIB_MEMORY_WORKSPACE || process.cwd()

function getPendingCandidateCount() {
  try {
    return store.getPendingCandidateDays(100, 1).reduce((sum, item) => sum + Number(item?.n ?? 0), 0)
  } catch {
    return 0
  }
}

function getPendingEmbedCount() {
  try {
    return Number(store.db.prepare('SELECT COUNT(*) AS n FROM pending_embeds').get()?.n ?? 0)
  } catch {
    return 0
  }
}

const startupBackfill = buildStartupBackfillOptions(opsPolicy, store)
if (startupBackfill) {
  try {
    const n = startupBackfill.scope === 'workspace'
      ? store.backfillProject(WORKSPACE_PATH, startupBackfill)
      : store.backfillAllProjects(startupBackfill)
    if (n > 0) {
      process.stderr.write(
        `[memory-service] startup backfill (${startupBackfill.scope}/${startupBackfill.sinceMs ? 'windowed' : 'all'}): ${n} episodes\n`,
      )
    }
  } catch (e) {
    process.stderr.write(`[memory-service] startup backfill failed: ${e.message}\n`)
  }
}

// Rebuild lock: pauses cycles during manual rebuild
let _rebuildLock = false

// ── Cycle schedulers (last-run based, not wall-clock) ────────────────

const cycle1Config = mainConfig?.cycle1 ?? {}
const cycle1IntervalStr = cycle1Config.interval || '5m'
const cycle1Ms = parseInterval(cycle1IntervalStr)
const cycle2IntervalStr = mainConfig?.cycle2?.interval || '1h'
const cycle2Ms = parseInterval(cycle2IntervalStr)
const cycle3IntervalStr = mainConfig?.cycle3?.interval || '24h'
const cycle3Ms = parseInterval(cycle3IntervalStr)

function getCycleLastRun() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'memory-cycle.json'), 'utf8'))
    return {
      cycle1: state?.cycle1?.lastRunAt ? new Date(state.cycle1.lastRunAt).getTime() : 0,
      cycle2: state?.lastSleepAt ? new Date(state.lastSleepAt).getTime() : 0,
      cycle3: state?.lastCycle3At ? new Date(state.lastCycle3At).getTime() : 0,
    }
  } catch { return { cycle1: 0, cycle2: 0, cycle3: 0 } }
}

async function checkCycles(options = {}) {
  if (_rebuildLock) return
  if (mainConfig?.enabled === false) return
  const startup = options.startup === true
  const now = Date.now()
  const last = getCycleLastRun()
  const pendingCandidates = getPendingCandidateCount()
  const pendingEmbeds = getPendingEmbedCount()
  const cycle1Due = now - last.cycle1 >= cycle1Ms
  const cycle2Due = now - last.cycle2 >= cycle2Ms
  const cycle3Due = now - last.cycle3 >= cycle3Ms

  // cycle1: lastRunAt + interval elapsed
  if (
    startup
      ? shouldRunCycleCatchUp('cycle1', opsPolicy, {
          due: cycle1Due,
          lastRunAt: last.cycle1 || null,
          pendingCandidates,
          pendingEmbeds,
        })
      : cycle1Due
  ) {
    try {
      const result = await runCycle1(WORKSPACE_PATH, mainConfig, { maxItems: 50, maxAgeDays: 1 })
      process.stderr.write(
        `[cycle1] completed at ${localNow()}${startup ? ' [startup-catchup]' : ''} extracted=${Number(result?.extracted ?? 0)} classifications=${Number(result?.classifications ?? 0)}\n`,
      )
    } catch (e) {
      process.stderr.write(`[cycle1] error: ${e.message}\n`)
    }
  }

  // cycle2: interval-based (default 1h)
  if (
    startup
      ? shouldRunCycleCatchUp('cycle2', opsPolicy, {
          due: cycle2Due,
          lastRunAt: last.cycle2 || null,
          pendingCandidates,
        })
      : cycle2Due
  ) {
    try {
      await sleepCycle(WORKSPACE_PATH)
      process.stderr.write(`[cycle2] completed at ${localNow()}${startup ? ' [startup-catchup]' : ''}\n`)
    } catch (e) {
      process.stderr.write(`[cycle2] error: ${e.message}\n`)
    }
  }

  // cycle3: interval-based (default 24h)
  if (cycle3Due) {
    try {
      await runCycle3(WORKSPACE_PATH)
      process.stderr.write(`[cycle3] completed at ${localNow()}\n`)
    } catch (e) {
      process.stderr.write(`[cycle3] error: ${e.message}\n`)
    }
  }

  try {
    const flushResult = await autoFlush(WORKSPACE_PATH)
    if (flushResult?.flushed) {
      process.stderr.write(
        `[cycle1-auto] flushed pending=${Number(flushResult?.candidates ?? 0)} at ${localNow()}\n`,
      )
    }
  } catch (e) {
    process.stderr.write(`[cycle1-auto] error: ${e.message}\n`)
  }
}

// Check every minute, run if due
setInterval(() => { void checkCycles() }, opsPolicy.scheduler.checkIntervalMs)
// Initial check after warmup (catches overdue cycles immediately)
const startupDelayMs = Math.max(
  Number(opsPolicy.startup.cycle1CatchUp.delayMs ?? 0),
  Number(opsPolicy.startup.cycle2CatchUp.delayMs ?? 0),
)
setTimeout(() => { void checkCycles({ startup: true }) }, startupDelayMs)

// ── Server started timestamp (after startup backfill) ────────────────
const serverStartedAt = localNow()

// ── Live transcript watcher: ingest new episodes in real-time ────────
{
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
  const WATCH_INTERVAL_MS = 5_000  // check every 5s
  let watchedFiles = new Map()     // path → mtime

  function discoverActiveTranscripts() {
    try {
      if (!fs.existsSync(projectsRoot)) return []
      const files = []
      for (const d of fs.readdirSync(projectsRoot)) {
        if (d.includes('tmp') || d.includes('cache') || d.includes('plugins')) continue
        const full = path.join(projectsRoot, d)
        try {
          for (const f of fs.readdirSync(full)) {
            if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue
            const fp = path.join(full, f)
            const mtime = fs.statSync(fp).mtimeMs
            files.push({ path: fp, mtime })
          }
        } catch {}
      }
      // Only watch files modified in the last 30 minutes
      const cutoff = Date.now() - 30 * 60_000
      return files.filter(f => f.mtime > cutoff)
    } catch { return [] }
  }

  function watchTick() {
    try {
      const active = discoverActiveTranscripts()
      for (const { path: fp, mtime } of active) {
        const prev = watchedFiles.get(fp)
        if (prev && prev >= mtime) continue
        watchedFiles.set(fp, mtime)
        const n = store.ingestTranscriptFile(fp)
        if (n > 0) {
          process.stderr.write(`[transcript-watch] ingested ${n} episodes from ${path.basename(fp)}\n`)
        }
      }
    } catch (e) {
      process.stderr.write(`[transcript-watch] error: ${e.message}\n`)
    }
  }

  // Initial scan after short delay
  setTimeout(watchTick, 3_000)
  setInterval(watchTick, WATCH_INTERVAL_MS)
}

// ── Startup chunk sync: materialize classifications.chunks → memory_chunks ──
try {
  const synced = store.syncChunksFromClassifications()
  if (synced > 0) process.stderr.write(`[memory-service] synced ${synced} chunks from classifications\n`)
} catch (e) { process.stderr.write(`[memory-service] chunk sync error: ${e.message}\n`) }

// Refresh context.md on every startup (Core Memory + Bot only)
try {
  fs.mkdirSync(path.join(DATA_DIR, 'history'), { recursive: true })
  store.writeContextFile()
  store.writeRecentFile({ serverStartedAt })
  process.stderr.write(`[memory-service] context.md refreshed on startup\n`)
} catch (e) {
  process.stderr.write(`[memory-service] context.md refresh failed: ${e.message}\n`)
}

// ══════════════════════════════════════════════════════════════════════
//  SHARED HELPERS (used by both MCP and HTTP)
// ══════════════════════════════════════════════════════════════════════

// ── Period parser ────────────────────────────────────────────────────

function parsePeriod(period, hasQuery) {
  if (!period && hasQuery) period = '30d'
  if (!period) return null
  if (period === 'all') return null
  if (period === 'last') return { mode: 'last' }
  // Relative: 24h, 3d, 7d, 30d
  const relMatch = period.match(/^(\d+)(h|d)$/)
  if (relMatch) {
    const n = parseInt(relMatch[1])
    const unit = relMatch[2]
    const now = new Date()
    if (unit === 'h') {
      const start = new Date(now.getTime() - n * 3600_000)
      return { start: fmt(start), end: fmt(now) }
    }
    const start = new Date(now)
    start.setDate(start.getDate() - n)
    return { start: fmt(start), end: fmt(now) }
  }
  // Date range: 2026-04-01~2026-04-05
  const rangeMatch = period.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/)
  if (rangeMatch) return { start: rangeMatch[1], end: rangeMatch[2] }
  // Single date: 2026-04-05
  const dateMatch = period.match(/^(\d{4}-\d{2}-\d{2})$/)
  if (dateMatch) return { start: dateMatch[1], end: dateMatch[1], exact: true }
  return null
}

function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── Recall handler ──────────────────────────────────────────────────

async function handleGrep(query, options) {
  const { sort, offset, limit, temporal: searchTemporal } = options

  const queryVector = await embedText(query)
  const skipReranker = sort === 'date'
  const results = await store.searchRelevantHybrid(query, limit * 2, {
    temporal: searchTemporal,
    recordRetrieval: true,
    queryVector,
    skipReranker,
  })

  // Cross-check: drop episode results with low cosine similarity to query
  const PRECISION_FLOOR = 0.65
  const crossChecked = []
  for (const r of results) {
    if (r.type === 'classification' || r.type === 'chunk') { crossChecked.push(r); continue }
    if (r.type !== 'episode' || !queryVector?.length) { crossChecked.push(r); continue }
    try {
      let epVec = null
      if (r.vector_json) {
        epVec = JSON.parse(r.vector_json)
      } else {
        // FTS-only results: look up stored vector
        epVec = await store.getStoredVector('episode', Number(r.entity_id), String(r.content || '').slice(0, 768))
      }
      if (!Array.isArray(epVec) || epVec.length !== queryVector.length) { crossChecked.push(r); continue }
      const sim = cosineSimilarity(queryVector, epVec)
      if (sim >= PRECISION_FLOOR) crossChecked.push(r)
    } catch (e) {
      crossChecked.push(r)
    }
  }
  let items = crossChecked

  if (sort === 'importance') {
    const { computeImportanceScore } = await import('../lib/memory-score-utils.mjs')
    // For chunks, inherit importance from linked classification
    for (const item of items) {
      if (item.type === 'chunk' && item.chunk_episode_id && !item.confidence) {
        try {
          const cls = store.db.prepare(
            `SELECT confidence, retrieval_count FROM classifications WHERE episode_id = ? AND status = 'active' ORDER BY confidence DESC LIMIT 1`
          ).get(item.chunk_episode_id)
          if (cls) {
            item.confidence = cls.confidence
            item.retrieval_count = cls.retrieval_count
          }
        } catch {}
      }
    }
    items.sort((a, b) => computeImportanceScore(b) - computeImportanceScore(a))
  } else if (sort === 'date') {
    items.sort((a, b) => {
      const tsA = a.source_ts || a.updated_at || ''
      const tsB = b.source_ts || b.updated_at || ''
      return tsB.localeCompare(tsA)
    })
  }

  items = items.slice(offset, offset + limit)

  // Semantic chunking: top-N most similar neighbors per hit
  const SEMANTIC_WINDOW = 5   // scan +-5 episodes around each hit
  const SEMANTIC_FLOOR = 0.50 // minimum cosine similarity
  const NEIGHBORS_PER_HIT = 3 // max context episodes per hit
  const hitIds = new Set(items.filter(i => i.type === 'episode').map(i => Number(i.entity_id)))

  const lines = []

  // Chunk results first (highest quality semantic segments)
  for (const item of items) {
    if (item.type === 'chunk') {
      const ts = String(item.source_ts || item.updated_at || '').slice(0, 16)
      const topic = item.classification_topic ? ` [${item.classification_topic}]` : ''
      lines.push(`[${ts}]${topic} ${String(item.content || '').slice(0, 200)}`)
    }
  }

  // Classification results (no chunking)
  for (const item of items) {
    if (item.type === 'classification') {
      const ts = String(item.source_ts || item.updated_at || '').slice(0, 16)
      lines.push(`[${ts}] ${String(item.content || '').slice(0, 200)}`)
    }
  }

  // Semantic chunked episode results
  if (hitIds.size > 0) {
    // Gather hit vectors (from DB cache or compute)
    const hitVectors = new Map()
    for (const id of hitIds) {
      try {
        const row = store.db.prepare('SELECT content FROM episodes WHERE id = ?').get(id)
        if (row?.content) {
          const vec = await store.getStoredVector('episode', id, row.content)
          if (vec?.length > 0) hitVectors.set(id, vec)
        }
      } catch {}
    }

    // For each hit, pick top-N most similar neighbors
    const included = new Map() // episodeId -> { sim, hitId }
    for (const id of hitIds) {
      included.set(id, { sim: 1.0, hitId: id })
    }

    for (const [hitId, hitVec] of hitVectors) {
      const window = store.db.prepare(`
        SELECT id, content FROM episodes
        WHERE id BETWEEN ? AND ? AND kind IN ('message', 'turn') AND id != ?
        ORDER BY id ASC
      `).all(hitId - SEMANTIC_WINDOW, hitId + SEMANTIC_WINDOW, hitId)

      const scored = []
      for (const ep of window) {
        if (hitIds.has(ep.id)) continue // other hits are already included
        try {
          const epVec = await store.getStoredVector('episode', ep.id, ep.content)
          if (!epVec?.length) continue
          const sim = cosineSimilarity(hitVec, epVec)
          if (sim >= SEMANTIC_FLOOR) scored.push({ id: ep.id, sim })
        } catch {}
      }
      // Take top N by similarity
      scored.sort((a, b) => b.sim - a.sim)
      for (const pick of scored.slice(0, NEIGHBORS_PER_HIT)) {
        const existing = included.get(pick.id)
        if (!existing || pick.sim > existing.sim) {
          included.set(pick.id, { sim: pick.sim, hitId })
        }
      }
    }

    // Group by contiguous ID ranges and build chunks
    const sortedIds = [...included.keys()].sort((a, b) => a - b)
    const chunks = []
    let chunk = [sortedIds[0]]
    for (let i = 1; i < sortedIds.length; i++) {
      if (sortedIds[i] - sortedIds[i - 1] <= 1) {
        chunk.push(sortedIds[i])
      } else {
        chunks.push(chunk)
        chunk = [sortedIds[i]]
      }
    }
    if (chunk.length) chunks.push(chunk)

    for (const chunkIds of chunks) {
      try {
        const rows = store.db.prepare(`
          SELECT id, ts, role, content FROM episodes
          WHERE id BETWEEN ? AND ? AND kind IN ('message', 'turn')
          ORDER BY id ASC
        `).all(chunkIds[0], chunkIds[chunkIds.length - 1])
        if (rows.length === 0) continue
        // Filter: only included episodes (semantic pass)
        const filtered = rows.filter(r => included.has(Number(r.id)))
        if (filtered.length === 0) continue
        const tsStart = String(filtered[0].ts || '').slice(0, 16)
        const tsEnd = String(filtered[filtered.length - 1].ts || '').slice(0, 16)
        const chunkHits = filtered.filter(r => hitIds.has(Number(r.id))).length
        lines.push(`\n[${tsStart}~${tsEnd}] ${chunkHits} hit(s)`)
        for (const ep of filtered) {
          const prefix = ep.role === 'user' ? 'u' : 'a'
          const marker = hitIds.has(Number(ep.id)) ? '→' : ' '
          lines.push(`${marker} ${prefix}: ${String(ep.content || '').slice(0, 200)}`)
        }
      } catch {}
    }
  }

  // Fallback: if no results rendered yet, show flat results
  if (hitIds.size === 0 && lines.length === 0) {
    for (const item of items) {
      const ts = String(item.source_ts || item.updated_at || '').slice(0, 16)
      lines.push(`[${ts}] ${String(item.content || '').slice(0, 200)}`)
    }
  }

  return { text: lines.join('\n') || '(no results)' }
}

async function handleRead(options) {
  const { offset, limit, sort, temporal } = options

  let whereClause = "kind IN ('message', 'turn')"
  const params = []

  if (temporal?.mode === 'last') {
    // No additional filter — just use ORDER BY ts DESC LIMIT below
  } else if (temporal?.start) {
    if (temporal.end && temporal.end !== temporal.start) {
      whereClause += " AND ts >= ? AND ts < date(?, '+1 day')"
      params.push(temporal.start, temporal.end)
    } else {
      whereClause += " AND ts >= ? AND ts < date(?, '+1 day')"
      params.push(temporal.start, temporal.start)
    }
  }

  if (sort === 'importance') {
    // Importance mode: mix classifications (by confidence) + episodes (by recency)
    const halfLimit = Math.ceil(limit / 2)
    let classWhereDate = ''
    const classParams = []
    if (temporal?.start && temporal.mode !== 'last') {
      classWhereDate = ' AND day_key >= ? AND day_key <= ?'
      classParams.push(temporal.start, temporal.end ?? temporal.start)
    }
    const classifications = store.db.prepare(`
      SELECT 'classification' AS type, classification AS subtype,
             trim(classification || ' | ' || topic || ' | ' || element || CASE WHEN state IS NOT NULL AND state != '' THEN ' | ' || state ELSE '' END) AS content,
             confidence, retrieval_count, updated_at
      FROM classifications
      WHERE status = 'active'${classWhereDate}
      ORDER BY (CAST(confidence AS REAL) + CAST(COALESCE(retrieval_count, 0) AS REAL) * 0.1) DESC
      LIMIT ? OFFSET ?
    `).all(...classParams, halfLimit, offset)

    const episodeLimit = Math.max(1, limit - classifications.length)
    const episodes = store.db.prepare(`
      SELECT ts, role, content FROM episodes
      WHERE ${whereClause}
      ORDER BY ts DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, episodeLimit, offset)

    const lines = []
    for (const c of classifications) {
      const ts = String(c.updated_at || '').slice(0, 10)
      lines.push(`[${ts}] ${String(c.content || '').slice(0, 200)}`)
    }
    for (const ep of episodes) {
      const prefix = ep.role === 'user' ? 'u' : 'a'
      lines.push(`[${String(ep.ts || '').slice(0, 16)}] ${prefix}: ${String(ep.content).slice(0, 200)}`)
    }
    return { text: lines.join('\n') || '(no results found)' }
  }

  // Date mode: newest first
  const episodes = store.db.prepare(`
    SELECT ts, role, content FROM episodes
    WHERE ${whereClause}
    ORDER BY ts DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset)

  const lines = episodes.map(ep => {
    const prefix = ep.role === 'user' ? 'u' : 'a'
    return `[${String(ep.ts || '').slice(0, 16)}] ${prefix}: ${String(ep.content).slice(0, 200)}`
  })

  return { text: lines.join('\n') || '(no episodes found)' }
}

function handleTagQuery(tag, limit = 20) {
  const rows = store.db.prepare(`
    SELECT topic, element, importance, updated_at FROM classifications
    WHERE status = 'active' AND importance LIKE ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(`%${tag}%`, limit)
  if (rows.length === 0) return { text: `(no ${tag} classifications found)` }
  const lines = rows.map(r => {
    const date = String(r.updated_at || '').slice(0, 10)
    return `[${date}] ${r.topic} — ${r.element}`
  })
  return { text: `${tag} (${rows.length}):\n${lines.join('\n')}` }
}

function handleStats() {
  const episodes = store.db.prepare('SELECT COUNT(*) as c FROM episodes').get().c
  const classifications = store.db.prepare('SELECT COUNT(*) as c FROM classifications').get().c
  const pending = store.db.prepare("SELECT COUNT(*) as c FROM memory_candidates WHERE status='pending'").get().c
  const consolidated = store.db.prepare("SELECT COUNT(*) as c FROM memory_candidates WHERE status='consolidated'").get().c
  const tags = store.db.prepare(`
    SELECT importance, COUNT(*) as c FROM classifications
    WHERE importance IS NOT NULL AND importance != ''
    GROUP BY importance ORDER BY c DESC
  `).all()
  const embeds = store.db.prepare('SELECT COUNT(*) as c FROM pending_embeds').get().c
  const lastCycle = (() => {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'memory-cycle.json'), 'utf8'))
      const ago = Date.now() - (state.lastCycle1At || 0)
      return `${Math.round(ago / 60000)}m ago`
    } catch { return 'unknown' }
  })()

  const lines = [
    `episodes: ${episodes}`,
    `classifications: ${classifications} (${tags.map(t => `${t.importance}:${t.c}`).join(', ')})`,
    `candidates: pending=${pending}, consolidated=${consolidated}`,
    `pending_embeds: ${embeds}`,
    `last_cycle1: ${lastCycle}`,
  ]
  return { text: lines.join('\n') }
}

async function handleRecall(args) {
  const query = String(args.query ?? '').trim()
  const period = String(args.period ?? '').trim() || undefined
  const explicitSort = args.sort != null ? String(args.sort) : null
  const offset = Math.max(0, Number(args.offset ?? 0))
  const limit = Math.max(1, Number(args.limit ?? 20))

  // Shortcut queries
  if (query === 'stats') return handleStats()
  if (query === 'rules') return handleTagQuery('rule', limit)
  if (query === 'decisions') return handleTagQuery('decision', limit)
  if (query === 'goals') return handleTagQuery('goal', limit)
  if (query === 'preferences') return handleTagQuery('preference', limit)
  if (query === 'incidents') return handleTagQuery('incident', limit)
  if (query === 'directives') return handleTagQuery('directive', limit)

  const temporal = parsePeriod(period, Boolean(query))

  // Default sort: "date" when period="last", "importance" otherwise
  const sort = explicitSort ?? (temporal?.mode === 'last' ? 'date' : 'importance')

  if (query) {
    // Semantic search mode (handleGrep)
    const searchTemporal = temporal
      ? (temporal.mode === 'last' ? null : { start: temporal.start, end: temporal.end, exact: temporal.exact })
      : null
    return handleGrep(query, { sort, offset, limit, temporal: searchTemporal })
  }

  // Browse mode (handleRead) — no query
  return handleRead({ offset, limit, sort, temporal: temporal ?? { mode: 'last' } })
}

// ── Cycle handler ────────────────────────────────────────────────────

async function handleCycle(args) {
  const action = String(args.action ?? '')
  const ws = WORKSPACE_PATH
  const config = readMainConfig()

  if (action === 'status') {
    return { text: JSON.stringify(getCycleStatus(), null, 2) }
  }
  if (action === 'sleep') {
    await sleepCycle(ws)
    return { text: 'Memory cycle completed.' }
  }
  if (action === 'flush') {
    await memoryFlush(ws, { maxDays: Number(args.maxDays ?? 1) })
    return { text: 'Memory flush completed.' }
  }
  if (action === 'rebuild') {
    _rebuildLock = true
    try {
      const maxDays = Number(args.maxDays ?? 2)
      const window = args.window || undefined
      await rebuildRecent(ws, { maxDays, window })
      store.syncChunksFromClassifications()
      store.writeRecentFile({ serverStartedAt })
      return { text: `Memory rebuild completed (maxDays=${maxDays}).` }
    } finally { _rebuildLock = false }
  }
  if (action === 'prune') {
    await pruneToRecent(ws, { maxDays: Number(args.maxDays ?? 5) })
    return { text: 'Memory prune completed.' }
  }
  if (action === 'cycle1') {
    const force = Boolean(args.force)
    const maxItems = args.maxItems ? Number(args.maxItems) : undefined
    const maxAgeDays = args.maxAgeDays ? Number(args.maxAgeDays) : undefined
    const c1result = await runCycle1(ws, config, { force, maxItems, maxAgeDays })
    return { text: `Cycle1 completed: extracted=${Number(c1result?.extracted ?? 0)} classifications=${Number(c1result?.classifications ?? 0)}` }
  }
  if (action === 'rebuild_classifications') {
    const maxAgeDays = args.maxAgeDays ? Number(args.maxAgeDays) : undefined
    const window = args.window || undefined
    const result = await rebuildClassifications(ws, { maxAgeDays, window })
    return { text: `Rebuild classifications completed: total=${result.total} batches=${result.batches} classifications=${result.classifications}` }
  }
  if (action === 'backfill') {
    const backfillLimit = Math.max(1, Math.min(Number(args.limit ?? 100), 500))
    // Find episodes with no candidate entry
    const uncovered = store.db.prepare(`
      SELECT e.id, e.ts, e.day_key, e.role, e.content
      FROM episodes e
      LEFT JOIN memory_candidates mc ON mc.episode_id = e.id
      WHERE mc.id IS NULL
        AND e.kind IN ('message', 'turn')
        AND e.role IN ('user', 'assistant')
        AND LENGTH(e.content) >= 10
        AND e.content NOT LIKE 'You are consolidating%'
        AND e.content NOT LIKE 'You are improving%'
      ORDER BY e.ts DESC
      LIMIT ?
    `).all(backfillLimit)

    if (uncovered.length === 0) {
      return { text: 'Backfill: no uncovered episodes found.' }
    }

    // Create pending candidates
    let created = 0
    for (const ep of uncovered) {
      try {
        store.db.prepare(`
          INSERT OR IGNORE INTO memory_candidates (episode_id, ts, day_key, role, content, score, status)
          VALUES (?, ?, ?, ?, ?, 0, 'pending')
        `).run(ep.id, ep.ts, ep.day_key, ep.role, ep.content)
        created++
      } catch {}
    }

    // Run cycle1 with force to process them
    const c1result = await runCycle1(ws, config, { force: true })
    return { text: `Backfill: ${created} candidates created from ${uncovered.length} episodes. Cycle1: ${JSON.stringify(c1result)}` }
  }
  return { text: `unknown memory action: ${action}`, isError: true }
}

// ══════════════════════════════════════════════════════════════════════
//  MCP SERVER (stdio transport — Claude Code tools)
// ══════════════════════════════════════════════════════════════════════

const MEMORY_INSTRUCTIONS = 'Recall naturally, like remembering — use search_memories() to recall.'

const mcp = new Server(
  { name: 'trib-memory', version: '0.0.15' },
  { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS },
)

// ── Tool definitions ─────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_cycle',
      title: 'Memory Cycle',
      annotations: { title: 'Memory Cycle', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: 'Run memory management operations: sleep (merged update), flush (consolidate pending), rebuild (recent), prune (cleanup), cycle1 (fast update), backfill (create candidates for old episodes then run cycle1), status.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['sleep', 'flush', 'rebuild', 'rebuild_classifications', 'prune', 'cycle1', 'backfill', 'status'], description: 'Memory operation to run' },
          maxDays: { type: 'number', description: 'Max days to process (default varies by action)' },
          window: { type: 'string', description: 'Time window for rebuild/rebuild_classifications: 1d, 3d, 7d, 30d, all' },
          limit: { type: 'number', description: 'Max episodes to backfill (default 100)' },
        },
        required: ['action'],
      },
    },
    {
      name: 'search_memories',
      title: 'Search Memories',
      annotations: { title: 'Search Memories', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: 'Search and retrieve memory. With query: semantic search. Without query: browse recent episodes. Special queries: "stats", "rules", "decisions", "goals", "preferences", "incidents", "directives".',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text. Triggers semantic hybrid search.' },
          period: { type: 'string', description: 'Time scope: "last" (previous session), "24h"/"3d"/"7d"/"30d" (relative), "all" (no limit), "2026-04-05" (single date), "2026-04-01~2026-04-05" (date range). Default: 30d when query is set, latest entries when no query.' },
          sort: { type: 'string', enum: ['date', 'importance'], description: 'Sort order: "date" (newest first, reranker skipped) or "importance" (final score, reranker enabled). Default: "date" when period="last", "importance" otherwise.' },
          limit: { type: 'number', default: 20, description: 'Max results to return.' },
          offset: { type: 'number', default: 0, description: 'Skip N results for pagination.' },
        },
        required: [],
      },
    },
  ],
}))

// ── Tool call handler ────────────────────────────────────────────────

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const toolName = req.params.name
  const args = req.params.arguments ?? {}

  try {
    if (toolName === 'search_memories') {
      const result = await handleRecall(args)
      return {
        content: [{ type: 'text', text: result.text }],
        isError: result.isError || false,
      }
    }

    if (toolName === 'memory_cycle') {
      const result = await handleCycle(args)
      return {
        content: [{ type: 'text', text: result.text }],
        isError: result.isError || false,
      }
    }

    return {
      content: [{ type: 'text', text: `unknown tool: ${toolName}` }],
      isError: true,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${toolName} failed: ${msg}` }],
      isError: true,
    }
  }
})

// ══════════════════════════════════════════════════════════════════════
//  HTTP SERVER (tcp — hooks + internal use)
// ══════════════════════════════════════════════════════════════════════

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve({})
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data, null, 0)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendError(res, msg, status = 500) {
  sendJson(res, { error: msg }, status)
}

const httpServer = http.createServer(async (req, res) => {
  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    try {
      const episodeCount = store.countEpisodes()
      const classificationCount = store.db.prepare('SELECT COUNT(*) AS n FROM classifications WHERE status = ?').get('active')?.n ?? 0
      sendJson(res, { status: 'ok', episodeCount, classificationCount })
    } catch (e) {
      sendError(res, e.message)
    }
    return
  }

  // GET /hints (query string)
  if (req.method === 'GET' && req.url?.startsWith('/hints')) {
    const url = new URL(req.url, 'http://localhost')
    const q = url.searchParams.get('q') || ''
    if (!q || q.length < 3) {
      sendJson(res, { hints: '' })
      return
    }
    try {
      const ctx = await store.buildInboundMemoryContext(q, { skipLowSignal: true, serverStartedAt })
      sendJson(res, { hints: ctx || '' })
    } catch {
      sendJson(res, { hints: '' })
    }
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, { error: 'Method not allowed' }, 405)
    return
  }

  const body = await readBody(req)

  try {
    // POST /hints (JSON body)
    if (req.url === '/hints') {
      const q = String(body.query ?? '').trim()
      if (!q || q.length < 3) {
        sendJson(res, { hints: '' })
        return
      }
      const ctx = await store.buildInboundMemoryContext(q, { ...body.options ?? { skipLowSignal: true }, serverStartedAt })
      sendJson(res, { hints: ctx || '' })
      return
    }

    // POST /episode
    if (req.url === '/episode') {
      const id = store.appendEpisode({
        ts: body.ts || localNow(),
        backend: body.backend || 'trib-memory',
        channelId: body.channelId || null,
        userId: body.userId || null,
        userName: body.userName || null,
        sessionId: body.sessionId || null,
        role: body.role || 'user',
        kind: body.kind || 'message',
        content: body.content || '',
        sourceRef: body.sourceRef || null,
      })
      sendJson(res, { ok: true, id })
      return
    }

    // POST /context
    if (req.url === '/context') {
      store.writeContextFile()
      sendJson(res, { ok: true })
      return
    }

    // POST /ingest-transcript
    if (req.url === '/ingest-transcript') {
      const filePath = body.filePath
      if (!filePath) {
        sendJson(res, { error: 'filePath required' }, 400)
        return
      }
      try {
        store.ingestTranscriptFile(filePath)
        sendJson(res, { ok: true })
      } catch (e) {
        sendJson(res, { error: e.message }, 500)
      }
      return
    }

    sendJson(res, { error: 'Not found' }, 404)
  } catch (e) {
    process.stderr.write(`[memory-service] ${req.url} error: ${e.stack || e.message}\n`)
    sendError(res, e.message)
  }
})

// ══════════════════════════════════════════════════════════════════════
//  STARTUP
// ══════════════════════════════════════════════════════════════════════

// ── HTTP port binding ────────────────────────────────────────────────

function writePortFile(port) {
  const dir = path.dirname(PORT_FILE)
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  fs.writeFileSync(PORT_FILE, String(port))
}

function removePortFile() {
  try { fs.unlinkSync(PORT_FILE) } catch {}
}

let activePort = BASE_PORT
function tryListen() {
  httpServer.listen(activePort, '127.0.0.1', () => {
    writePortFile(activePort)
    process.stderr.write(`[memory-service] HTTP listening on 127.0.0.1:${activePort}\n`)
  })
}

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && activePort < MAX_PORT) {
    activePort++
    tryListen()
  } else {
    process.stderr.write(`[memory-service] HTTP fatal: ${err.message}\n`)
    process.exit(1)
  }
})

tryListen()

// ── MCP stdio transport ──────────────────────────────────────────────

const transport = new StdioServerTransport()
await mcp.connect(transport)
process.stderr.write('[memory-service] MCP stdio connected\n')

// ── Graceful shutdown ────────────────────────────────────────────────

function shutdown() {
  process.stderr.write('[memory-service] shutting down...\n')
  void stopLlmWorker().catch(() => {})
  removePortFile()
  void mcp.close()
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
