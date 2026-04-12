#!/usr/bin/env node
// Suppress experimental warnings (they go to stdout and break MCP stdio)
process.removeAllListeners('warning')
process.on('warning', () => {})
/**
 * memory-service.mjs — MCP server + HTTP hybrid memory service.
 *
 * Single Node.js process providing:
 *   MCP (stdio)  — search_memories, memory_cycle tools for Claude Code
 *   MCP (http)   — /mcp endpoint (Streamable HTTP transport, stateless)
 *   HTTP (tcp)   — /episode, /health, /api/tool for hooks + internal use
 *
 * Owns the MemoryStore singleton exclusively.
 * Port: 3350-3357 (written to $TMPDIR/trib-memory/memory-port)
 */

import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readPluginVersion() {
  try {
    const manifestPath = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version || '0.0.1'
  } catch { return '0.0.1' }
}
const PLUGIN_VERSION = readPluginVersion()

// ── CPU throttle: prevent inference from hogging all cores ──
try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
try {
  const { env } = await import('@huggingface/transformers')
  env.backends.onnx.wasm.numThreads = 2
} catch {}
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { getMemoryStore } from './lib/memory.mjs'
import { configureEmbedding, embedText } from './lib/embedding-provider.mjs'
import { cosineSimilarity } from './lib/memory-vector-utils.mjs'
import { startLlmWorker, stopLlmWorker } from './lib/llm-worker-host.mjs'
import {
  sleepCycle,
  memoryFlush,
  rebuildRecent,
  rebuildClassifications,
  pruneToRecent,
  getCycleStatus,
  runCycle1,
  readMainConfig,
  parseInterval,
} from './lib/memory-cycle.mjs'
import { localNow } from './lib/memory-text-utils.mjs'
import {
  readMemoryOpsPolicy,
  readMemoryFeatureFlags,
  buildStartupBackfillOptions,
  shouldRunCycleCatchUp,
} from './lib/memory-ops-policy.mjs'

// ── Configuration ────────────────────────────────────────────────────

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || process.argv[2]
  || (() => {
    // Fallback: find plugin data dir by convention
    const candidates = [
      path.join(os.homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin'),
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

// ── Singleton guard: prevent multiple instances ─────────────────────
import { execFileSync } from 'child_process'
const LOCK_FILE = path.join(DATA_DIR, '.memory-service.lock')

const RUNTIME_DIR = path.join(os.tmpdir(), 'trib-memory')
try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }) } catch {}
const PORT_FILE = path.join(RUNTIME_DIR, 'memory-port')
const BASE_PORT = 3350
const MAX_PORT = 3357

// ── Health check: is a primary server already running? ───────────────

function readPortFile() {
  try {
    const port = Number(fs.readFileSync(PORT_FILE, 'utf8').trim())
    return (port >= BASE_PORT && port <= MAX_PORT) ? port : null
  } catch { return null }
}

async function isExistingServerHealthy() {
  const port = readPortFile()
  if (!port) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    clearTimeout(timer)
    if (res.ok) return port
  } catch { /* not reachable */ }
  return null
}

// ── Proxy mode: forward stdio MCP to existing HTTP server ───────────

async function runProxyMode(port) {
  process.stderr.write(`[memory-service] Healthy server on port ${port}, entering proxy mode\n`)

  const proxyMcp = new Server(
    { name: 'trib-memory', version: PLUGIN_VERSION },
    { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS_TEXT },
  )

  proxyMcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: PROXY_TOOL_DEFS }))
  proxyMcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120000)
      const res = await fetch(`http://127.0.0.1:${port}/api/tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: req.params.name, arguments: req.params.arguments ?? {} }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      return await res.json()
    } catch (err) {
      return { content: [{ type: 'text', text: `proxy error: ${err.message}` }], isError: true }
    }
  })

  const transport = new StdioServerTransport()
  await proxyMcp.connect(transport)
  // connect() resolves after transport.start(), not after close.
  // Block until the MCP connection closes (stdin EOF).
  await new Promise((resolve) => { proxyMcp.onclose = resolve })
}

// ── Primary mode: full server startup ───────────────────────────────

function killPreviousServer(pid) {
  if (pid <= 0 || pid === process.pid) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        encoding: 'utf8', timeout: 5000, stdio: 'ignore'
      })
      process.stderr.write(`[memory-service] Killed previous server PID ${pid}\n`)
    } catch {}
  } else {
    try { process.kill(pid, 'SIGTERM') } catch {}
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const content = fs.readFileSync(LOCK_FILE, 'utf8').trim()
      const lockedPid = Number(content)
      if (lockedPid > 0 && lockedPid !== process.pid) {
        killPreviousServer(lockedPid)
        process.stderr.write(`[memory-service] Removed stale lock (PID ${lockedPid})\n`)
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8')
  } catch (e) {
    process.stderr.write(`[memory-service] Lock acquisition failed: ${e.message}\n`)
  }
}

function releaseLock() {
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim()
    if (Number(content) === process.pid) fs.unlinkSync(LOCK_FILE)
  } catch {}
}

// Forward-declared constants used by proxy mode (full defs below)
const MEMORY_INSTRUCTIONS_TEXT = [
  'CRITICAL: invoke `recall` skill at session start and before any reference to prior context.',
  'Order: recall (past context) → search (external info) → codebase (Grep/Glob/Read). Never skip recall when past context may apply.',
  'When in doubt, recall first — cost is near zero, missing context is expensive.',
].join('\n')
const PROXY_TOOL_DEFS = [
  { name: 'memory_cycle', description: 'Run memory management operations.', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
  { name: 'search_memories', description: 'Search past context and memory. Use when user references prior work, decisions, or preferences. Not for external info (use search tool). Storage is automatic — only retrieval is manual. Never write to MEMORY.md or use sqlite directly.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: [] } },
]

// ── Module-level state (initialized by init() or standalone startup) ──
let store = null
let mainConfig = null
let opsPolicy = null
let featureFlags = null
let WORKSPACE_PATH = null
let serverStartedAt = null
let _rebuildLock = false
let _cycleInterval = null
let _startupTimeout = null
let _initialized = false

// ── Shared init logic (used by both standalone and unified modes) ─────

async function _initStore() {
  mainConfig = readMainConfig()
  opsPolicy = readMemoryOpsPolicy(mainConfig)
  featureFlags = readMemoryFeatureFlags(mainConfig)
  const embeddingConfig = mainConfig?.embedding
  if (embeddingConfig?.provider || embeddingConfig?.ollamaModel || embeddingConfig?.dtype) {
    configureEmbedding({
      provider: embeddingConfig.provider,
      ollamaModel: embeddingConfig.ollamaModel,
      dtype: embeddingConfig.dtype,
    })
  }

  store = getMemoryStore(DATA_DIR)
  store.syncHistoryFromFiles()
  startLlmWorker()

  WORKSPACE_PATH = process.env.TRIB_MEMORY_WORKSPACE || process.cwd()
}

function getUnclassifiedEpisodeCount() {
  try {
    return store.getUnclassifiedEpisodeDays(100, 1).reduce((sum, item) => sum + Number(item?.n ?? 0), 0)
  } catch {
    return 0
  }
}

function getPendingEmbedCount() {
  return 0
}

function _runStartupBackfill() {
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
}

// ── Cycle schedulers (last-run based, not wall-clock) ────────────────

function getCycleLastRun() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'memory-cycle.json'), 'utf8'))
    return {
      cycle1: Number(state?.lastCycle1At) || 0,
      cycle2: Number(state?.lastSleepAt) || 0,
    }
  } catch { return { cycle1: 0, cycle2: 0 } }
}

async function checkCycles(options = {}) {
  if (_rebuildLock) return
  if (mainConfig?.enabled === false) return

  const cycle1Config = mainConfig?.cycle1 ?? {}
  const cycle1Ms = parseInterval(cycle1Config.interval || '5m')
  const cycle2Ms = parseInterval(mainConfig?.cycle2?.interval || '1h')

  const startup = options.startup === true
  const now = Date.now()
  const last = getCycleLastRun()
  const unclassifiedEpisodes = getUnclassifiedEpisodeCount()
  const pendingEmbeds = getPendingEmbedCount()
  const cycle1Due = now - last.cycle1 >= cycle1Ms
  const cycle2Due = now - last.cycle2 >= cycle2Ms

  if (
    startup
      ? shouldRunCycleCatchUp('cycle1', opsPolicy, {
          due: cycle1Due,
          lastRunAt: last.cycle1 || null,
          unclassifiedEpisodes,
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

  if (
    startup
      ? shouldRunCycleCatchUp('cycle2', opsPolicy, {
          due: cycle2Due,
          lastRunAt: last.cycle2 || null,
          unclassifiedEpisodes,
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
}

function _startCycles() {
  if (_cycleInterval) return  // already running
  _cycleInterval = setInterval(() => { void checkCycles() }, opsPolicy.scheduler.checkIntervalMs)
  const startupDelayMs = Math.max(
    Number(opsPolicy.startup.cycle1CatchUp.delayMs ?? 0),
    Number(opsPolicy.startup.cycle2CatchUp.delayMs ?? 0),
  )
  _startupTimeout = setTimeout(() => { void checkCycles({ startup: true }) }, startupDelayMs)
}

function _stopCycles() {
  if (_cycleInterval) { clearInterval(_cycleInterval); _cycleInterval = null }
  if (_startupTimeout) { clearTimeout(_startupTimeout); _startupTimeout = null }
}

function _initTranscriptWatcher() {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
  const SAFETY_POLL_MS = 5 * 60_000
  const DEBOUNCE_MS = 500
  const watchedFiles = new Map()
  const pendingByFile = new Map()

  function isWatchable(relOrBase) {
    const base = path.basename(relOrBase)
    if (!base.endsWith('.jsonl') || base.startsWith('agent-')) return false
    if (relOrBase.includes('tmp') || relOrBase.includes('cache') || relOrBase.includes('plugins')) return false
    return true
  }

  function ingestOne(fp) {
    try {
      if (!fs.existsSync(fp)) return
      const mtime = fs.statSync(fp).mtimeMs
      const prev = watchedFiles.get(fp)
      if (prev && prev >= mtime) return
      watchedFiles.set(fp, mtime)
      const n = store.ingestTranscriptFile(fp)
      if (n > 0) {
        process.stderr.write(`[transcript-watch] ingested ${n} episodes from ${path.basename(fp)}\n`)
      }
    } catch (e) {
      process.stderr.write(`[transcript-watch] ingest error: ${e.message}\n`)
    }
  }

  function scheduleIngest(fp) {
    const existing = pendingByFile.get(fp)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      pendingByFile.delete(fp)
      ingestOne(fp)
    }, DEBOUNCE_MS)
    pendingByFile.set(fp, timer)
  }

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
      const cutoff = Date.now() - 30 * 60_000
      return files.filter(f => f.mtime > cutoff)
    } catch { return [] }
  }

  function safetySweep() {
    try {
      const active = discoverActiveTranscripts()
      for (const { path: fp } of active) ingestOne(fp)
    } catch (e) {
      process.stderr.write(`[transcript-watch] safety sweep error: ${e.message}\n`)
    }
  }

  setTimeout(safetySweep, 3_000)
  setInterval(safetySweep, SAFETY_POLL_MS)

  try {
    const watcher = fs.watch(projectsRoot, { recursive: true, persistent: true }, (_event, filename) => {
      if (!filename) return
      if (!isWatchable(filename)) return
      const fp = path.join(projectsRoot, filename)
      scheduleIngest(fp)
    })
    watcher.on('error', (err) => {
      process.stderr.write(`[transcript-watch] fs.watch error: ${err.message}\n`)
    })
    process.stderr.write(`[transcript-watch] fs.watch active on ${projectsRoot} (safety sweep every ${SAFETY_POLL_MS / 60_000}min)\n`)
  } catch (e) {
    process.stderr.write(`[transcript-watch] fs.watch setup failed: ${e.message} — relying on safety sweep only\n`)
  }
}

function _runStartupMigrations() {
  // Drop legacy memory_candidates table + clean up episode vectors
  try {
    store.db.exec('DROP TABLE IF EXISTS memory_candidates')
    store.db.prepare("DELETE FROM memory_vectors WHERE entity_type = 'episode'").run()
    process.stderr.write(`[migration] memory_candidates table dropped, episode vectors cleaned\n`)
  } catch (e) {
    process.stderr.write(`[migration] cleanup error: ${e.message}\n`)
  }

  // Chunk sync
  try {
    const synced = store.syncChunksFromClassifications()
    if (synced > 0) process.stderr.write(`[memory-service] synced ${synced} chunks from classifications\n`)
  } catch (e) { process.stderr.write(`[memory-service] chunk sync error: ${e.message}\n`) }

  // Refresh context.md
  try {
    fs.mkdirSync(path.join(DATA_DIR, 'history'), { recursive: true })
    store.writeContextFile()
    store.writeRecentFile({ serverStartedAt })
    process.stderr.write(`[memory-service] context.md refreshed on startup\n`)
  } catch (e) {
    process.stderr.write(`[memory-service] context.md refresh failed: ${e.message}\n`)
  }
}

// ── Full runtime init (store + backfill + cycles + watcher + migrations) ──

async function _initRuntime() {
  await _initStore()
  _runStartupBackfill()
  serverStartedAt = localNow()
  _initTranscriptWatcher()
  _runStartupMigrations()
  _startCycles()
  _initialized = true
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

  // Score and sort
  const { computeFinalScore } = await import('./lib/memory-score-utils.mjs')
  let items = results.map(item => {
    const baseScore = item.base_score ?? 0
    item._finalScore = computeFinalScore(baseScore, item, query)
    return item
  })

  if (sort === 'importance') {
    items.sort((a, b) => b._finalScore - a._finalScore)
  } else {
    items.sort((a, b) => {
      const tsA = a.source_ts || a.updated_at || ''
      const tsB = b.source_ts || b.updated_at || ''
      return tsB.localeCompare(tsA)
    })
  }

  items = items.slice(offset, offset + limit)

  // Render results — chunks and classifications inline, episodes with context
  const lines = []
  const renderedEpisodes = new Set()

  for (const item of items) {
    const ts = String(item.source_ts || item.updated_at || '').slice(0, 16)

    if (item.type === 'chunk' || item.type === 'classification') {
      const topic = item.classification_topic ? ` [${item.classification_topic}]` : ''
      const imp = item.importance ? ` (${item.importance})` : ''
      lines.push(`[${ts}]${topic}${imp} ${String(item.content || '').slice(0, 500)}`)
    } else if (item.type === 'episode' && !renderedEpisodes.has(Number(item.entity_id))) {
      // Show episode with surrounding context (±3 messages)
      const epId = Number(item.entity_id)
      renderedEpisodes.add(epId)
      try {
        const rows = store.db.prepare(`
          SELECT id, ts, role, content FROM episodes
          WHERE id BETWEEN ? AND ? AND kind IN ('message', 'turn')
          ORDER BY id ASC
        `).all(epId - 3, epId + 3)
        if (rows.length > 0) {
          const tsStart = String(rows[0].ts || '').slice(0, 16)
          const tsEnd = String(rows[rows.length - 1].ts || '').slice(0, 16)
          lines.push(`\n[${tsStart}~${tsEnd}]`)
          for (const ep of rows) {
            const prefix = ep.role === 'user' ? 'u' : 'a'
            const marker = ep.id === epId ? '→' : ' '
            renderedEpisodes.add(Number(ep.id))
            lines.push(`${marker} ${prefix}: ${String(ep.content || '').slice(0, 500)}`)
          }
        }
      } catch {
        lines.push(`[${ts}] ${String(item.content || '').slice(0, 500)}`)
      }
    }
  }

  if (lines.length === 0) {
    for (const item of items) {
      const ts = String(item.source_ts || item.updated_at || '').slice(0, 16)
      lines.push(`[${ts}] ${String(item.content || '').slice(0, 500)}`)
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
      lines.push(`[${ts}] ${String(c.content || '').slice(0, 500)}`)
    }
    for (const ep of episodes) {
      const prefix = ep.role === 'user' ? 'u' : 'a'
      lines.push(`[${String(ep.ts || '').slice(0, 16)}] ${prefix}: ${String(ep.content).slice(0, 500)}`)
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
    return `[${String(ep.ts || '').slice(0, 16)}] ${prefix}: ${String(ep.content).slice(0, 500)}`
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
  const pending = store.db.prepare("SELECT COUNT(*) as c FROM episodes WHERE classified = 0 AND role IN ('user','assistant') AND kind = 'message'").get().c
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

  let coreStats = ''
  try {
    const coreRows = store.db.prepare(
      `SELECT status, COUNT(*) as c FROM core_memory GROUP BY status ORDER BY c DESC`
    ).all()
    coreStats = coreRows.map(r => `${r.status}:${r.c}`).join(', ') || 'empty'
  } catch { coreStats = 'n/a' }

  const lines = [
    `episodes: ${episodes}`,
    `classifications: ${classifications} (${tags.map(t => `${t.importance}:${t.c}`).join(', ')})`,
    `core_memory: ${coreStats}`,
    `unclassified: ${pending}`,
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

  if (action === 'health') {
    try {
      const h = store.getHealthStatus()
      return { text: JSON.stringify(h, null, 2) }
    } catch (e) {
      return { text: JSON.stringify({ status: 'error', error: e?.message }), isError: true }
    }
  }
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
    // Find unclassified episodes
    const uncovered = store.db.prepare(`
      SELECT e.id, e.ts, e.day_key, e.role, e.content
      FROM episodes e
      WHERE e.classified = 0
        AND e.kind IN ('message', 'turn')
        AND e.role IN ('user', 'assistant')
        AND LENGTH(e.content) >= 10
        AND e.content NOT LIKE 'You are consolidating%'
        AND e.content NOT LIKE 'You are improving%'
      ORDER BY e.ts DESC
      LIMIT ?
    `).all(backfillLimit)

    if (uncovered.length === 0) {
      return { text: 'Backfill: no unclassified episodes found.' }
    }

    // Run cycle1 with force to process them
    const c1result = await runCycle1(ws, config, { force: true })
    return { text: `Backfill: ${uncovered.length} unclassified episodes. Cycle1: ${JSON.stringify(c1result)}` }
  }
  if (action === 'remember') {
    const topic = String(args.topic ?? '').trim()
    const element = String(args.element ?? '').trim()
    if (!topic || !element) {
      return { text: 'remember requires topic and element', isError: true }
    }
    const ts = new Date().toISOString()
    const dayKey = ts.slice(0, 10)
    const importance = String(args.importance ?? 'fact')

    // 1. Create episode
    const epResult = store.db.prepare(`
      INSERT INTO episodes (ts, day_key, kind, role, content)
      VALUES (?, ?, 'message', 'user', ?)
    `).run(ts, dayKey, `[user_inject] ${topic}: ${element}`)
    const episodeId = epResult.lastInsertRowid

    // 2. Create classification
    const clsResult = store.db.prepare(`
      INSERT INTO classifications (episode_id, ts, day_key, classification, topic, element, state, confidence, importance, status)
      VALUES (?, ?, ?, 'fact', ?, ?, 'user_inject', 1.0, ?, 'active')
    `).run(episodeId, ts, dayKey, topic, element, importance)
    const classificationId = clsResult.lastInsertRowid

    // 3. Insert into core_memory
    store.db.prepare(`
      INSERT INTO core_memory (classification_id, topic, element, importance, final_score, promoted_at, last_seen_at, status)
      VALUES (?, ?, ?, ?, 1.0, ?, ?, 'active')
      ON CONFLICT(classification_id) DO UPDATE SET
        topic = excluded.topic, element = excluded.element,
        importance = excluded.importance, last_seen_at = excluded.last_seen_at, status = 'active'
    `).run(classificationId, topic, element, importance, ts, ts)

    return { text: `Remembered: [${topic}] ${element}` }
  }
  return { text: `unknown memory action: ${action}`, isError: true }
}

// ══════════════════════════════════════════════════════════════════════
//  MCP SERVER (stdio transport — Claude Code tools)
// ══════════════════════════════════════════════════════════════════════

const mcp = new Server(
  { name: 'trib-memory', version: PLUGIN_VERSION },
  { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS_TEXT },
)

// ── Shared tool definitions & handler ────────────────────────────────

const TOOL_DEFS = [
  {
    name: 'memory_cycle',
    title: 'Memory Cycle',
    annotations: { title: 'Memory Cycle', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Run memory management operations: sleep (merged update), flush (consolidate pending), rebuild (recent), prune (cleanup), cycle1 (fast update), backfill (classify old episodes then run cycle1), status.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['sleep', 'flush', 'rebuild', 'rebuild_classifications', 'prune', 'cycle1', 'backfill', 'status', 'remember'], description: 'Memory operation to run. remember: inject into core memory.' },
        topic: { type: 'string', description: 'Topic for remember action (e.g. "user preference", "project rule")' },
        element: { type: 'string', description: 'Content for remember action (e.g. "prefers dark mode")' },
        importance: { type: 'string', description: 'Importance level for remember action (default: fact)' },
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
    description: 'Search past context and memory. Use when user references prior work, decisions, or preferences. Not for external info (use search tool). Storage is automatic — only retrieval is manual. Never write to MEMORY.md or use sqlite directly.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text. Triggers semantic hybrid search.' },
        period: { type: 'string', description: 'Time scope: "last" (previous session), "24h"/"3d"/"7d"/"30d" (relative), "all" (no limit), "2026-04-05" (single date), "2026-04-01~2026-04-05" (date range). Default: 30d when query is set, latest entries when no query.' },
        sort: { type: 'string', enum: ['date', 'importance'], description: 'Sort order: "date" (newest first, reranker skipped) or "importance" (final score, reranker enabled). Default: "date" when period="last", "importance" otherwise.' },
        limit: { type: 'number', default: 30, description: 'Max results to return.' },
        offset: { type: 'number', default: 0, description: 'Skip N results for pagination.' },
      },
      required: [],
    },
  },
]

async function handleToolCall(name, args) {
  try {
    if (name === 'search_memories') {
      const result = await handleRecall(args)
      return {
        content: [{ type: 'text', text: result.text }],
        isError: result.isError || false,
      }
    }

    if (name === 'memory_cycle') {
      const result = await handleCycle(args)
      return {
        content: [{ type: 'text', text: result.text }],
        isError: result.isError || false,
      }
    }

    return {
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
      isError: true,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${name} failed: ${msg}` }],
      isError: true,
    }
  }
}

// MCP adapter: unwrap req envelope for the shared handleToolCall
function _mcpToolHandler(req) {
  return handleToolCall(req.params.name, req.params.arguments ?? {})
}

// ── Register handlers on primary (stdio) MCP server ─────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))
mcp.setRequestHandler(CallToolRequestSchema, _mcpToolHandler)

// ── Factory: create a short-lived MCP server for HTTP requests ──────

function createHttpMcpServer() {
  const s = new Server(
    { name: 'trib-memory', version: PLUGIN_VERSION },
    { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS_TEXT},
  )
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))
  s.setRequestHandler(CallToolRequestSchema, _mcpToolHandler)
  return s
}

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
  // GET /proactive/sources
  if (req.method === 'GET' && req.url === '/proactive/sources') {
    try {
      store.seedProactiveSources()
      sendJson(res, store.getProactiveSources('active'))
    } catch (e) {
      sendError(res, e.message)
    }
    return
  }

  // GET /proactive/context — recent memory for proactive tick
  if (req.method === 'GET' && req.url === '/proactive/context') {
    try {
      const recent = store.db.prepare(`
        SELECT ts, user_name, role, substr(content, 1, 200) as content
        FROM episodes
        WHERE kind = 'message' AND role IN ('user', 'assistant')
        ORDER BY ts DESC LIMIT 20
      `).all()
      const lines = recent.reverse().map(r =>
        `[${r.ts}] ${r.role === 'user' ? 'u' : 'a'}: ${r.content}`
      ).join('\n')
      sendJson(res, { context: lines })
    } catch (e) {
      sendError(res, e.message)
    }
    return
  }

  // POST /proactive/updates — apply source add/remove/score changes
  if (req.method === 'POST' && req.url === '/proactive/updates') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        const updates = JSON.parse(body)
        if (Array.isArray(updates.add)) {
          for (const s of updates.add) {
            store.addProactiveSource(s.category, s.topic, s.query || '')
          }
        }
        if (Array.isArray(updates.remove)) {
          const sources = store.getProactiveSources('active')
          for (const topic of updates.remove) {
            const found = sources.find(s => s.topic === topic)
            if (found && !found.pinned) store.removeProactiveSource(found.id)
          }
        }
        if (updates.scores && typeof updates.scores === 'object') {
          const sources = store.getProactiveSources('active')
          for (const [topic, delta] of Object.entries(updates.scores)) {
            const found = sources.find(s => s.topic === topic)
            if (found) store.updateProactiveScore(found.id, delta > 0)
          }
        }
        sendJson(res, { ok: true })
      } catch (e) {
        sendError(res, e.message)
      }
    })
    return
  }

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

  // ── Tool proxy endpoint (used by proxy-mode instances) ──
  if (req.method === 'POST' && req.url === '/api/tool') {
    try {
      const body = await readBody(req)
      const result = await handleToolCall(body.name, body.arguments ?? {})
      sendJson(res, result)
    } catch (e) {
      sendJson(res, { content: [{ type: 'text', text: `api/tool error: ${e.message}` }], isError: true }, 500)
    }
    return
  }

  // ── Streamable HTTP MCP endpoint ──
  if (req.url === '/mcp') {
    try {
      if (req.method === 'POST') {
        const httpMcp = createHttpMcpServer()
        const httpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        })
        res.on('close', () => {
          httpTransport.close()
          void httpMcp.close()
        })
        await httpMcp.connect(httpTransport)
        const body = await readBody(req)
        await httpTransport.handleRequest(req, res, body)
      } else if (req.method === 'GET') {
        // SSE stream — not needed for stateless mode
        sendJson(res, { error: 'SSE not supported in stateless mode' }, 405)
      } else if (req.method === 'DELETE') {
        // Session termination — not applicable in stateless mode
        sendJson(res, { error: 'No session management in stateless mode' }, 405)
      } else {
        sendJson(res, { error: 'Method not allowed' }, 405)
      }
    } catch (e) {
      process.stderr.write(`[memory-service] /mcp error: ${e.stack || e.message}\n`)
      if (!res.headersSent) sendError(res, e.message)
    }
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, { error: 'Method not allowed' }, 405)
    return
  }

  const body = await readBody(req)

  try {

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

// ── Module exports (for unified server) ──────────────────────────────

export { TOOL_DEFS }
export { MEMORY_INSTRUCTIONS_TEXT as instructions }

export async function init() {
  if (_initialized) return
  await _initRuntime()
  // Start HTTP server for episode append, proactive endpoints (channels depends on it)
  await _startHttpServer()
  process.stderr.write('[memory-service] init() complete (unified mode)\n')
  try {
    const h = store.getHealthStatus()
    process.stderr.write(`[memory] health=${h.status} vec=${h.vec_enabled ? (h.vec_ready ? 'ready' : 'not-ready') : 'off'} embed=${h.embedding.model_id || 'n/a'}:${h.embedding.dims || '?'}d reranker=${h.reranker.model_id || 'n/a'}@${h.reranker.device || '?'} reindex=${h.reindex_required ? 'yes' : 'no'} episodes=${h.counts.episodes} vectors=${h.counts.vectors_total} unclassified=${h.unclassified_episodes}\n`)
  } catch {}
}

export { handleToolCall }

export async function start() {
  _startCycles()
}

export async function stop() {
  _stopCycles()
  void stopLlmWorker().catch(() => {})
  if (httpServer) {
    await new Promise(resolve => httpServer.close(resolve))
  }
}

// ══════════════════════════════════════════════════════════════════════
//  STARTUP (standalone mode)
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

function _startHttpServer() {
  return new Promise((resolve, reject) => {
    function tryListen() {
      httpServer.listen(activePort, '127.0.0.1', () => {
        writePortFile(activePort)
        process.stderr.write(`[memory-service] HTTP listening on 127.0.0.1:${activePort}\n`)
        resolve(activePort)
      })
    }

    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && activePort < MAX_PORT) {
        activePort++
        tryListen()
      } else if (err.code === 'EADDRINUSE') {
        process.stderr.write(`[memory-service] ports ${BASE_PORT}-${MAX_PORT} all busy, using OS-assigned port\n`)
        activePort = 0
        tryListen()
      } else {
        process.stderr.write(`[memory-service] HTTP fatal: ${err.message}\n`)
        reject(err)
      }
    })

    tryListen()
  })
}

if (process.env.TRIB_UNIFIED !== '1') {

// ── Decide: proxy or primary ────────────────────────────────────────

const existingPort = await isExistingServerHealthy()
if (existingPort) {
  await runProxyMode(existingPort)
  process.exit(0)
}

// No healthy server — start as primary
acquireLock()
await _initRuntime()
await _startHttpServer()

// ── MCP stdio transport ──────────────────────────────────────────────

const transport = new StdioServerTransport()
await mcp.connect(transport)
process.stderr.write('[memory-service] MCP stdio connected\n')

// ── Graceful shutdown ────────────────────────────────────────────────

function shutdown() {
  process.stderr.write('[memory-service] shutting down...\n')
  _stopCycles()
  void stopLlmWorker().catch(() => {})
  removePortFile()
  releaseLock()
  void mcp.close()
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

} // end standalone guard
