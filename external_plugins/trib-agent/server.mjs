import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initProviders, getAllProviders } from './orchestrator/providers/registry.js';
import { createSession, askSession, listSessions, closeSession, resumeSession } from './orchestrator/session/manager.js';
import { loadConfig, getPluginData, listPresets, getDefaultPreset, setDefaultPreset } from './orchestrator/config.js';
import { connectMcpServers, disconnectAll, executeMcpTool } from './orchestrator/mcp/client.js';
import { listWorkflows, getWorkflow, seedDefaults } from './orchestrator/workflow-store.js';
import { writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { request as httpRequest } from 'http';
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
  // Try direct HTTP endpoint first (no MCP session overhead, survives reconnects)
  injectViaHttp(content).catch(() => {
    // Fallback to MCP tool call
    executeMcpTool('mcp__trib-channels__inject', { content, source: 'trib-agent' })
      .catch(() => { notify(content); });
  });
}

function injectViaHttp(content) {
  return new Promise((resolve, reject) => {
    try {
      const tmpDir = process.env.TEMP || process.env.TMP || '/tmp';
      const portFile = join(tmpDir, 'trib-channels', 'active-instance.json');
      const instance = JSON.parse(readFileSync(portFile, 'utf8'));
      if (!instance.httpPort) { reject(new Error('no httpPort')); return; }
      const payload = JSON.stringify({ content, source: 'trib-agent' });
      const req = httpRequest({
        hostname: '127.0.0.1', port: instance.httpPort, path: '/inject',
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 5000,
      }, (res) => { res.resume(); res.statusCode === 200 ? resolve() : reject(new Error(`${res.statusCode}`)); });
      req.on('error', reject);
      req.end(payload);
    } catch (e) { reject(e); }
  });
}

function buildInstructions() {
  const lines = [
    'CRITICAL: The `workflow` skill MUST be invoked before ANY task execution — no exceptions. This includes research, edits, fixes, exploration, and delegation. Skipping this skill is a violation of the execution protocol.',
    'Tools: `TeamCreate`, `TaskCreate`, `Agent`(subagent_type=Worker/Reviewer, team_name required).',
    'Lead can use any tool directly if it does not delay user response. Delegate long-running or parallel work to agents.',
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
        const sessions = listSessions();
        if (sessions.length === 0) return ok('No active sessions.');

        const choices = sessions.map((s, i) => {
          const msgs = s.messages.length;
          const inTok = fmtTokens(s.totalInputTokens || 0);
          const outTok = fmtTokens(s.totalOutputTokens || 0);
          return { const: String(i), title: `${s.provider}/${s.model} · ${msgs} msgs · ${inTok} in / ${outTok} out` };
        });

        try {
          const result = await server.elicitInput({
            message: `${sessions.length} active session(s). Select to resume:`,
            requestedSchema: {
              type: 'object',
              properties: {
                session: {
                  type: 'string',
                  title: 'Session',
                  oneOf: choices,
                  default: '0',
                },
              },
              required: ['session'],
            },
          });

          if (result.action === 'accept') {
            const idx = parseInt(result.content.session, 10);
            if (!isNaN(idx) && idx >= 0 && idx < sessions.length) {
              const selected = sessions[idx];
              if (selected) {
                const resumed = resumeSession(selected.id);
                if (resumed) {
                  return ok(`Active session: ${selected.id} · ${selected.provider}/${selected.model} · ${selected.messages.length} msgs`);
                }
              }
            }
          }
          // Declined or cancelled — silent exit
          return ok('');
        } catch {
          // Elicitation not supported — fall back to plain list
          return ok(sessions.map(s => ({
            id: s.id, provider: s.provider, model: s.model,
            messages: s.messages.length, tools: s.tools.length,
            inputTokens: s.totalInputTokens, outputTokens: s.totalOutputTokens,
            createdAt: new Date(s.createdAt).toISOString(),
          })));
        }
      }

      case 'close_session': {
        const closed = closeSession(args.sessionId);
        return ok(closed ? `Session ${args.sessionId} closed.` : `Session ${args.sessionId} not found.`);
      }

      case 'list_models': {
        const cfg = loadConfig();
        const presets = listPresets(cfg);
        const current = getDefaultPreset(cfg);

        if (presets.length === 0) {
          return ok('No presets configured. Use /trib-agent:config to add presets.');
        }

        // Build enum choices for elicitation dropdown
        const choices = presets.map((p, i) => {
          const parts = [p.model];
          if (p.effort) parts.push(p.effort);
          if (p.fast) parts.push('fast');
          return { const: String(i), title: parts.join(' · ') };
        });

        const currentIdx = current ? presets.findIndex(p => p.name === current.name) : 0;
        const currentLabel = current ? `${current.model}${current.effort ? ' · ' + current.effort : ''}${current.fast ? ' · fast' : ''}` : 'none';

        try {
          const result = await server.elicitInput({
            message: `Current: ${currentLabel}\nSelect a model preset:`,
            requestedSchema: {
              type: 'object',
              properties: {
                preset: {
                  type: 'string',
                  title: 'Model Preset',
                  oneOf: choices,
                  default: String(currentIdx >= 0 ? currentIdx : 0),
                },
              },
              required: ['preset'],
            },
          });

          if (result.action === 'accept') {
            const idx = parseInt(result.content.preset, 10);
            if (!isNaN(idx) && idx >= 0 && idx < presets.length) {
              const selected = presets[idx];
              if (selected) {
                setDefaultPreset(cfg, selected.name);
                return ok(`Default preset changed to: ${selected.model}${selected.effort ? ' · ' + selected.effort : ''}${selected.fast ? ' · fast' : ''}`);
              }
            }
          }
          // Declined or cancelled — silent exit
          return ok('');
        } catch {
          // Elicitation not supported by client — fall back to text list
          const lines = presets.map((p, i) => {
            const parts = [p.model];
            if (p.effort) parts.push(p.effort);
            if (p.fast) parts.push('fast');
            const mark = current && p.name === current.name ? '  ← active' : '';
            return `[${i}] ${parts.join(' · ')}${mark}`;
          });
          // Also list live provider models
          const results = [];
          for (const [provName, prov] of getAllProviders()) {
            try {
              const models = await prov.listModels();
              results.push({ provider: provName, models });
            } catch {
              results.push({ provider: provName, models: [], error: 'failed to list models' });
            }
          }
          return ok({ current: currentLabel, presets: lines, providers: results });
        }
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

        // Cleanup old result files (>24h)
        function cleanupOldResults(dir) {
          try {
            for (const f of readdirSync(dir)) {
              try { if (Date.now() - statSync(join(dir, f)).mtimeMs > 86400000) unlinkSync(join(dir, f)); } catch {}
            }
          } catch {}
        }

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
              try {
                writeFileSync(resultPath, JSON.stringify(resultData, null, 2));
                cleanupOldResults(resultsDir);
              } catch (writeErr) {
                process.stderr.write(`[trib-agent] Failed to write result file ${resultPath}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}\n`);
              }
              (async () => {
                try {
                  injectViaChannels(
                    `**[${session.provider}/${session.model}]** (${elapsed}s)\n\n${result.content}\n\n---\n` +
                    `_session: ${session.id} · ${inTok} in · ${outTok} out${loopNote}_`,
                  );
                } catch (injectErr) {
                  process.stderr.write(`[trib-agent] Failed to inject result via channels: ${injectErr instanceof Error ? injectErr.message : String(injectErr)}\n`);
                }
              })();
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              try {
                writeFileSync(resultPath, JSON.stringify({
                  jobId, sessionId: session.id, status: 'failed',
                  provider: session.provider, model: session.model,
                  error: msg,
                }, null, 2));
              } catch (writeErr) {
                process.stderr.write(`[trib-agent] Failed to write error result file ${resultPath}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}\n`);
              }
              (async () => {
                try {
                  injectViaChannels(`**[${session.provider}/${session.model}]** FAILED\n\n${msg}`);
                } catch (injectErr) {
                  process.stderr.write(`[trib-agent] Failed to inject error via channels: ${injectErr instanceof Error ? injectErr.message : String(injectErr)}\n`);
                }
              })();
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

  // Block until the MCP connection closes (stdin EOF).
  await new Promise((resolve) => { server.onclose = resolve });
}

main().catch((err) => {
  process.stderr.write(`[trib-agent] Failed to start: ${err}\n`);
  process.exit(1);
});
