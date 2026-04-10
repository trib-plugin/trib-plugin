/**
 * Unified trib-plugin server — merges channels, memory, search, agent
 * into a single MCP server process.
 *
 * Two modes:
 * 1. Fast entry (via server-fast-entry.mjs): exports setup() — modules load
 *    AFTER MCP handshake so Claude Code doesn't timeout and retry.
 * 2. Standalone: creates its own server and self-executes.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

process.env.TRIB_UNIFIED = '1'

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? dirname(fileURLToPath(import.meta.url))

function readPluginVersion(): string {
  try {
    const manifestPath = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')
    return JSON.parse(readFileSync(manifestPath, 'utf8')).version || '0.0.1'
  } catch {
    try {
      const fallback = join(PLUGIN_ROOT, '.claude-plugin', 'marketplace.json')
      return JSON.parse(readFileSync(fallback, 'utf8')).version || '0.0.1'
    } catch { return '0.0.1' }
  }
}

const PLUGIN_VERSION = readPluginVersion()

// ── Setup function (used by fast entry) ───────────────────────────────

export async function setup(server: Server, resolveReady: () => void) {
  process.stderr.write(`[trib-plugin] loading modules...\n`)

  // Load channels (static import available since it's bundled)
  const channelsMod = await import('./src/channels/index')
  const CHANNELS_TOOLS = channelsMod.TOOL_DEFS as any[]
  const channelsInit = channelsMod.init
  const channelsHandleToolCall = channelsMod.handleToolCall
  const channelsStart = channelsMod.start
  const channelsStop = channelsMod.stop

  // Load search
  const searchModulePath = pathToFileURL(join(PLUGIN_ROOT, 'src/search/index.mjs')).href
  const searchMod = await import(searchModulePath) as any
  const SEARCH_TOOLS = searchMod.TOOL_DEFS as any[]
  const searchHandleToolCall = searchMod.handleToolCall
  const searchStart = searchMod.start
  const searchStop = searchMod.stop

  // Load agent
  const agentModulePath = pathToFileURL(join(PLUGIN_ROOT, 'src/agent/index.mjs')).href
  const agentMod = await import(agentModulePath) as any
  const AGENT_TOOLS = agentMod.TOOL_DEFS as any[]
  const agentInit = agentMod.init
  const agentHandleToolCall = agentMod.handleToolCall
  const agentStart = agentMod.start
  const agentStop = agentMod.stop

  // Load memory
  const memoryModulePath = pathToFileURL(join(PLUGIN_ROOT, 'src/memory/index.mjs')).href
  const memoryMod = await import(memoryModulePath) as any
  const MEMORY_TOOLS = memoryMod.TOOL_DEFS as any[]
  const memoryInit = memoryMod.init
  const memoryHandleToolCall = memoryMod.handleToolCall
  const memoryStart = memoryMod.start
  const memoryStop = memoryMod.stop

  // Build tool routing
  const CHANNELS_TOOL_NAMES = new Set(CHANNELS_TOOLS.map((t: any) => t.name))
  const SEARCH_TOOL_NAMES = new Set(SEARCH_TOOLS.map((t: any) => t.name))
  const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((t: any) => t.name))
  const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map((t: any) => t.name))

  const ALL_TOOLS = [
    ...CHANNELS_TOOLS,
    ...MEMORY_TOOLS,
    ...SEARCH_TOOLS,
    ...AGENT_TOOLS,
  ]

  function routeToolCall(name: string): string | null {
    if (SEARCH_TOOL_NAMES.has(name)) return 'search'
    if (AGENT_TOOL_NAMES.has(name)) return 'agent'
    if (MEMORY_TOOL_NAMES.has(name)) return 'memory'
    if (CHANNELS_TOOL_NAMES.has(name)) return 'channels'
    return null
  }

  // Expose to fast entry via globalThis
  ;(globalThis as any).__tribTools = ALL_TOOLS
  ;(globalThis as any).__tribHandleToolCall = async (request: any, srv: Server) => {
    const { name, arguments: args } = request.params
    const toolArgs = (args ?? {}) as Record<string, unknown>
    const module = routeToolCall(name)

    switch (module) {
      case 'search':
        return await searchHandleToolCall(name, toolArgs)
      case 'agent':
        return await agentHandleToolCall(name, toolArgs, {
          notifyFn: (text: string) => {
            srv.notification({
              method: 'notifications/claude/channel',
              params: { content: text, meta: { user: 'trib-agent', user_id: 'system', ts: new Date().toISOString() } },
            }).catch(() => {})
          },
          elicitFn: (opts: any) => (srv as any).elicitInput?.(opts),
        })
      case 'memory':
        return await memoryHandleToolCall(name, toolArgs)
      case 'channels':
        return await channelsHandleToolCall(name, toolArgs)
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
  }
  ;(globalThis as any).__tribShutdown = async () => {
    try { await channelsStop() } catch {}
    try { await memoryStop() } catch {}
    try { await agentStop() } catch {}
    try { searchStop() } catch {}
  }

  // Signal that tools are ready
  resolveReady()
  process.stderr.write(`[trib-plugin] ${ALL_TOOLS.length} tools ready, initializing...\n`)

  // Init modules (order matters)
  await memoryInit()
  await agentInit()
  await channelsInit(server)

  // Start modules
  await searchStart()
  await memoryStart()
  await agentStart()
  await channelsStart()

  process.stderr.write(`[trib-plugin] all modules started\n`)
}

// ── Standalone execution ──────────────────────────────────────────────

const isFastEntry = !!(globalThis as any).__tribFastEntry

if (!isFastEntry) {
  const server = new Server(
    { name: 'trib-plugin', version: PLUGIN_VERSION },
    {
      capabilities: {
        tools: {},
        experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      },
      instructions: '',
    },
  )

  let resolveReady: () => void
  const ready = new Promise<void>(r => { resolveReady = r })

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await ready
    return { tools: (globalThis as any).__tribTools || [] }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    await ready
    const handler = (globalThis as any).__tribHandleToolCall
    if (!handler) return { content: [{ type: 'text', text: 'Server not ready' }], isError: true }
    return handler(request, server)
  })

  process.stderr.write(`[trib-plugin] standalone server starting (v${PLUGIN_VERSION})\n`)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  let isShuttingDown = false
  async function shutdown(reason?: string) {
    if (isShuttingDown) return
    isShuttingDown = true
    try { process.stderr.write(`[trib-plugin] ${reason || 'shutting down'}\n`) } catch {}
    const fn = (globalThis as any).__tribShutdown
    if (fn) try { await fn() } catch {}
    process.exit(0)
  }

  server.onclose = () => { void shutdown('MCP transport closed') }
  process.stdin.on('end', () => { void shutdown('stdin ended') })
  process.stdin.on('close', () => { void shutdown('stdin closed') })
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') void shutdown('stdout pipe closed')
  })
  process.on('disconnect', () => { void shutdown('parent disconnected') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  if (process.platform !== 'win32') process.on('SIGHUP', () => { void shutdown('SIGHUP') })

  await setup(server, resolveReady!)
}
