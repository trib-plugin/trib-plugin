#!/usr/bin/env node
/**
 * trib-plugin — MCP server entry point.
 *
 * Four modules (channels, memory, search, agent) exposed over a single
 * MCP server. Tool routing is driven by the static manifest in tools.json,
 * which records the owning module for every tool.
 *
 * Module lifecycle:
 *   • memory — eager init right after the MCP handshake completes,
 *     because channels depends on it for episode delivery.
 *   • channels — eager init (runs background workers: Discord gateway,
 *     scheduler, webhook, event pipeline). Started after memory is ready.
 *   • search / agent — eager init after MCP handshake.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { fork } from 'child_process'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, watch as fsWatch } from 'fs'
import { join, resolve as pathResolve } from 'path'
import { pathToFileURL } from 'url'
import { createRequire } from 'module'

// ── Environment (required) ───────────────────────────────────────────
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA
if (!PLUGIN_ROOT || !PLUGIN_DATA) {
  throw new Error('trib-plugin: CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA must be set')
}
mkdirSync(PLUGIN_DATA, { recursive: true })

globalThis.__tribFastEntry = true

// ── Unified config sync ────────────────────────────────────────────
// trib-config.json is the single source. On boot, split into individual
// files so each module can read its own file without changes.
try {
  const tribCfgPath = join(PLUGIN_DATA, 'trib-config.json')
  const SECTION_FILES = { channels: 'config.json', agent: 'agent-config.json', memory: 'memory-config.json', search: 'search-config.json' }
  let tribCfg
  try { tribCfg = JSON.parse(readFileSync(tribCfgPath, 'utf8')) } catch { tribCfg = null }
  if (tribCfg) {
    for (const [section, file] of Object.entries(SECTION_FILES)) {
      if (tribCfg[section]) writeFileSync(join(PLUGIN_DATA, file), JSON.stringify(tribCfg[section], null, 2) + '\n')
    }
  } else {
    // First run: merge individual files into trib-config.json
    const merged = {}
    for (const [section, file] of Object.entries(SECTION_FILES)) {
      try { merged[section] = JSON.parse(readFileSync(join(PLUGIN_DATA, file), 'utf8')) } catch {}
    }
    if (Object.keys(merged).length > 0) writeFileSync(tribCfgPath, JSON.stringify(merged, null, 2) + '\n')
  }
} catch (e) { log(`config sync: ${e.message}`) }

// ── Static manifest ─────────────────────────────────────────────────
const TOOL_DEFS = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'tools.json'), 'utf8'))
const TOOL_MODULE = Object.fromEntries(TOOL_DEFS.map(t => [t.name, t.module]))
const PLUGIN_VERSION = JSON.parse(
  readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
).version

// ── Logging ──────────────────────────────────────────────────────────
const LOG_FILE = join(PLUGIN_DATA, 'mcp-debug.log')
const log = msg => appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)

// ── Crash handlers ──────────────────────────────────────────────────
// Leave a trace on silent hangs. Previously only child workers
// (channels/memory) installed these; the main MCP entry had none, so
// unhandled errors died without writing a stack.
const CRASH_FILE = join(PLUGIN_DATA, 'crash.log')
const logCrash = (kind, err) => {
  const stack = err?.stack || String(err)
  try { appendFileSync(CRASH_FILE, `[${new Date().toISOString()}] ${kind}\n${stack}\n\n`) } catch {}
  try { log(`${kind}: ${err?.message || err}`) } catch {}
}
process.on('uncaughtException', (err) => { logCrash('uncaughtException', err); process.exit(1) })
process.on('unhandledRejection', (reason) => { logCrash('unhandledRejection', reason) })

// ── Bridge orphan cleanup ───────────────────────────────────────────
try {
  const { cleanupOrphanedPids } = await import(pathToFileURL(join(PLUGIN_ROOT, 'src/shared/llm/cli-runner.mjs')).href)
  const killed = cleanupOrphanedPids()
  if (killed > 0) log(`[bridge-cleanup] cleaned ${killed} orphaned processes`)
} catch (e) {
  log(`[bridge-cleanup] failed: ${e && (e.stack || e.message) || e}`)
}

// ── Session cleanup: bridge sessions from previous MCP process ─────
try {
  const { listSessions, closeSession, startIdleCleanup } = await import(pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/session/manager.mjs')).href)
  const sessions = listSessions()
  let closed = 0
  for (const s of sessions) {
    if (s.owner === 'bridge' && (!s.mcpPid || s.mcpPid !== process.pid)) { closeSession(s.id); closed++ }
  }
  log(`[session-cleanup] closed ${closed} stale bridge sessions (pid≠${process.pid}), ${sessions.length - closed} remaining`)
  // Start periodic idle session cleanup (every 5 min, 30 min TTL)
  startIdleCleanup()
  log(`[session-cleanup] idle sweep timer started (interval=5m, ttl=30m)`)
} catch (e) {
  log(`[session-cleanup] failed: ${e && (e.stack || e.message) || e}`)
}

// ── MCP server ──────────────────────────────────────────────────────
const server = new Server(
  { name: 'trib-plugin', version: PLUGIN_VERSION },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
    },
  },
)

// ── Worker process management ──────────────────────────────────────
const workers = new Map() // name → { proc, ready, pending }
const WORKER_MAX_RESTARTS = 3
const workerRestarts = new Map() // name → count

function spawnWorker(name) {
  const modulePath = join(PLUGIN_ROOT, 'src', name, 'index.mjs')
  const proc = fork(modulePath, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PLUGIN_DATA: PLUGIN_DATA,
      TRIB_WORKER_MODE: '1',
    },
    windowsHide: true,
  })

  const entry = { proc, ready: false, pending: [] }
  workers.set(name, entry)

  proc.on('message', msg => {
    if (msg.type === 'ready') {
      entry.ready = true
      log(`worker ${name} ready (pid=${proc.pid})`)
      return
    }
    if (msg.type === 'result' && msg.callId) {
      const pending = entry.pending.find(p => p.callId === msg.callId)
      if (pending) {
        entry.pending = entry.pending.filter(p => p.callId !== msg.callId)
        if (msg.error) pending.reject(new Error(msg.error))
        else pending.resolve(msg.result)
      }
      return
    }
    if (msg.type === 'notify' && msg.method) {
      // Worker → parent notification forwarding. The worker has no MCP
      // transport of its own; this is the single path that delivers Discord
      // inbound, schedule injects, webhook events, proactive, and
      // interaction events to the host (Claude Code) over the parent's
      // connected Server.
      server.notification({ method: msg.method, params: msg.params || {} })
        .catch(err => {
          log(`worker ${name} notify forward failed (${msg.method}): ${err instanceof Error ? err.message : String(err)}`)
        })
      return
    }
  })

  proc.on('exit', (code) => {
    log(`worker ${name} exited (code=${code})`)
    workers.delete(name)
    for (const p of entry.pending) {
      p.reject(new Error(`worker ${name} exited unexpectedly`))
    }
    const count = (workerRestarts.get(name) || 0) + 1
    workerRestarts.set(name, count)
    if (count <= WORKER_MAX_RESTARTS) {
      log(`restarting worker ${name} (attempt ${count}/${WORKER_MAX_RESTARTS})`)
      setTimeout(() => spawnWorker(name), 1000)
    } else {
      log(`worker ${name} exceeded max restarts, marking degraded`)
    }
  })

  proc.on('error', (err) => {
    log(`worker ${name} error: ${err.message}`)
  })

  return entry
}

let _callIdSeq = 0
const WORKER_CALL_TIMEOUT = 30000 // 30s per tool call

function callWorker(name, toolName, args) {
  return new Promise((resolve, reject) => {
    const entry = workers.get(name)
    if (!entry || !entry.proc.connected || !entry.ready) {
      return reject(new Error(`worker ${name} not available`))
    }
    const callId = String(++_callIdSeq)
    const timer = setTimeout(() => {
      entry.pending = entry.pending.filter(p => p.callId !== callId)
      reject(new Error(`worker ${name} call ${toolName} timed out after ${WORKER_CALL_TIMEOUT}ms`))
    }, WORKER_CALL_TIMEOUT)
    entry.pending.push({ callId, resolve: v => { clearTimeout(timer); resolve(v) }, reject: e => { clearTimeout(timer); reject(e) } })
    try {
      const sent = entry.proc.send({ type: 'call', callId, name: toolName, args })
      if (sent === false) {
        clearTimeout(timer)
        entry.pending = entry.pending.filter(p => p.callId !== callId)
        reject(new Error(`worker ${name} IPC channel full or closed`))
      }
    } catch (sendErr) {
      clearTimeout(timer)
      entry.pending = entry.pending.filter(p => p.callId !== callId)
      reject(new Error(`worker ${name} send failed: ${sendErr.message}`))
    }
  })
}

// ── Module loader (cached, init+start runs once per module) ─────────
const modules = new Map()

function agentContext() {
  return {
    notifyFn: text => {
      server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: text,
          meta: { user: 'trib-agent', user_id: 'system', ts: new Date().toISOString() },
        },
      }).catch(err => {
        log(`[agent-notify] channel failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    },
    elicitFn: opts => server.elicitInput(opts),
  }
}

async function loadModule(name) {
  let entry = modules.get(name)
  if (entry) return entry
  const url = pathToFileURL(join(PLUGIN_ROOT, 'src', name, 'index.mjs')).href
  const mod = await import(url)
  if (mod.init) await mod.init(server)
  if (mod.start) await mod.start()
  entry = mod
  modules.set(name, entry)
  log(`module ${name} ready`)
  return entry
}

// ── Handlers ────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params
  const moduleName = TOOL_MODULE[name]
  if (!moduleName) throw new Error(`Unknown tool: ${name}`)

  // Worker-isolated modules — no fallback
  if (moduleName === 'memory' || moduleName === 'channels') {
    return callWorker(moduleName, name, args ?? {})
  }

  // In-process modules (search, agent — lightweight)
  const mod = await loadModule(moduleName)
  if (moduleName === 'agent') return mod.handleToolCall(name, args ?? {}, agentContext())
  return mod.handleToolCall(name, args ?? {})
})

// ── Transport ───────────────────────────────────────────────────────
await server.connect(new StdioServerTransport())
log(`connected pid=${process.pid} v${PLUGIN_VERSION} tools=${TOOL_DEFS.length}`)

// ── Eager init: search + agent (avoid first-call latency) ──────────
loadModule('search').catch(e => log(`eager search init failed: ${e.message}`))
loadModule('agent').catch(e => log(`eager agent init failed: ${e.message}`))

// ── CLAUDE.md managed block reconciliation ─────────────────────────
// Writes static rules into the managed block. Session recap is NOT
// written here — the SessionStart hook injects it live from sqlite.
// Fail-soft: any error is logged and swallowed.
//
//   mode === 'claude_md'  → upsert the managed block (strong enforcement)
//   mode === 'hook' (default or missing) → remove any stale managed block
function reconcileClaudeMd() {
  try {
    const cfgPath = join(PLUGIN_DATA, 'config.json')
    let mainConfig = {}
    try { mainConfig = JSON.parse(readFileSync(cfgPath, 'utf8')) } catch {}
    const injection = (mainConfig && mainConfig.promptInjection) || {}
    const targetPath = injection.targetPath || '~/.claude/CLAUDE.md'
    const req = createRequire(import.meta.url)
    const { buildInjectionContent } = req(join(PLUGIN_ROOT, 'lib', 'rules-builder.cjs'))
    const { upsertManagedBlock, removeManagedBlock, expandHome } = req(join(PLUGIN_ROOT, 'lib', 'claude-md-writer.cjs'))

    if (injection.mode === 'claude_md') {
      const content = buildInjectionContent({ PLUGIN_ROOT, DATA_DIR: PLUGIN_DATA })
      upsertManagedBlock(targetPath, content)
      log(`claude_md: wrote managed block to ${expandHome(targetPath)} (${content.length} chars)`)
    } else {
      const removed = removeManagedBlock(targetPath)
      if (removed) log(`hook mode: removed stale managed block from ${expandHome(targetPath)}`)
    }
  } catch (e) {
    log(`claude_md reconcile failed: ${e && (e.stack || e.message) || e}`)
  }
}

// ── CLAUDE.md managed block live watcher ───────────────────────────
// After boot-time reconcile, watch the rules/config sources and rebuild
// the managed block in-place whenever they change. Keeps the disk copy
// of CLAUDE.md in sync so the next session start always sees the latest
// rules, even if the user edited mid-session.
//
// Only active when injection.mode === 'claude_md'. In hook mode this is
// a no-op (hook mode regenerates on every prompt anyway).
//
// All errors are contained: per-watcher try/catch plus an outer try/catch
// so watcher setup failure never crashes the MCP server.
setImmediate(() => {
  try {
    const cfgPath = join(PLUGIN_DATA, 'config.json')
    let mainConfig = {}
    try { mainConfig = JSON.parse(readFileSync(cfgPath, 'utf8')) } catch {}
    const injection = (mainConfig && mainConfig.promptInjection) || {}
    if (injection.mode !== 'claude_md') return

    const targetPath = injection.targetPath || '~/.claude/CLAUDE.md'
    const req = createRequire(import.meta.url)
    const { buildInjectionContent } = req(join(PLUGIN_ROOT, 'lib', 'rules-builder.cjs'))
    const { upsertManagedBlock, expandHome } = req(join(PLUGIN_ROOT, 'lib', 'claude-md-writer.cjs'))
    const resolvedTarget = pathResolve(expandHome(targetPath))

    let debounceTimer = null
    const rebuild = triggerFilename => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        try {
          const content = buildInjectionContent({ PLUGIN_ROOT, DATA_DIR: PLUGIN_DATA })
          upsertManagedBlock(targetPath, content)
          log(`[rules-watcher] rebuilt managed block (${content.length} chars) after ${triggerFilename}`)
        } catch (e) {
          log(`[rules-watcher] rebuild failed: ${e && (e.stack || e.message) || e}`)
        }
      }, 300)
    }

    const DATA_ALLOWLIST = new Set([
      'trib-config.json', 'config.json', 'memory-config.json', 'search-config.json',
      'agent-config.json', 'user-workflow.json', 'user-workflow.md',
      'history/user.md', 'history/bot.md',
    ])

    const makeHandler = root => {
      const isDataDir = pathResolve(root) === pathResolve(PLUGIN_DATA)
      return (_eventType, filename) => {
        if (!filename) return
        if (!/\.(md|json)$/i.test(filename)) return
        const norm = filename.replace(/\\/g, '/')
        if (isDataDir && !DATA_ALLOWLIST.has(norm)) return
        const abs = pathResolve(root, filename)
        if (abs === resolvedTarget) return
        rebuild(filename)
      }
    }

    const roots = [
      join(PLUGIN_ROOT, 'rules'),
      PLUGIN_DATA,
    ]
    for (const root of roots) {
      try {
        fsWatch(root, { recursive: true, persistent: true }, makeHandler(root))
        log(`[rules-watcher] watching ${root}`)
      } catch (e) {
        log(`[rules-watcher] failed to watch ${root}: ${e && (e.stack || e.message) || e}`)
      }
    }
  } catch (e) {
    log(`[rules-watcher] setup failed: ${e && (e.stack || e.message) || e}`)
  }
})

// ── Spawn workers: memory + channels ──────────────────────────────
// Workers own all heavy work. Session recap, buffer flush, cycle
// scheduling all run inside the worker process. No in-process fallback.
setImmediate(() => {
  spawnWorker('memory')
  // channels + CLAUDE.md depend on memory — wait for memory ready
  const memEntry = workers.get('memory')
  if (memEntry) {
    const onReady = (msg) => {
      if (msg.type === 'ready') {
        reconcileClaudeMd()
        if (!workers.has('channels')) spawnWorker('channels')
        memEntry.proc.removeListener('message', onReady)
      }
    }
    memEntry.proc.on('message', onReady)
    // Safety: proceed anyway after 10s if ready never arrives
    setTimeout(() => {
      if (!workers.has('channels')) {
        reconcileClaudeMd()
        spawnWorker('channels')
      }
    }, 10000)
  } else {
    setTimeout(() => {
      reconcileClaudeMd()
      spawnWorker('channels')
    }, 2000)
  }
})

// ── Shutdown ────────────────────────────────────────────────────────
const isWin = process.platform === 'win32'
let shuttingDown = false
async function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutdown: ${reason}`)
  // Stop idle session sweep timer
  try {
    const { stopIdleCleanup } = await import(pathToFileURL(join(PLUGIN_ROOT, 'src/agent/orchestrator/session/manager.mjs')).href)
    stopIdleCleanup()
  } catch {}
  // Kill workers — Windows needs taskkill for reliable cleanup
  for (const [name, entry] of workers) {
    const pid = entry.proc.pid
    try {
      if (isWin && pid) {
        require('child_process').execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: true, timeout: 5000 })
      } else {
        entry.proc.kill('SIGTERM')
      }
      log(`shutdown: killed worker ${name} (pid=${pid})`)
    } catch {}
  }
  // Kill tracked bridge CLI processes
  try {
    const { cleanupOrphanedPids } = await import(pathToFileURL(join(PLUGIN_ROOT, 'src/shared/llm/cli-runner.mjs')).href)
    const killed = cleanupOrphanedPids()
    if (killed > 0) log(`shutdown: cleaned ${killed} bridge CLI processes`)
  } catch {}
  for (const mod of modules.values()) {
    if (mod.stop) await mod.stop()
  }
  process.exit(0)
}

process.stdin.on('end', () => shutdown('stdin end'))
process.stdin.on('close', () => shutdown('stdin close'))
server.onclose = () => shutdown('transport closed')
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
