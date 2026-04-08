import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initProviders, getAllProviders } from './orchestrator/providers/registry.js';
import { createSession, askSession, listSessions, closeSession, resumeSession } from './orchestrator/session/manager.js';
import { loadConfig, getPluginData } from './orchestrator/config.js';
import { connectMcpServers, disconnectAll, executeMcpTool } from './orchestrator/mcp/client.js';
import { listWorkflows, getWorkflow, seedDefaults } from './orchestrator/workflow-store.js';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? dirname(fileURLToPath(import.meta.url));

function readPluginVersion() {
  try {
    const manifestPath = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
    return JSON.parse(readFileSync(manifestPath, 'utf8')).version || '0.0.1';
  } catch { return '0.0.1'; }
}
const PLUGIN_VERSION = readPluginVersion();

function injectViaChannels(content) {
  executeMcpTool('mcp__trib-channels__inject', { content, source: 'trib-agent' })
    .catch(() => { /* trib-channels not connected — fall back to notify */ notify(content); });
}

function buildInstructions() {
  const lines = [
    'Tools: `TeamCreate`, `TaskCreate`, `Agent`(subagent_type=Worker/Reviewer, team_name required).',
    'Lead can use any tool directly if it does not delay user response. Delegate long-running or parallel work to agents.',
    'Workflow skill must be invoked before any work begins.',
    '',
    'Orchestrator MCP tools: `delegate`, `create_session`, `list_sessions`, `close_session`, `list_models`, `get_workflows`, `get_workflow`.',
    '`delegate`(task, provider, model) — send a task to an external AI model (GPT, Gemini, etc). Sync by default, returns result directly. Reuse sessionId for follow-up turns. Set background=true for async.',
    'Sessions auto-inject CLAUDE.md, agent rules, skills, and register builtin+MCP tools.',
  ];

  // Dynamic workflow list injection
  try {
    const workflows = listWorkflows();
    lines.push('');
    if (workflows.length > 0) {
      lines.push('Available workflows:');
      for (const w of workflows) {
        lines.push(`- ${w.name}: ${w.description}`);
      }
    } else {
      lines.push('No custom workflows configured.');
    }
  } catch {
    lines.push('');
    lines.push('No custom workflows configured.');
  }

  return lines.join('\n');
}

// Seed default workflows into user data dir if none exist yet
seedDefaults();

const INSTRUCTIONS = buildInstructions();

const server = new Server(
  { name: 'trib-agent', version: PLUGIN_VERSION },
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
  {
    name: 'delegate',
    description: 'Delegate a task to an external AI model. Sync: blocks and returns result as tool output. Async (background=true): returns jobId, result via notification. Reuse sessionId for follow-up turns.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task prompt to send to the external model' },
        sessionId: { type: 'string', description: 'Existing session ID for follow-up. Omit to create new session.' },
        provider: { type: 'string', description: 'Required if no sessionId. openai, openai-oauth, anthropic, gemini, groq, openrouter, xai, copilot, ollama, lmstudio, local' },
        model: { type: 'string', description: 'Required if no sessionId. e.g., gpt-5.4-mini, gemini-2.5-pro' },
        role: { type: 'string', enum: ['Worker', 'Reviewer'], description: 'Agent template to inject' },
        preset: { type: 'string', enum: ['full', 'readonly', 'mcp'], description: 'Tool preset (default: full)' },
        context: { type: 'string', description: 'Additional context to inject' },
        background: { type: 'boolean', description: 'If true, returns immediately with jobId. Result arrives via notification.' },
        cwd: { type: 'string', description: 'Working directory for tool execution' },
      },
      required: ['task'],
    },
  },
  {
    name: 'get_workflows',
    description: 'List all available workflow plans (name + description).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_workflow',
    description: 'Get a specific workflow plan by name. Returns full JSON with steps.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name (e.g., "code-review")' },
      },
      required: ['name'],
    },
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

      case 'delegate': {
        // Resolve or create session
        let session;
        if (args.sessionId) {
          session = resumeSession(args.sessionId);
          if (!session) return fail(`Session "${args.sessionId}" not found`);
        } else {
          if (!args.provider || !args.model) return fail('provider and model are required when no sessionId is given');
          session = createSession({
            provider: args.provider, model: args.model,
            agent: args.role, preset: args.preset || 'full',
            cwd: args.cwd || process.cwd(),
          });
        }

        const startedAt = Date.now();

        // Background mode — fire, save result to file
        if (args.background) {
          const jobId = `job_${jobSeq++}_${Date.now()}`;
          const resultsDir = join(getPluginData(), 'results');
          mkdirSync(resultsDir, { recursive: true });
          const resultPath = join(resultsDir, `${jobId}.json`);

          askSession(session.id, args.task, args.context,
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
              const loopNote = result.iterations > 1 ? ` · ${result.iterations} loops, ${result.toolCallsTotal} tool calls` : '';
              const resultData = {
                jobId, sessionId: session.id, status: 'completed',
                provider: session.provider, model: session.model,
                content: result.content,
                usage: `${elapsed}s · ${inTok} in · ${outTok} out${loopNote}`,
              };
              writeFileSync(resultPath, JSON.stringify(resultData, null, 2));
              injectViaChannels(
                `**[${session.provider}/${session.model}]** (${elapsed}s)\n\n${result.content}\n\n---\n` +
                `_session: ${session.id} · ${inTok} in · ${outTok} out${loopNote}_`,
              );
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              writeFileSync(resultPath, JSON.stringify({
                jobId, sessionId: session.id, status: 'failed',
                provider: session.provider, model: session.model,
                error: msg,
              }, null, 2));
              injectViaChannels(`**[${session.provider}/${session.model}]** FAILED\n\n${msg}`);
            });
          return ok({ sessionId: session.id, jobId, status: 'working', resultPath });
        }

        // Sync mode — block and return result
        const result = await askSession(session.id, args.task, args.context,
          (iteration, calls) => {
            const names = calls.map(c => c.name).join(', ');
            notify(`🔧 [${session.provider}/${session.model}] Tool #${iteration}: ${names}`);
          },
          args.cwd,
        );
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const inTok = fmtTokens(result.usage?.inputTokens);
        const outTok = fmtTokens(result.usage?.outputTokens);
        const loopNote = result.iterations > 1 ? ` · ${result.iterations} loops, ${result.toolCallsTotal} tool calls` : '';
        return ok({
          sessionId: session.id,
          content: result.content,
          usage: `${elapsed}s · ${inTok} in · ${outTok} out${loopNote}`,
        });
      }

      case 'get_workflows': {
        const workflows = listWorkflows();
        return ok({ workflows });
      }

      case 'get_workflow': {
        if (!args.name) return fail('name is required');
        const workflow = getWorkflow(args.name);
        if (!workflow) return fail('workflow not found');
        return ok(workflow);
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
