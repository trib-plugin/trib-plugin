/**
 * Unified trib-plugin server — merges channels, memory, search, agent
 * into a single MCP server process.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// ── Environment ────────────────────────────────────────────────────────

process.env.TRIB_UNIFIED = '1'

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? dirname(fileURLToPath(import.meta.url))

function readPluginVersion(): string {
  try {
    const manifestPath = join(PLUGIN_ROOT, '.claude-plugin', 'marketplace.json')
    return JSON.parse(readFileSync(manifestPath, 'utf8')).version || '0.0.1'
  } catch { return '0.0.1' }
}

const PLUGIN_VERSION = readPluginVersion()

// ── Module imports ─────────────────────────────────────────────────────

import {
  TOOL_DEFS as SEARCH_TOOLS,
  instructions as searchInstructions,
  handleToolCall as searchHandleToolCall,
  start as searchStart,
  stop as searchStop,
} from './external_plugins/trib-search/server.mjs'

import {
  TOOL_DEFS as AGENT_TOOLS,
  instructions as agentInstructions,
  init as agentInit,
  handleToolCall as agentHandleToolCall,
  start as agentStart,
  stop as agentStop,
} from './external_plugins/trib-agent/server.mjs'

import {
  TOOL_DEFS as MEMORY_TOOLS,
  instructions as memoryInstructions,
  init as memoryInit,
  handleToolCall as memoryHandleToolCall,
  start as memoryStart,
  stop as memoryStop,
} from './external_plugins/trib-memory/services/memory-service.mjs'

import {
  TOOL_DEFS as CHANNELS_TOOLS,
  instructions as channelsInstructions,
  init as channelsInit,
  handleToolCall as channelsHandleToolCall,
  start as channelsStart,
  stop as channelsStop,
} from './external_plugins/trib-channels/server.ts'

// ── Tool routing ───────────────────────────────────────────────────────

const SEARCH_TOOL_NAMES = new Set((SEARCH_TOOLS as any[]).map((t: any) => t.name))
const AGENT_TOOL_NAMES = new Set((AGENT_TOOLS as any[]).map((t: any) => t.name))
const MEMORY_TOOL_NAMES = new Set((MEMORY_TOOLS as any[]).map((t: any) => t.name))
// Channels handles everything else

const ALL_TOOLS = [
  ...(CHANNELS_TOOLS as any[]),
  ...(MEMORY_TOOLS as any[]),
  ...(SEARCH_TOOLS as any[]),
  ...(AGENT_TOOLS as any[]),
]

function routeToolCall(name: string): string {
  if (SEARCH_TOOL_NAMES.has(name)) return 'search'
  if (AGENT_TOOL_NAMES.has(name)) return 'agent'
  if (MEMORY_TOOL_NAMES.has(name)) return 'memory'
  return 'channels'
}

// ── Instructions merge ─────────────────────────────────────────────────

const UNIFIED_INSTRUCTIONS = [
  channelsInstructions,
  '',
  '# Memory',
  memoryInstructions,
  '',
  '# Search',
  searchInstructions,
  '',
  '# Agent',
  agentInstructions,
].filter(Boolean).join('\n')

// ── MCP Server ─────────────────────────────────────────────────────────

const server = new Server(
  { name: 'trib-plugin', version: PLUGIN_VERSION },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
    },
    instructions: UNIFIED_INSTRUCTIONS,
  },
)

// ── Tool handlers ──────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS,
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const module = routeToolCall(name)

  switch (module) {
    case 'search':
      return await searchHandleToolCall(name, args)
    case 'agent':
      return await agentHandleToolCall(name, args, {
        notifyFn: (text: string) => {
          server.notification({
            method: 'notifications/claude/channel',
            params: { content: text, meta: { user: 'trib-agent', user_id: 'system', ts: new Date().toISOString() } },
          }).catch(() => {})
        },
      })
    case 'memory':
      return await memoryHandleToolCall(name, args)
    case 'channels':
      return await channelsHandleToolCall(name, args)
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
})

// ── Initialize & Start ─────────────────────────────────────────────────

async function main() {
  process.stderr.write(`[trib-plugin] unified server starting (v${PLUGIN_VERSION})\n`)

  // Init modules (order matters: memory first, then agent, then channels)
  await memoryInit()
  await agentInit()
  await channelsInit(server)  // channels needs shared MCP server for notifications

  // Start modules
  await searchStart()
  await memoryStart()
  await agentStart()
  await channelsStart()

  process.stderr.write(`[trib-plugin] all modules initialized, ${ALL_TOOLS.length} tools registered\n`)

  // Connect transport
  const transport = new StdioServerTransport()
  await server.connect(transport)

  process.stderr.write(`[trib-plugin] MCP server connected\n`)
}

// ── Shutdown ───────────────────────────────────────────────────────────

async function shutdown() {
  process.stderr.write(`[trib-plugin] shutting down\n`)
  await channelsStop()
  await memoryStop()
  await agentStop()
  searchStop()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
if (process.platform !== 'win32') process.on('SIGHUP', () => { void shutdown() })

// ── Run ────────────────────────────────────────────────────────────────

await main()
await new Promise<void>((resolve) => { server.onclose = resolve })
