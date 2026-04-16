#!/usr/bin/env node
process.removeAllListeners('warning')
process.on('warning', () => {})

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

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
try {
  const { env } = await import('@huggingface/transformers')
  env.backends.onnx.wasm.numThreads = 1
} catch {}

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import {
  openDatabase,
  closeDatabase,
  isBootstrapComplete,
  getMetaValue,
  setMetaValue,
  cleanMemoryText,
} from './lib/memory.mjs'
import { configureEmbedding, embedText, getEmbeddingDims } from './lib/embedding-provider.mjs'
import { startLlmWorker, stopLlmWorker } from './lib/llm-worker-host.mjs'
import { runCycle1, runCycle2, parseInterval, syncRootEmbedding } from './lib/memory-cycle.mjs'
import { searchRelevantHybrid } from './lib/memory-recall-store.mjs'
import { retrieveEntries } from './lib/memory-retrievers.mjs'
import { resetEmbeddingIndex, pruneOldEntries } from './lib/memory-maintenance-store.mjs'
import { computeEntryScore } from './lib/memory-score.mjs'
import { runFullBackfill } from './lib/memory-ops-policy.mjs'

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || process.argv[2]
  || (() => {
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

import { execFileSync } from 'child_process'
const LOCK_FILE = path.join(DATA_DIR, '.memory-service.lock')

const RUNTIME_DIR = path.join(os.tmpdir(), 'trib-memory')
try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }) } catch {}
const PORT_FILE = path.join(RUNTIME_DIR, 'memory-port')
const BASE_PORT = 3350
const MAX_PORT = 3357

const MEMORY_INSTRUCTIONS_TEXT = [
  'CRITICAL: invoke the `search_memories` tool at session start and before any reference to prior context.',
  'Order: search_memories (past context) → search (external info) → codebase (Grep/Glob/Read). Never skip search_memories when past context may apply.',
  'When in doubt, call search_memories first — cost is near zero, missing context is expensive.',
].join('\n')

const PROXY_TOOL_DEFS = [
  { name: 'memory', description: 'Run memory management operations.', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } },
  { name: 'search_memories', description: 'Search past context and memory.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: [] } },
]

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
  } catch {}
  return null
}

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
  await new Promise((resolve) => { proxyMcp.onclose = resolve })
}

function killPreviousServer(pid) {
  if (pid <= 0 || pid === process.pid) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8', timeout: 5000, stdio: 'ignore' })
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
      const lockedPid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim())
      if (lockedPid > 0 && lockedPid !== process.pid) {
        killPreviousServer(lockedPid)
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

function readMainConfig() {
  const memoryConfigPath = path.join(DATA_DIR, 'memory-config.json')
  try {
    const raw = JSON.parse(fs.readFileSync(memoryConfigPath, 'utf8'))
    if (raw.enabled !== undefined || raw.cycle1 || raw.cycle2) return raw
  } catch {}
  const mainConfigPath = path.join(DATA_DIR, 'config.json')
  try {
    const raw = JSON.parse(fs.readFileSync(mainConfigPath, 'utf8'))
    if (raw.memory && (raw.memory.cycle1 || raw.memory.enabled !== undefined)) return raw.memory
    return raw
  } catch { return {} }
}

let db = null
let mainConfig = null
let _cycleInterval = null
let _startupTimeout = null
let _initialized = false
let _bootTimestamp = null
let _transcriptOffsets = new Map()

const TRANSCRIPT_OFFSETS_KEY = 'state.transcript_offsets'
const CYCLE_LAST_RUN_KEY = 'state.cycle_last_run'

async function _initStore() {
  mainConfig = readMainConfig()
  const embeddingConfig = mainConfig?.embedding
  if (embeddingConfig?.provider || embeddingConfig?.ollamaModel || embeddingConfig?.dtype) {
    configureEmbedding({
      provider: embeddingConfig.provider,
      ollamaModel: embeddingConfig.ollamaModel,
      dtype: embeddingConfig.dtype,
    })
  }
  const dims = Number(getEmbeddingDims())
  db = openDatabase(DATA_DIR, dims)
  if (!isBootstrapComplete(db)) {
    throw new Error('memory-service: bootstrap not complete after openDatabase')
  }
  startLlmWorker()
  _bootTimestamp = Date.now()
  loadTranscriptOffsets()
}

function loadTranscriptOffsets() {
  try {
    const raw = getMetaValue(db, TRANSCRIPT_OFFSETS_KEY, '{}')
    const obj = JSON.parse(raw)
    _transcriptOffsets = new Map(Object.entries(obj))
  } catch {
    _transcriptOffsets = new Map()
  }
}

function persistTranscriptOffsets() {
  try {
    const obj = Object.fromEntries(_transcriptOffsets)
    setMetaValue(db, TRANSCRIPT_OFFSETS_KEY, JSON.stringify(obj))
  } catch (e) {
    process.stderr.write(`[memory] persist transcript offsets failed: ${e.message}\n`)
  }
}

function getCycleLastRun() {
  try {
    const raw = getMetaValue(db, CYCLE_LAST_RUN_KEY, '{}')
    const obj = JSON.parse(raw)
    return { cycle1: Number(obj.cycle1) || 0, cycle2: Number(obj.cycle2) || 0 }
  } catch { return { cycle1: 0, cycle2: 0 } }
}

function setCycleLastRun(kind, ts) {
  const cur = getCycleLastRun()
  cur[kind] = ts
  setMetaValue(db, CYCLE_LAST_RUN_KEY, JSON.stringify(cur))
}

function ingestTranscriptFile(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) return 0
  const stat = fs.statSync(transcriptPath)
  const sessionUuid = path.basename(transcriptPath, '.jsonl')
  const prev = _transcriptOffsets.get(transcriptPath) ?? { bytes: 0, lineIndex: 0 }
  if (stat.size < prev.bytes) {
    prev.bytes = 0
    prev.lineIndex = 0
  }
  if (stat.size <= prev.bytes) return 0

  const fd = fs.openSync(transcriptPath, 'r')
  const buf = Buffer.alloc(stat.size - prev.bytes)
  fs.readSync(fd, buf, 0, buf.length, prev.bytes)
  fs.closeSync(fd)
  prev.bytes = stat.size
  const lines = buf.toString('utf8').split('\n').filter(Boolean)

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO entries(ts, role, content, source_ref, session_id)
    VALUES (?, ?, ?, ?, ?)
  `)

  let count = 0
  let index = prev.lineIndex
  for (const line of lines) {
    index += 1
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    const role = parsed.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = firstTextContent(parsed.message?.content)
    if (!content || !content.trim()) continue
    const cleaned = cleanMemoryText(content)
    if (!cleaned) continue
    const tsMs = parseTsToMs(parsed.timestamp ?? parsed.ts ?? Date.now())
    const sourceRef = `transcript:${sessionUuid}#${index}`
    try {
      const result = insertStmt.run(tsMs, role, cleaned, sourceRef, sessionUuid)
      if (result.changes > 0) count += 1
    } catch (e) {
      process.stderr.write(`[transcript-watch] insert error (${sourceRef}): ${e.message}\n`)
    }
  }
  prev.lineIndex = index
  _transcriptOffsets.set(transcriptPath, prev)
  persistTranscriptOffsets()
  return count
}

function firstTextContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const item of content) {
    if (typeof item === 'string') return item
    if (item?.type === 'text' && typeof item.text === 'string') return item.text
  }
  return ''
}

function parseTsToMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : Date.now()
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
      const n = ingestTranscriptFile(fp)
      if (n > 0) {
        process.stderr.write(`[transcript-watch] ingested ${n} entries from ${path.basename(fp)}\n`)
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
    if (!fs.existsSync(projectsRoot)) return []
    const files = []
    try {
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
    } catch {}
    const cutoff = Date.now() - 30 * 60_000
    return files.filter(f => f.mtime > cutoff)
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

// Smart Bridge maintenance LLM — routes through anthropic-oauth with 1h cache
// when available, falls back to native callLLM otherwise. Toggle via
// agent-config.json: { bridge: { smartMaintenance: false } } to disable.
// Shared between automatic checkCycles() and every manual cycle1/cycle2
// action below — prior to v0.6.45 manual actions passed {} and silently
// dropped to the legacy callLLM path.
async function _buildCycleOptions() {
  const cycleOptions = {}
  try {
    const { loadConfig } = await import('../agent/orchestrator/config.mjs')
    const agentCfg = loadConfig()
    const smartEnabled = agentCfg?.bridge?.smartMaintenance !== false
    if (smartEnabled) {
      const { makeMaintenanceLlm } = await import('../agent/orchestrator/smart-bridge/maintenance-llm.mjs')
      cycleOptions.llm = makeMaintenanceLlm({ taskType: 'maintenance' })
    }
  } catch (e) {
    // Fallback path is the existing native callLLM — no-op.
  }
  return cycleOptions
}

async function checkCycles() {
  if (mainConfig?.enabled === false) return

  const cycle1Ms = parseInterval(mainConfig?.cycle1?.interval || '10m')
  const cycle2Ms = parseInterval(mainConfig?.cycle2?.interval || '1h')

  const now = Date.now()
  const last = getCycleLastRun()

  // Phase B §5 — cache-keeper health check. If cycle1 is more than one full
  // interval past due (e.g. process was paused, network was down), emit a
  // warning so operators notice before Pool B's Anthropic shard goes cold.
  // The normal "run when due" branch below still fires; this is purely
  // observability.
  const cycle1OverdueMs = now - last.cycle1 - cycle1Ms
  if (cycle1OverdueMs > cycle1Ms) {
    process.stderr.write(
      `[cycle1] overdue by ${Math.floor(cycle1OverdueMs / 60000)}min `
      + `(last=${new Date(last.cycle1).toISOString()}). Pool B Anthropic shard may be cold.\n`
    )
  }

  const cycleOptions = await _buildCycleOptions()

  if (now - last.cycle1 >= cycle1Ms) {
    try {
      const result = await runCycle1(db, mainConfig?.cycle1 || {}, cycleOptions)
      setCycleLastRun('cycle1', Date.now())
      process.stderr.write(`[cycle1] completed chunks=${result?.chunks ?? 0} processed=${result?.processed ?? 0}\n`)
    } catch (e) {
      process.stderr.write(`[cycle1] error: ${e.message}\n`)
    }
  }

  if (now - last.cycle2 >= cycle2Ms) {
    try {
      await runCycle2(db, mainConfig?.cycle2 || {}, cycleOptions)
      setCycleLastRun('cycle2', Date.now())
      process.stderr.write(`[cycle2] completed\n`)
    } catch (e) {
      process.stderr.write(`[cycle2] error: ${e.message}\n`)
    }
  }
}

function _startCycles() {
  if (_cycleInterval) return
  _cycleInterval = setInterval(() => { void checkCycles() }, 60_000)
  _startupTimeout = setTimeout(() => { void checkCycles() }, 30_000)
}

function _stopCycles() {
  if (_cycleInterval) { clearInterval(_cycleInterval); _cycleInterval = null }
  if (_startupTimeout) { clearTimeout(_startupTimeout); _startupTimeout = null }
}

async function _initRuntime() {
  await _initStore()
  _initTranscriptWatcher()
  _startCycles()
  _initialized = true
  import('./lib/embedding-provider.mjs').then(m => m.warmupEmbeddingProvider()).catch(() => {})
}

function fmtDateOnly(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parsePeriod(period, hasQuery) {
  if (!period && hasQuery) period = '30d'
  if (!period) return null
  if (period === 'all') return null
  if (period === 'last') return { mode: 'last' }
  const relMatch = period.match(/^(\d+)(h|d)$/)
  if (relMatch) {
    const n = parseInt(relMatch[1])
    const unit = relMatch[2]
    const now = new Date()
    if (unit === 'h') {
      const start = new Date(now.getTime() - n * 3600_000)
      return { startMs: start.getTime(), endMs: now.getTime() }
    }
    const start = new Date(now)
    start.setDate(start.getDate() - n)
    return { startMs: start.getTime(), endMs: now.getTime() }
  }
  const rangeMatch = period.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/)
  if (rangeMatch) {
    return {
      startMs: Date.parse(rangeMatch[1] + 'T00:00:00'),
      endMs:   Date.parse(rangeMatch[2] + 'T23:59:59.999'),
    }
  }
  const dateMatch = period.match(/^(\d{4}-\d{2}-\d{2})$/)
  if (dateMatch) {
    return {
      startMs: Date.parse(dateMatch[1] + 'T00:00:00'),
      endMs:   Date.parse(dateMatch[1] + 'T23:59:59.999'),
      exact: true,
    }
  }
  return null
}

function formatTs(tsMs) {
  const n = Number(tsMs)
  if (Number.isFinite(n) && n > 1e12) {
    return new Date(n).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16) + ' KST'
  }
  return String(tsMs ?? '').slice(0, 16)
}

async function handleSearch(args) {
  const query = String(args.query ?? '').trim()
  const period = String(args.period ?? '').trim() || undefined
  const limit = Math.max(1, Number(args.limit ?? 30))
  const offset = Math.max(0, Number(args.offset ?? 0))
  const sort = args.sort != null ? String(args.sort) : 'importance'
  const includeMembers = Boolean(args.includeMembers)
  const temporal = parsePeriod(period, Boolean(query))

  if (query) {
    const queryVector = await embedText(query).catch(() => null)
    const results = await searchRelevantHybrid(db, query, {
      limit: limit + offset,
      queryVector: Array.isArray(queryVector) ? queryVector : null,
      includeMembers,
    })
    let filtered = results
    if (temporal?.startMs != null) {
      filtered = filtered.filter(r => Number(r.ts) >= temporal.startMs && Number(r.ts) <= temporal.endMs)
    }
    if (sort === 'date') {
      filtered.sort((a, b) => Number(b.ts) - Number(a.ts))
    } else {
      filtered.sort((a, b) => (Number(b.score ?? 0) - Number(a.score ?? 0)) || ((b.rrf ?? 0) - (a.rrf ?? 0)))
    }
    const sliced = filtered.slice(offset, offset + limit)
    return { text: renderEntryLines(sliced) }
  }

  const filters = { limit: limit + offset }
  if (temporal?.startMs != null) { filters.ts_from = temporal.startMs; filters.ts_to = temporal.endMs }
  if (temporal?.mode === 'last' && _bootTimestamp) {
    filters.ts_to = _bootTimestamp - 1
  }
  if (includeMembers) filters.includeMembers = true
  const rows = retrieveEntries(db, filters)
  const sliced = rows.slice(offset, offset + limit)
  return { text: renderEntryLines(sliced) }
}

function renderEntryLines(rows) {
  if (!rows || rows.length === 0) return '(no results)'
  const lines = []
  for (const r of rows) {
    const ts = formatTs(r.ts)
    const cat = r.category ? `[${r.category}] ` : ''
    const element = r.element ?? ''
    const summary = r.summary ?? ''
    const head = element || summary
      ? `${cat}${element}${summary ? ' — ' + summary : ''}`
      : (cleanMemoryText(String(r.content ?? '')).slice(0, 300))
    lines.push(`[${ts}] ${head.slice(0, 500)}`)
    if (Array.isArray(r.members) && r.members.length > 0) {
      for (const m of r.members) {
        const mTs = formatTs(m.ts)
        const prefix = m.role === 'user' ? 'u' : m.role === 'assistant' ? 'a' : (m.role || '?')
        lines.push(`  [${mTs}] ${prefix}: ${cleanMemoryText(String(m.content ?? '')).slice(0, 200)}`)
      }
    }
  }
  return lines.join('\n')
}

function entryStats() {
  const total = db.prepare(`SELECT COUNT(*) c FROM entries`).get().c
  const roots = db.prepare(`SELECT COUNT(*) c FROM entries WHERE is_root = 1`).get().c
  const unclassified = db.prepare(`SELECT COUNT(*) c FROM entries WHERE chunk_root IS NULL`).get().c
  const byStatus = db.prepare(`
    SELECT status, COUNT(*) c FROM entries WHERE is_root = 1 GROUP BY status
  `).all()
  const byCategory = db.prepare(`
    SELECT category, COUNT(*) c FROM entries
    WHERE is_root = 1 AND status = 'active'
    GROUP BY category ORDER BY c DESC
  `).all()
  return { total, roots, unclassified, byStatus, byCategory }
}

async function handleMemoryAction(args) {
  const action = String(args.action ?? '')
  const config = readMainConfig()

  if (action === 'status') {
    const stats = entryStats()
    const last = getCycleLastRun()
    const dims = Number(getMetaValue(db, 'embedding.current_dims', '0'))
    const vecReady = Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE name='vec_entries'`).get())
    const lastCycle1Ago = last.cycle1 ? `${Math.round((Date.now() - last.cycle1) / 60000)}m ago` : 'never'
    const lastCycle2Ago = last.cycle2 ? `${Math.round((Date.now() - last.cycle2) / 60000)}m ago` : 'never'
    const lines = [
      `entries: total=${stats.total} roots=${stats.roots} unclassified=${stats.unclassified}`,
      `status: ${stats.byStatus.map(r => `${r.status ?? 'NULL'}:${r.c}`).join(', ') || 'empty'}`,
      `categories(active): ${stats.byCategory.map(r => `${r.category ?? 'NULL'}:${r.c}`).join(', ') || 'empty'}`,
      `vec_entries: ${vecReady ? 'ready' : 'missing'} dims=${dims}`,
      `bootstrap: ${isBootstrapComplete(db) ? 'complete' : 'incomplete'}`,
      `last_cycle1: ${lastCycle1Ago}`,
      `last_cycle2: ${lastCycle2Ago}`,
    ]
    return { text: lines.join('\n') }
  }

  if (action === 'cycle1') {
    const cycleOptions = await _buildCycleOptions()
    const result = await runCycle1(db, config?.cycle1 || {}, cycleOptions)
    setCycleLastRun('cycle1', Date.now())
    return { text: `cycle1: chunks=${result.chunks} processed=${result.processed} skipped=${result.skipped}` }
  }

  if (action === 'cycle2' || action === 'sleep') {
    const cycleOptions = await _buildCycleOptions()
    const result = await runCycle2(db, config?.cycle2 || {}, cycleOptions)
    setCycleLastRun('cycle2', Date.now())
    return { text: `cycle2: ${JSON.stringify(result)}` }
  }

  if (action === 'flush') {
    const cycleOptions = await _buildCycleOptions()
    const r1 = await runCycle1(db, config?.cycle1 || {}, cycleOptions)
    setCycleLastRun('cycle1', Date.now())
    const r2 = await runCycle2(db, config?.cycle2 || {}, cycleOptions)
    setCycleLastRun('cycle2', Date.now())
    return { text: `flush: cycle1 chunks=${r1.chunks} processed=${r1.processed}, cycle2 ${JSON.stringify(r2)}` }
  }

  if (action === 'rebuild') {
    db.prepare(`UPDATE entries SET chunk_root = NULL, is_root = 0 WHERE chunk_root = id`).run()
    db.prepare(`UPDATE entries SET chunk_root = NULL WHERE is_root = 0`).run()
    db.prepare(`
      UPDATE entries
      SET element = NULL, category = NULL, summary = NULL,
          status = NULL, score = NULL, last_seen_at = NULL,
          embedding = NULL, summary_hash = NULL
      WHERE is_root = 1 OR (chunk_root IS NULL)
    `).run()
    const cycleOptions = await _buildCycleOptions()
    const r1 = await runCycle1(db, config?.cycle1 || {}, cycleOptions)
    const r2 = await runCycle2(db, config?.cycle2 || {}, cycleOptions)
    setCycleLastRun('cycle1', Date.now())
    setCycleLastRun('cycle2', Date.now())
    return { text: `rebuild: cycle1 chunks=${r1.chunks} processed=${r1.processed}, cycle2 ${JSON.stringify(r2)}` }
  }

  if (action === 'prune') {
    const days = Math.max(1, Number(args.maxDays ?? 30))
    const result = pruneOldEntries(db, days)
    return { text: `prune: deleted ${result.deleted} unclassified entries older than ${days} days` }
  }

  if (action === 'backfill') {
    const window = args.window != null ? String(args.window) : '7d'
    const scope = args.scope != null ? String(args.scope) : 'all'
    const limit = args.limit != null ? Math.max(1, Number(args.limit)) : null
    const result = await runFullBackfill(db, {
      window,
      scope,
      limit,
      config,
      ingestTranscriptFile,
      runCycle1,
      runCycle2,
    })
    setCycleLastRun('cycle1', Date.now())
    setCycleLastRun('cycle2', Date.now())
    return {
      text: `backfill: window=${result.window} scope=${result.scope} files=${result.files} ingested=${result.ingested} cycle1_iters=${result.cycle1_iters} promoted=${result.promoted} unclassified=${result.unclassified}`,
    }
  }

  if (action === 'remember') {
    const element = String(args.element ?? '').trim()
    const category = String(args.category ?? args.importance ?? 'fact').trim().toLowerCase()
    const summary = String(args.summary ?? args.element ?? '').trim()
    if (!element || !summary) {
      return { text: 'remember requires element and summary', isError: true }
    }
    const VALID = new Set(['rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue'])
    if (!VALID.has(category)) {
      return { text: `remember: invalid category "${category}". Valid: ${[...VALID].join(', ')}`, isError: true }
    }
    const nowMs = Date.now()
    const sourceRef = `manual:${nowMs}-${process.pid}`
    db.exec('BEGIN')
    try {
      const result = db.prepare(`
        INSERT INTO entries(ts, role, content, source_ref, session_id)
        VALUES (?, 'system', ?, ?, NULL)
      `).run(nowMs, element + ' — ' + summary, sourceRef)
      const newId = Number(result.lastInsertRowid)
      const score = computeEntryScore(category, nowMs, nowMs)
      db.prepare(`
        UPDATE entries
        SET chunk_root = ?, is_root = 1, element = ?, category = ?, summary = ?,
            status = 'active', score = ?, last_seen_at = ?
        WHERE id = ?
      `).run(newId, element, category, summary, score, nowMs, newId)
      db.exec('COMMIT')
      await syncRootEmbedding(db, newId)
      return { text: `remembered (id=${newId}): [${category}] ${element} — ${summary.slice(0, 200)}` }
    } catch (e) {
      try { db.exec('ROLLBACK') } catch {}
      return { text: `remember failed: ${e.message}`, isError: true }
    }
  }

  if (action === 'forget') {
    const rawId = args.id
    const rawElement = args.element
    const id = rawId != null && rawId !== '' ? Number(rawId) : null
    const elementQuery = rawElement != null ? String(rawElement).trim() : ''

    if ((id == null || !Number.isFinite(id)) && !elementQuery) {
      return { text: 'forget requires id or element', isError: true }
    }

    if (id != null && Number.isFinite(id) && id > 0) {
      const info = db.prepare(
        `SELECT category, element, status, is_root FROM entries WHERE id = ?`,
      ).get(id)
      if (!info) return { text: `forget: no entry with id=${id}`, isError: true }
      if (info.is_root !== 1) return { text: `forget: id=${id} is not a root`, isError: true }
      if (info.status !== 'active') return { text: `forget: id=${id} status=${info.status ?? 'NULL'} (not active)`, isError: true }
      const result = db.prepare(
        `UPDATE entries SET status = 'archived' WHERE id = ? AND is_root = 1 AND status = 'active'`,
      ).run(id)
      if (result.changes === 0) return { text: `forget: id=${id} no change`, isError: true }
      return { text: `forgotten (id=${id}): [${info.category ?? '-'}] ${info.element ?? ''}` }
    }

    const matches = db.prepare(
      `SELECT id, category, element FROM entries
       WHERE is_root = 1 AND status = 'active' AND element LIKE ?
       ORDER BY id ASC`,
    ).all(`%${elementQuery}%`)
    if (matches.length === 0) return { text: `forget: no active root matches "${elementQuery}"`, isError: true }
    if (matches.length > 1) {
      const preview = matches.slice(0, 10).map(r => `id=${r.id} "${r.element}"`).join(', ')
      const extra = matches.length > 10 ? ` (+${matches.length - 10} more)` : ''
      return { text: `forget: ${matches.length} candidates — ${preview}${extra}`, isError: true }
    }
    const target = matches[0]
    db.prepare(`UPDATE entries SET status = 'archived' WHERE id = ?`).run(target.id)
    return { text: `forgotten (id=${target.id}): [${target.category}] ${target.element}` }
  }

  return { text: `unknown memory action: ${action}`, isError: true }
}

const TOOL_DEFS = [
  {
    name: 'memory',
    title: 'Memory Operations',
    annotations: { title: 'Memory Operations', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Run memory management operations on the unified entries store. Actions: status (counts/health), cycle1 (chunk + classify), cycle2/sleep (promote + cap), flush (cycle1+cycle2), rebuild (reset roots and re-classify), prune (delete old unclassified), backfill (ingest transcripts within window then drain cycle1 and run cycle2), remember (insert active root entry), forget (archive an active root by id or element match).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'cycle1', 'cycle2', 'sleep', 'flush', 'rebuild', 'prune', 'backfill', 'remember', 'forget'] },
        element: { type: 'string', description: 'Short subject label (5-10 words). Required for remember.' },
        summary: { type: 'string', description: 'Refined summary (1-3 sentences). Required for remember.' },
        category: { type: 'string', description: 'One of: rule, constraint, decision, fact, goal, preference, task, issue. Default: fact.' },
        maxDays: { type: 'number', description: 'For prune: delete unclassified entries older than this many days (default 30).' },
        id: { type: 'number', description: 'For forget: target active root id.' },
        limit: { type: 'number', description: 'For backfill: optional cap on transcript files to scan (unlimited by default).' },
        window: { type: 'string', description: 'For backfill: time window (1d/3d/7d/30d/all). Default 7d.' },
        scope: { type: 'string', description: 'For backfill: all or workspace. Default all.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'search_memories',
    title: 'Search Memories',
    annotations: { title: 'Search Memories', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Search past context and memory. Returns root entries by default. Use when user references prior work, decisions, or preferences. Storage is automatic — only retrieval is manual.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text. Triggers hybrid search (vec_entries KNN + entries_fts BM25).' },
        period: { type: 'string', description: 'Time scope: "last" (before this session), "24h"/"3d"/"7d"/"30d" (relative), "all", "2026-04-05" (single day), "2026-04-01~2026-04-05" (range). Default: 30d when query set, latest entries otherwise.' },
        sort: { type: 'string', enum: ['date', 'importance'], description: 'date (newest first) or importance (score desc).' },
        limit: { type: 'number', default: 30 },
        offset: { type: 'number', default: 0 },
        includeMembers: { type: 'boolean', description: 'Include chunk member entries inline.' },
      },
      required: [],
    },
  },
]

async function handleToolCall(name, args) {
  try {
    if (name === 'search_memories') {
      const result = await handleSearch(args || {})
      return { content: [{ type: 'text', text: result.text }], isError: result.isError || false }
    }
    if (name === 'memory') {
      const result = await handleMemoryAction(args || {})
      return { content: [{ type: 'text', text: result.text }], isError: result.isError || false }
    }
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${name} failed: ${msg}` }], isError: true }
  }
}

const mcp = new Server(
  { name: 'trib-memory', version: PLUGIN_VERSION },
  { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS_TEXT },
)
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))
mcp.setRequestHandler(CallToolRequestSchema, (req) => handleToolCall(req.params.name, req.params.arguments ?? {}))

function createHttpMcpServer() {
  const s = new Server(
    { name: 'trib-memory', version: PLUGIN_VERSION },
    { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS_TEXT },
  )
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))
  s.setRequestHandler(CallToolRequestSchema, (req) => handleToolCall(req.params.name, req.params.arguments ?? {}))
  return s
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) { resolve({}); return }
      try { resolve(JSON.parse(raw)) }
      catch (error) {
        const e = new Error(`invalid JSON body: ${error.message}`)
        e.statusCode = 400
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data)
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
  if (req.method === 'POST' && req.url === '/session-reset') {
    _bootTimestamp = Date.now()
    sendJson(res, { ok: true, bootTimestamp: _bootTimestamp })
    return
  }
  if (req.method === 'POST' && req.url === '/rebind') {
    _bootTimestamp = Date.now()
    sendJson(res, { ok: true })
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    try {
      const stats = entryStats()
      sendJson(res, {
        status: 'ok',
        bootstrap: isBootstrapComplete(db),
        entries: stats.total,
        roots: stats.roots,
        unclassified: stats.unclassified,
      })
    } catch (e) { sendError(res, e.message) }
    return
  }

  if (req.method === 'POST' && req.url === '/api/tool') {
    try {
      const body = await readBody(req)
      const result = await handleToolCall(body.name, body.arguments ?? {})
      sendJson(res, result)
    } catch (e) {
      sendJson(res, { content: [{ type: 'text', text: `api/tool error: ${e.message}` }], isError: true }, Number(e?.statusCode) || 500)
    }
    return
  }

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
      } else {
        sendJson(res, { error: 'Method not allowed' }, 405)
      }
    } catch (e) {
      process.stderr.write(`[memory-service] /mcp error: ${e.stack || e.message}\n`)
      if (!res.headersSent) sendError(res, e.message, Number(e?.statusCode) || 500)
    }
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, { error: 'Method not allowed' }, 405)
    return
  }

  let body
  try { body = await readBody(req) }
  catch (e) { sendError(res, e.message, Number(e?.statusCode) || 500); return }

  try {
    if (req.url === '/entry') {
      const role = String(body.role ?? 'user')
      const content = String(body.content ?? '')
      const sourceRef = String(body.sourceRef ?? `manual:${Date.now()}-${process.pid}`)
      const sessionId = body.sessionId ?? null
      const tsMs = parseTsToMs(body.ts ?? Date.now())
      if (!content) { sendJson(res, { error: 'content required' }, 400); return }
      try {
        const result = db.prepare(`
          INSERT OR IGNORE INTO entries(ts, role, content, source_ref, session_id)
          VALUES (?, ?, ?, ?, ?)
        `).run(tsMs, role, content, sourceRef, sessionId)
        sendJson(res, { ok: true, id: Number(result.lastInsertRowid), changes: Number(result.changes) })
      } catch (e) {
        sendJson(res, { error: e.message }, 500)
      }
      return
    }

    if (req.url === '/ingest-transcript') {
      const filePath = body.filePath
      if (!filePath) { sendJson(res, { error: 'filePath required' }, 400); return }
      try {
        const n = ingestTranscriptFile(filePath)
        sendJson(res, { ok: true, ingested: n })
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

export { TOOL_DEFS, handleToolCall }
export { MEMORY_INSTRUCTIONS_TEXT as instructions }

export async function init() {
  if (_initialized) return
  await _initRuntime()
  await _startHttpServer()
  if (process.env.TRIB_WORKER_MODE === '1' && process.send) {
    process.send({ type: 'ready' })
  }
  process.stderr.write(`[memory-service] init() complete (entries unified mode, version=${PLUGIN_VERSION})\n`)
}

export async function start() { _startCycles() }

export async function stop() {
  _stopCycles()
  void stopLlmWorker().catch(() => {})
  if (httpServer) await new Promise(resolve => httpServer.close(resolve))
  closeDatabase(DATA_DIR)
  releaseLock()
  removePortFile()
}

function writePortFile(port) {
  try { fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true }) } catch {}
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

if (process.env.TRIB_WORKER_MODE === '1' && process.send) {
  process.on('message', async (msg) => {
    if (msg.type !== 'call' || !msg.callId) return
    try {
      const result = await handleToolCall(msg.name, msg.args || {})
      process.send({ type: 'result', callId: msg.callId, result })
    } catch (e) {
      process.send({ type: 'result', callId: msg.callId, error: e.message })
    }
  })
  init().catch(e => {
    process.stderr.write(`[memory-worker] init failed: ${e.message}\n`)
  })
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  ;(async () => {
    const existing = await isExistingServerHealthy()
    if (existing) {
      await runProxyMode(existing)
      process.exit(0)
    }
    acquireLock()
    process.on('exit', releaseLock)
    process.on('SIGINT', () => { stop().finally(() => process.exit(0)) })
    process.on('SIGTERM', () => { stop().finally(() => process.exit(0)) })
    await init()
    const transport = new StdioServerTransport()
    await mcp.connect(transport)
    await new Promise((resolve) => { mcp.onclose = resolve })
    await stop()
  })().catch((err) => {
    process.stderr.write(`[memory-service] startup failed: ${err.stack || err.message}\n`)
    process.exit(1)
  })
}
