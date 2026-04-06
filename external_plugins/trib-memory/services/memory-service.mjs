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
  resolveStartupEmbeddingOptions,
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

const startupEmbedding = resolveStartupEmbeddingOptions(opsPolicy)
if (startupEmbedding) {
  let startupEmbeddingJob = Promise.resolve()
  if (startupEmbedding.warmup) {
    startupEmbeddingJob = startupEmbeddingJob.then(() => store.warmupEmbeddings())
  }
  startupEmbeddingJob = startupEmbeddingJob.then(() => store.ensureEmbeddings({ perTypeLimit: startupEmbedding.perTypeLimit }))
  void startupEmbeddingJob.catch(err => process.stderr.write(`[memory-service] startup embedding catch-up failed: ${err}\n`))
}

// Rebuild lock: pauses cycles during manual rebuild
let _rebuildLock = false

// ── Cycle schedulers (last-run based, not wall-clock) ────────────────

const cycle1Config = mainConfig?.memory?.cycle1 ?? {}
const cycle1IntervalStr = cycle1Config.interval || '5m'
const cycle1Ms = parseInterval(cycle1IntervalStr)
const cycle2IntervalStr = mainConfig?.memory?.cycle2?.interval || '1h'
const cycle2Ms = parseInterval(cycle2IntervalStr)
const cycle3IntervalStr = mainConfig?.memory?.cycle3?.interval || '24h'
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
  if (mainConfig?.memory?.enabled === false) return
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
      const result = await runCycle1(WORKSPACE_PATH, mainConfig)
      process.stderr.write(
        `[cycle1] completed at ${localNow()}${startup ? ' [startup-catchup]' : ''} extracted=${Number(result?.extracted ?? 0)}\n`,
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

// Refresh context.md on every startup (Core Memory + Bot only)
try {
  fs.mkdirSync(path.join(DATA_DIR, 'history'), { recursive: true })
  store.writeContextFile()
  store.writeRecentFile()
  process.stderr.write(`[memory-service] context.md refreshed on startup\n`)
} catch (e) {
  process.stderr.write(`[memory-service] context.md refresh failed: ${e.message}\n`)
}

// ══════════════════════════════════════════════════════════════════════
//  SHARED HELPERS (used by both MCP and HTTP)
// ══════════════════════════════════════════════════════════════════════

// ── Recall handler (grep/read/glob modes) ───────────────────────────

async function handleGrep(query, options) {
  const { date, sort, offset, limit, context } = options

  const { parseTemporalHint } = await import('../lib/memory-query-plan.mjs')
  const temporal = parseTemporalHint(query)
  let searchTemporal = temporal ? { start: temporal.start, end: temporal.end ?? temporal.start } : null
  if (!searchTemporal && date) {
    searchTemporal = { start: date, end: date, exact: true }
  }

  const queryVector = await embedText(query)
  const results = await store.searchRelevantHybrid(query, limit * 2, {
    temporal: searchTemporal,
    recordRetrieval: true,
    queryVector,
  })

  // Cross-check: drop episode results with low cosine similarity to query
  const PRECISION_FLOOR = 0.65
  const crossChecked = []
  for (const r of results) {
    if (r.type === 'classification') { crossChecked.push(r); continue }
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

  if (sort === 'date') {
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

  // Classification results first (no chunking)
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

  // Fallback: if no chunks built, show flat results
  if (hitIds.size === 0 && lines.length === 0) {
    for (const item of items) {
      const ts = String(item.source_ts || item.updated_at || '').slice(0, 16)
      lines.push(`[${ts}] ${String(item.content || '').slice(0, 200)}`)
    }
  }

  return { text: lines.join('\n') || '(no results)' }
}

async function handleRead(options) {
  const { session, date, offset, limit, sort } = options

  let whereClause = "kind IN ('message', 'turn')"
  const params = []

  if (session === 'last' || session === 'current') {
    const recentSessions = store.db.prepare(`
      SELECT DISTINCT substr(source_ref, 12, instr(substr(source_ref, 12), ':') - 1) AS session_id,
             MAX(ts) AS last_ts
      FROM episodes
      WHERE source_ref LIKE 'transcript:%'
      GROUP BY session_id
      ORDER BY last_ts DESC
      LIMIT 2
    `).all()

    const targetSession = session === 'last'
      ? recentSessions[1]?.session_id
      : recentSessions[0]?.session_id

    if (targetSession) {
      whereClause += " AND source_ref LIKE ?"
      params.push(`transcript:${targetSession}:%`)
    }
  } else if (session) {
    whereClause += " AND source_ref LIKE ?"
    params.push(`transcript:${session}:%`)
  }

  if (date) {
    whereClause += " AND ts >= ? AND ts < date(?, '+1 day')"
    params.push(date, date)
  }

  // Session mode defaults to DESC (newest first); explicit sort overrides
  const isSessionMode = Boolean(session)
  const orderDir = sort === 'asc' ? 'ASC' : sort === 'date' || isSessionMode ? 'DESC' : 'ASC'
  const episodes = store.db.prepare(`
    SELECT ts, role, content FROM episodes
    WHERE ${whereClause}
    ORDER BY ts ${orderDir}, id ${orderDir}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset)

  const lines = episodes.map(ep => {
    const prefix = ep.role === 'user' ? 'u' : 'a'
    return `[${String(ep.ts || '').slice(0, 16)}] ${prefix}: ${String(ep.content).slice(0, 200)}`
  })

  return { text: lines.join('\n') || '(no episodes found)' }
}

async function handleGlob(options) {
  const { date, offset, limit } = options
  const likePattern = date.replace(/\*/g, '%')

  const days = store.db.prepare(`
    SELECT substr(ts, 1, 10) AS day, COUNT(*) AS episodes,
           MIN(ts) AS first_ts, MAX(ts) AS last_ts
    FROM episodes
    WHERE kind IN ('message', 'turn')
      AND substr(ts, 1, 10) LIKE ?
    GROUP BY day
    ORDER BY day DESC
    LIMIT ? OFFSET ?
  `).all(likePattern, limit, offset)

  const lines = days.map(d => `${d.day}: ${d.episodes} episodes (${String(d.first_ts).slice(11,16)}~${String(d.last_ts).slice(11,16)})`)

  return { text: lines.join('\n') || '(no matching dates)' }
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

async function handleRecallSingle(args) {
  const query = String(args.query ?? '').trim()
  const session = String(args.session ?? '').trim()
  const date = String(args.date ?? '').trim()
  const sort = String(args.sort ?? 'relevance')
  const offset = Math.max(0, Number(args.offset ?? 0))
  // Session read mode needs higher default limit to capture full conversations
  const hasExplicitLimit = args.limit != null
  const defaultLimit = (session && !hasExplicitLimit) ? 200 : 10
  const limit = Math.max(1, Number(args.limit ?? defaultLimit))
  const contextLines = Math.max(0, Number(args.context ?? 0))

  // Shortcut queries
  if (query === 'stats') return handleStats()
  if (query === 'rules') return handleTagQuery('rule', limit)
  if (query === 'decisions') return handleTagQuery('decision', limit)
  if (query === 'goals') return handleTagQuery('goal', limit)
  if (query === 'preferences') return handleTagQuery('preference', limit)
  if (query === 'incidents') return handleTagQuery('incident', limit)
  if (query === 'directives') return handleTagQuery('directive', limit)
  if (query && !session) {
    return handleGrep(query, { date, sort, offset, limit, context: contextLines })
  }
  if (session || (date && !date.includes('*') && !query)) {
    return handleRead({ session, date, offset, limit, sort })
  }
  if (date && date.includes('*')) {
    return handleGlob({ date, offset, limit })
  }
  return handleRead({ session: 'last', date: '', offset, limit, sort })
}

async function handleRecall(args) {
  if (Array.isArray(args.queries) && args.queries.length > 0) {
    const results = []
    for (const q of args.queries) {
      const result = await handleRecallSingle(q)
      results.push(result.text)
    }
    return { text: results.join('\n\n---\n\n') }
  }
  return handleRecallSingle(args)
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
      await rebuildRecent(ws, { maxDays: Number(args.maxDays ?? 2) })
    } finally { _rebuildLock = false }
    return { text: 'Memory rebuild completed.' }
  }
  if (action === 'prune') {
    await pruneToRecent(ws, { maxDays: Number(args.maxDays ?? 5) })
    return { text: 'Memory prune completed.' }
  }
  if (action === 'cycle1') {
    const force = Boolean(args.force)
    const c1result = await runCycle1(ws, config, { force })
    return { text: `Cycle1 completed: ${JSON.stringify(c1result)}` }
  }
  return { text: `unknown memory action: ${action}`, isError: true }
}

// ══════════════════════════════════════════════════════════════════════
//  MCP SERVER (stdio transport — Claude Code tools)
// ══════════════════════════════════════════════════════════════════════

const MEMORY_INSTRUCTIONS = [
  '## Memory System',
  '',
  '### Behavior',
  '- Recall like remembering, not querying. Weave naturally into conversation.',
  '- Proactively surface relevant context from past conversations.',
  '',
  '### Rules',
  '- Use `queries` array for 2+ lookups in one call. No separate tool calls.',
  '- Never query the database directly (sqlite, SQL). Always use search_memories.',
  '- Trust current code/config over recalled memory if they conflict.',
  '- Do not write to MEMORY.md or memory/ folder. This system handles persistence.',
].join('\n')

const mcp = new Server(
  { name: 'trib-memory', version: '0.0.4' },
  { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS },
)

// ── Tool definitions ─────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_cycle',
      title: 'Memory Cycle',
      annotations: { title: 'Memory Cycle', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description: 'Run memory management operations: sleep (merged update), flush (consolidate pending), rebuild (recent), prune (cleanup), cycle1 (fast update), status.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['sleep', 'flush', 'rebuild', 'prune', 'cycle1', 'status'], description: 'Memory operation to run' },
          maxDays: { type: 'number', description: 'Max days to process (default varies by action)' },
        },
        required: ['action'],
      },
    },
    {
      name: 'search_memories',
      title: 'Search Memories',
      annotations: { title: 'Search Memories', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: 'Search and retrieve memory. Auto-routes by params: query→search, session→read, date+wildcard→list, query="stats"→status, query="rules"→tag browse.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text. Triggers hybrid search (grep mode).' },
          session: { type: 'string', description: '"last", "current", or session UUID. Triggers session read mode.' },
          date: { type: 'string', description: 'Date "2026-04-02" for read, or "2026-04-*" for listing (glob mode).' },
          sort: { type: 'string', enum: ['relevance', 'date', 'asc'], default: 'relevance', description: 'Sort order. Session mode defaults to newest first (DESC). Use "asc" to override to oldest first.' },
          offset: { type: 'number', default: 0, description: 'Skip N results.' },
          limit: { type: 'number', default: 10, description: 'Max results to return. Default 10 for search, 200 for session mode.' },
          context: { type: 'number', default: 0, description: 'Surrounding episodes count (grep mode, like grep -C).' },
          queries: { type: 'array', description: 'Batch: array of query objects. Each has same params (query, session, date, sort, offset, limit, context).', items: { type: 'object', properties: { query: { type: 'string' }, session: { type: 'string' }, date: { type: 'string' }, sort: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' }, context: { type: 'number' } } } },
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

  // GET /hints (query string — for UserPromptSubmit hook compatibility)
  if (req.method === 'GET' && req.url?.startsWith('/hints')) {
    const url = new URL(req.url, 'http://localhost')
    const q = url.searchParams.get('q') || ''
    if (!q || q.length < 3) {
      sendJson(res, { hints: '' })
      return
    }
    try {
      const ctx = await store.buildInboundMemoryContext(q, { skipLowSignal: true })
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
      const ctx = await store.buildInboundMemoryContext(q, body.options ?? { skipLowSignal: true })
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
