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
 *   • search / agent — lazy init on first CallTool.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, appendFileSync, mkdirSync, watch as fsWatch } from 'fs'
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
process.env.TRIB_UNIFIED = '1'

// ── Static manifest ─────────────────────────────────────────────────
const TOOL_DEFS = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'tools.json'), 'utf8'))
const TOOL_MODULE = Object.fromEntries(TOOL_DEFS.map(t => [t.name, t.module]))
const PLUGIN_VERSION = JSON.parse(
  readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
).version

// ── Logging ──────────────────────────────────────────────────────────
const LOG_FILE = join(PLUGIN_DATA, 'mcp-debug.log')
const log = msg => appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)

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
  const mod = await loadModule(moduleName)
  if (moduleName === 'agent') return mod.handleToolCall(name, args ?? {}, agentContext())
  return mod.handleToolCall(name, args ?? {})
})

// ── Transport ───────────────────────────────────────────────────────
await server.connect(new StdioServerTransport())
log(`connected pid=${process.pid} v${PLUGIN_VERSION} tools=${TOOL_DEFS.length}`)

// ── CLAUDE.md managed block reconciliation ─────────────────────────
// Runs fail-soft after the MCP handshake so the server is already
// responsive. Any error is logged and swallowed — never crashes the
// server or blocks tool calls.
//
//   mode === 'claude_md'  → upsert the managed block (strong enforcement)
//   mode === 'hook' (default or missing) → remove any stale managed block
//
// This means toggling the setting back to hook mode and restarting
// Claude Code automatically cleans up the previously written block —
// no manual cleanup command needed.
setImmediate(() => {
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
      // Hook mode (default) — scrub any stale managed block so CLAUDE.md
      // stays clean when the user toggles back.
      const removed = removeManagedBlock(targetPath)
      if (removed) log(`hook mode: removed stale managed block from ${expandHome(targetPath)}`)
    }
  } catch (e) {
    log(`claude_md reconcile failed: ${e && (e.stack || e.message) || e}`)
  }
})

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
      'config.json', 'memory-config.json', 'search-config.json',
      'agent-config.json', 'user-workflow.json', 'user-workflow.md',
      'history/context.md', 'history/user.md', 'history/bot.md',
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

// ── Eager init: memory + channels ──────────────────────────────────
// Memory HTTP must be ready before channels starts sending episodes.
setImmediate(async () => {
  try {
    await loadModule('memory')
    // Flush episodes that were buffered while memory was previously unavailable
    try {
      const { flushBufferedEpisodes } = await import(pathToFileURL(join(PLUGIN_ROOT, 'src/channels/lib/memory-client.mjs')).href)
      const result = await flushBufferedEpisodes()
      if (result.flushed > 0) log(`flushed ${result.flushed} buffered episodes`)
    } catch (e) {
      log(`buffer flush failed: ${e.message}`)
    }
  } catch (e) {
    log(`memory init failed: ${e.stack || e.message}`)
  }
  loadModule('channels').catch(e => {
    log(`channels init failed: ${e.stack || e.message}`)
    throw e
  })
})

// ── Shutdown ────────────────────────────────────────────────────────
let shuttingDown = false
async function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutdown: ${reason}`)
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
