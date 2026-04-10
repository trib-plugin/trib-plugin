/**
 * Thin MCP entry point — completes handshake BEFORE loading heavy modules.
 *
 * Flow:
 * 1. Import only MCP SDK (fast, already in node_modules)
 * 2. Create server + connect transport → handshake done
 * 3. Load the bundled server logic (heavy modules)
 * 4. Wire up tool handlers
 *
 * This prevents Claude Code from timing out and spawning retries.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? dirname(fileURLToPath(import.meta.url))
// Mark as fast entry so the bundle knows not to self-execute
globalThis.__tribFastEntry = true

function readPluginVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || '0.0.1'
  } catch {
    return '0.0.1'
  }
}

process.env.TRIB_UNIFIED = '1'

// ── Create server and connect IMMEDIATELY ─────────────────────────────

const server = new Server(
  { name: 'trib-plugin', version: readPluginVersion() },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
    },
    instructions: '',
  },
)

let resolveReady
const ready = new Promise(r => { resolveReady = r })

// Track if we receive any MCP request — if not, we're a zombie
let gotRequest = false

server.setRequestHandler(ListToolsRequestSchema, async () => {
  gotRequest = true
  await ensureBundleLoaded()
  await ready
  return { tools: globalThis.__tribTools || [] }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  gotRequest = true
  await ensureBundleLoaded()
  await ready
  const handler = globalThis.__tribHandleToolCall
  if (!handler) return { content: [{ type: 'text', text: 'Server still initializing' }], isError: true }
  return handler(request, server)
})

const transport = new StdioServerTransport()
await server.connect(transport)

// Claude Code may spawn multiple instances. Zombies (no requests) stay
// alive but lightweight — they never load the heavy bundle (~30MB vs ~200MB).
// They die naturally when Claude Code closes their stdin on reconnect.

process.stderr.write(`[trib-plugin] MCP handshake done, waiting for first request...\n`)

// ── Load heavy bundle ONLY when we get a real request ─────────────────
// Claude Code spawns ~5 instances in parallel (known bug). Only the active
// one receives requests. Zombies never load the bundle = no CPU spike.

const bundlePath = join(PLUGIN_ROOT, 'server.bundle.mjs')
const distBundle = join(PLUGIN_ROOT, 'dist', 'server.bundle.mjs')

let bundleFile
try { readFileSync(distBundle, { encoding: 'utf8', flag: 'r' }).slice(0, 1); bundleFile = distBundle } catch {
  try { readFileSync(bundlePath, { encoding: 'utf8', flag: 'r' }).slice(0, 1); bundleFile = bundlePath } catch {
    process.stderr.write(`[trib-plugin] ERROR: no bundle found\n`)
    process.exit(1)
  }
}

let loadingBundle = null
async function ensureBundleLoaded() {
  if (loadingBundle) return loadingBundle
  loadingBundle = (async () => {
    process.stderr.write(`[trib-plugin] active instance — loading modules...\n`)
    const bundleUrl = pathToFileURL(bundleFile).href
    const mod = await import(bundleUrl)
    if (mod.setup) {
      await mod.setup(server, resolveReady)
    } else {
      process.stderr.write(`[trib-plugin] ERROR: bundle has no setup() export\n`)
      process.exit(1)
    }
  })()
  return loadingBundle
}

// ── Shutdown ──────────────────────────────────────────────────────────

let isShuttingDown = false
async function shutdown(reason) {
  if (isShuttingDown) return
  isShuttingDown = true
  try { process.stderr.write(`[trib-plugin] ${reason || 'shutting down'}\n`) } catch {}
  if (globalThis.__tribShutdown) {
    try { await globalThis.__tribShutdown() } catch {}
  }
  process.exit(0)
}

server.onclose = () => { void shutdown('MCP transport closed') }
process.stdin.on('end', () => { void shutdown('stdin ended') })
process.stdin.on('close', () => { void shutdown('stdin closed') })
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') void shutdown('stdout pipe closed') })
process.on('disconnect', () => { void shutdown('parent disconnected') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })
if (process.platform !== 'win32') process.on('SIGHUP', () => { void shutdown('SIGHUP') })
