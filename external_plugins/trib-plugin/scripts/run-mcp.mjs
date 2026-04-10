#!/usr/bin/env node
/**
 * MCP server entry point for trib-plugin.
 *
 * Handles Claude Code's aggressive process lifecycle:
 * - Returns cached tools instantly in ListTools (no blocking)
 * - Lazy-loads bundle on first CallTool
 * - Kills previous process instance to prevent zombies
 * - Maintains process after stdin closes (120s grace period)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, appendFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { spawnSync } from 'child_process'

// ── Paths ──
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? dirname(fileURLToPath(import.meta.url))
const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA ?? join(PLUGIN_ROOT, '.data')
mkdirSync(PLUGIN_DATA, { recursive: true })

const LOG_FILE = join(PLUGIN_DATA, 'mcp-debug.log')
const LOCK_FILE = join(PLUGIN_DATA, 'mcp.lock')
const CACHE_FILE = join(PLUGIN_DATA, 'tools-cache.json')

// ── Logging ──
function log(msg) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

// ── Singleton lock: kill previous instance ──
function acquireLock() {
  try {
    const prevPid = parseInt(readFileSync(LOCK_FILE, 'utf8'), 10)
    if (prevPid && prevPid !== process.pid) {
      try {
        process.kill(prevPid, 0)
        // Process exists, kill it
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(prevPid), '/F'], {
            stdio: 'pipe',
            timeout: 3000,
            shell: true,
          })
        } else {
          process.kill(prevPid, 'SIGTERM')
        }
      } catch {}
    }
  } catch {}
  writeFileSync(LOCK_FILE, String(process.pid))
}

acquireLock()

// ── Cleanup on exit ──
process.on('exit', () => {
  try {
    unlinkSync(LOCK_FILE)
  } catch {}
})

// ── Tool cache ──
let cachedTools = null
try {
  cachedTools = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
} catch {}

// ── Env flags ──
globalThis.__tribFastEntry = true
process.env.TRIB_UNIFIED = '1'

// ── Plugin version ──
function getPluginVersion() {
  try {
    return JSON.parse(
      readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
    ).version || '0.0.1'
  } catch {
    return '0.0.1'
  }
}

// ── MCP server setup ──
const server = new Server(
  { name: 'trib-plugin', version: getPluginVersion() },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: '',
  }
)

let bundleReady = false
let resolveReady
const ready = new Promise(r => {
  resolveReady = r
})

// ── ListTools: return cached tools instantly ──
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = bundleReady ? globalThis.__tribTools || cachedTools || [] : cachedTools || []
  return { tools }
})

// ── CallTool: lazy-load bundle, retry until ready ──
const CALL_TOOL_TIMEOUT = 30_000
server.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    // Start loading if not already started
    loadBundle().catch(e => log(`setup error: ${e.stack || e}`))

    // Wait for bundle to load
    await Promise.race([loadBundle(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), CALL_TOOL_TIMEOUT))])

    // Wait for setup to complete
    await Promise.race([ready, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), CALL_TOOL_TIMEOUT))])
  } catch {
    return {
      content: [{ type: 'text', text: 'Server initializing — please retry.' }],
      isError: true,
    }
  }

  const handler = globalThis.__tribHandleToolCall
  if (!handler) {
    return {
      content: [{ type: 'text', text: 'Handler unavailable.' }],
      isError: true,
    }
  }

  return handler(req, server)
})

// ── Connect MCP transport ──
const transport = new StdioServerTransport()
await server.connect(transport)
log(`start pid=${process.pid} cached=${cachedTools?.length ?? 0}`)

// ── Bundle loader ──
const bundlePath = join(PLUGIN_ROOT, 'server.bundle.mjs')
let loadingPromise = null

function loadBundle() {
  if (loadingPromise) return loadingPromise
  if (bundleReady) return Promise.resolve()

  return (loadingPromise = (async () => {
    const bundleUrl = pathToFileURL(bundlePath).href
    const mod = await import(bundleUrl)
    if (!mod.setup) {
      log('setup function not exported')
      process.exit(1)
    }

    await mod.setup(server, resolveReady)
    bundleReady = true

    // Update cache
    try {
      writeFileSync(CACHE_FILE, JSON.stringify(globalThis.__tribTools || []))
    } catch {}

    log(`ready ${(globalThis.__tribTools || []).length} tools`)
  })())
}

// Start loading eagerly in background
loadBundle().catch(e => log(`setup error: ${e.stack || e}`))

// ── Shutdown handling ──
let isShuttingDown = false

function shutdown(reason) {
  if (isShuttingDown) return
  isShuttingDown = true
  log(`shutdown: ${reason}`)
  setTimeout(() => process.exit(0), 3000)

  const fn = globalThis.__tribShutdown
  if (fn) fn().catch(() => {}).finally(() => process.exit(0))
  else process.exit(0)
}

server.onclose = () => shutdown('transport closed')
process.stdin.on('end', () => setTimeout(() => shutdown('stdin idle'), 120_000))
process.stdout.on('error', e => {
  if (e.code === 'EPIPE') shutdown('EPIPE')
})
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
