import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initProviders, getAllProviders } from './orchestrator/providers/registry.js';
import { createSession, askSession, listSessions, closeSession, resumeSession } from './orchestrator/session/manager.js';
import { loadConfig } from './orchestrator/config.js';
import { connectMcpServers, disconnectAll } from './orchestrator/mcp/client.js';

const INSTRUCTIONS = [
  'Tools: `TeamCreate`, `TaskCreate`, `Agent`(subagent_type=Worker/Reviewer, team_name required).',
  'Lead can use any tool directly if it does not delay user response. Delegate long-running or parallel work to agents.',
  'Workflow skill must be invoked before any work begins.',
  '',
  'Orchestrator MCP tools: `create_session`, `list_sessions`, `close_session`, `list_models`.',
  'Use create_session to spawn external AI sessions with tool access (preset: full/readonly/mcp).',
  'Sessions auto-inject CLAUDE.md, agent rules, skills, and register builtin+MCP tools.',
  'ask runs via CLI: `node "${CLAUDE_PLUGIN_ROOT}/orchestrator/cli.js" ask <sessionId> "prompt"` (supports --background, --context).',
].join('\n');

const server = new Server(
  { name: 'trib-agent', version: '0.0.5' },
  { capabilities: { tools: {}, experimental: { 'claude/channel': {} } }, instructions: INSTRUCTIONS },
);

// --- Helpers ---

function ok(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function fail(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

function notify(text) {
  server.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: { user: 'trib-agent', user_id: 'system', ts: new Date().toISOString() },
    },
  }).catch(() => {});
}

// Format token counts in Claude Code style: <1000 as-is, >=1000 as "9.9k"
function fmtTokens(n) {
  if (typeof n !== 'number') return String(n ?? '?');
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

let jobSeq = 1;

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'create_session',
    description: 'Create an external AI session. Auto-injects CLAUDE.md, agent rules, skills. Registers builtin+MCP tools. Use preset: "full"/"readonly"/"mcp". Use agent: "Worker"/"Reviewer" for role rules. Pass cwd for project-scoped tool execution.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'openai, openai-oauth, anthropic, gemini, groq, openrouter, xai, copilot, ollama, lmstudio, local' },
        model: { type: 'string', description: 'e.g., gpt-4o, claude-sonnet-4-0, gemini-2.5-pro' },
        systemPrompt: { type: 'string', description: 'Additional system prompt' },
        agent: { type: 'string', description: 'Agent template: "Worker", "Reviewer"' },
        preset: { type: 'string', enum: ['full', 'readonly', 'mcp'], description: 'Tool preset (default: full)' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
        cwd: { type: 'string', description: 'Working directory for builtin tool execution and CLAUDE.md/agents/skills lookup. Pass the project root (e.g. C:/Project). Defaults to MCP server cwd.' },
      },
      required: ['provider', 'model'],
    },
  },
  {
    name: 'ask',
    description: 'Send message to session. Async — returns jobId, result via notification. Model can use tools (bash, read, write, edit, grep, glob, MCP, skills) via auto tool loop. Optional cwd overrides session cwd.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        prompt: { type: 'string' },
        context: { type: 'string', description: 'Additional context to inject' },
        cwd: { type: 'string', description: 'Override working directory for this turn (default: session cwd or MCP server cwd)' },
      },
      required: ['sessionId', 'prompt'],
    },
  },
  {
    name: 'list_sessions',
    description: 'List all active orchestrator sessions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'close_session',
    description: 'Close an orchestrator session.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'list_models',
    description: 'List available models from all enabled providers.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// --- Handlers ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {});

  try {
    switch (name) {
      case 'create_session': {
        const session = createSession(args);
        return ok({
          sessionId: session.id, provider: session.provider, model: session.model,
          contextWindow: session.contextWindow, toolsAvailable: session.tools.length,
          toolNames: session.tools.map(t => t.name),
        });
      }

      case 'ask': {
        // resumeSession refreshes tools (MCP connections may have changed since createSession)
        const session = resumeSession(args.sessionId);
        if (!session) return fail(`Session "${args.sessionId}" not found`);

        const jobId = `job_${jobSeq++}_${Date.now()}`;
        const startedAt = Date.now();

        askSession(args.sessionId, args.prompt, args.context,
          (iteration, calls) => {
            const names = calls.map(c => c.name).join(', ');
            notify(`🔧 [${session.provider}/${session.model}] Tool #${iteration}: ${names}\n_job: ${jobId}_`);
          },
          args.cwd,
        )
          .then((result) => {
            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
            const inTok = fmtTokens(result.usage?.inputTokens);
            const outTok = fmtTokens(result.usage?.outputTokens);
            const trimNote = result.trimmed ? ` · trimmed (-${result.messagesDropped} msgs)` : '';
            const loopNote = result.iterations > 1 ? ` · ${result.iterations} loops, ${result.toolCallsTotal} tool calls` : '';
            notify(
              `**[${session.provider}/${session.model}]** (${elapsed}s)\n\n${result.content}\n\n---\n` +
              `_job: ${jobId} · ${inTok} in · ${outTok} out${trimNote}${loopNote}_`,
            );
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
            notify(`**[${session.provider}/${session.model}]** FAILED (${elapsed}s)\n\n${msg}\n\n---\n_job: ${jobId}_`);
          });

        return ok({ jobId, status: 'working', toolsAvailable: session.tools.length });
      }

      case 'list_sessions': {
        return ok(listSessions().map(s => ({
          id: s.id, provider: s.provider, model: s.model,
          messages: s.messages.length, tools: s.tools.length,
          inputTokens: s.totalInputTokens, outputTokens: s.totalOutputTokens,
          createdAt: new Date(s.createdAt).toISOString(),
        })));
      }

      case 'close_session': {
        const closed = closeSession(args.sessionId);
        return ok(closed ? `Session ${args.sessionId} closed.` : `Session ${args.sessionId} not found.`);
      }

      case 'list_models': {
        const results = [];
        for (const [provName, provider] of getAllProviders()) {
          try {
            const models = await provider.listModels();
            results.push({ provider: provName, models: models.map(m => ({ id: m.id, name: m.name })) });
          } catch {
            results.push({ provider: provName, models: [] });
          }
        }
        return ok(results);
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err);
  }
});

// --- Init providers + MCP clients, then start ---

async function main() {
  // loadConfig handles legacy mcp-tools.json migration into config.json automatically
  const config = loadConfig();
  await initProviders(config.providers);

  // MCP tool servers come from config.mcpServers (config.json)
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    process.stderr.write(`[trib-agent] Loading ${Object.keys(config.mcpServers).length} MCP tool server(s) from config.json\n`);
    await connectMcpServers(config.mcpServers);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', async () => { await disconnectAll(); process.exit(0); });
}

main().catch((err) => {
  process.stderr.write(`[trib-agent] Failed to start: ${err}\n`);
  process.exit(1);
});
