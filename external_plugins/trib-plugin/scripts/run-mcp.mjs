#!/usr/bin/env node
/**
 * MCP server entry point — fast handshake + lazy bundle load + single-instance lock.
 *
 * Flow:
 * 1. Kill previous instance via lockfile (prevent zombies)
 * 2. MCP handshake immediately (SDK only, no heavy imports)
 * 3. On first tool request → load server.bundle.mjs
 * 4. Wire up 24 tools via setup()
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { spawnSync } from 'child_process'

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? dirname(fileURLToPath(import.meta.url))
const PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA ?? join(PLUGIN_ROOT, '.data')
mkdirSync(PLUGIN_DATA, { recursive: true })

// ── Single-instance lock ──
const lockFile = join(PLUGIN_DATA, 'mcp.lock')
try {
  const oldPid = parseInt(readFileSync(lockFile, 'utf8'), 10)
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, 0)
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(oldPid), '/F'], { stdio: 'pipe', timeout: 3000, shell: true })
      } else {
        process.kill(oldPid, 'SIGTERM')
      }
    } catch {}
  }
} catch {}
writeFileSync(lockFile, String(process.pid))
process.on('exit', () => { try { unlinkSync(lockFile) } catch {} })

// ── Fast MCP handshake ──
globalThis.__tribFastEntry = true
process.env.TRIB_UNIFIED = '1'

function readPluginVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || '0.0.1'
  } catch { return '0.0.1' }
}

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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await ensureBundleLoaded()
  await ready
  return { tools: globalThis.__tribTools || [] }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await ensureBundleLoaded()
  await ready
  const handler = globalThis.__tribHandleToolCall
  if (!handler) return { content: [{ type: 'text', text: 'Server still initializing' }], isError: true }
  return handler(request, server)
})

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write(`[trib-plugin] MCP handshake done\n`)

// ── Lazy bundle load ──
const bundlePath = join(PLUGIN_ROOT, 'server.bundle.mjs')
let loadingBundle = null

async function ensureBundleLoaded() {
  if (loadingBundle) return loadingBundle
  loadingBundle = (async () => {
    process.stderr.write(`[trib-plugin] loading modules...\n`)
    const mod = await import(pathToFileURL(bundlePath).href)
    if (mod.setup) { await mod.setup(server, resolveReady) }
    else { process.stderr.write(`[trib-plugin] ERROR: bundle has no setup()\n`); process.exit(1) }
  })()
  return loadingBundle
}

// ── Shutdown ──
let isShuttingDown = false
async function shutdown(reason) {
  if (isShuttingDown) return
  isShuttingDown = true
  try { process.stderr.write(`[trib-plugin] ${reason}\n`) } catch {}
  if (globalThis.__tribShutdown) { try { await globalThis.__tribShutdown() } catch {} }
  process.exit(0)
}

server.onclose = () => { void shutdown('transport closed') }
process.stdin.on('end', () => { void shutdown('stdin ended') })
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') void shutdown('stdout EPIPE') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })
