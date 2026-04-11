#!/usr/bin/env node
/**
 * trib-plugin — MCP server entry point.
 *
 * Four modules (channels, memory, search, agent) exposed over a single
 * MCP server. Tool routing is driven by the static manifest in tools.json,
 * which records the owning module for every tool.
 *
 * Module lifecycle:
 *   • channels — eager init (runs background workers: Discord gateway,
 *     scheduler, webhook, event pipeline). Started right after the
 *     MCP handshake completes.
 *   • memory / search / agent — lazy init on first CallTool.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
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

// ── Eager init: channels (background workers) ────────────────────────
setImmediate(() => {
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
