import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initProviders, getAllProviders } from './orchestrator/providers/registry.js';
import { createSession, askSession, listSessions, closeSession, resumeSession } from './orchestrator/session/manager.js';
import { loadConfig, getPluginData, listPresets, getPreset, getDefaultPreset, setDefaultPreset } from './orchestrator/config.js';
import { connectMcpServers, disconnectAll, executeMcpTool } from './orchestrator/mcp/client.js';
import { listWorkflows, getWorkflow, seedDefaults } from './orchestrator/workflow-store.js';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
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

function injectViaChannels(content, { type, instruction } = {}) {
  // Try direct HTTP endpoint first (no MCP session overhead, survives reconnects)
  injectViaHttp(content, { type, instruction }).catch(() => {
    // Fallback to MCP tool call — preserve type/instruction
    const toolArgs = { content, source: 'trib-agent' };
    if (type) toolArgs.type = type;
    if (instruction) toolArgs.instruction = instruction;
    executeMcpTool('mcp__trib-plugin__inject', toolArgs)
      .catch(() => { notify(content); });
  });
}

function injectViaHttp(content, { type, instruction } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const tmpDir = process.env.TEMP || process.env.TMP || '/tmp';
      const portFile = join(tmpDir, 'trib-plugin', 'active-instance.json');
      const instance = JSON.parse(readFileSync(portFile, 'utf8'));
      if (!instance.httpPort) { reject(new Error('no httpPort')); return; }
      const body = { content, source: 'trib-agent' };
      if (type) body.type = type;
      if (instruction) body.instruction = instruction;
      const payload = JSON.stringify(body);
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
    'CRITICAL: invoke `workflow` skill before ANY task execution — no exceptions.',
    'Enforcement: TeamCreate before Worker/Reviewer. Independent agents in parallel (one message, multiple Agent calls). bypassPermissions and run_in_background on every Agent call.',
    'Lead uses tools directly for fast ops. Delegate slow/parallel work to background agents.',
    '',
    'Orchestrator MCP tools: `create_session`, `list_sessions`, `close_session`, `list_models`, `get_workflows`, `get_workflow`.',
    'Delegation to external models: use the `delegate` skill/agent (routes through cli.js delegate).',
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

/** @type {((text: string) => void) | null} */
let _notifyFn = null;

function notify(text) {
  if (_notifyFn) { _notifyFn(text); return; }
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

// ── Module exports (for unified server) ──────────────────────────────

export { TOOLS as TOOL_DEFS };
export { INSTRUCTIONS as instructions };

export async function init() {
  const config = loadConfig();
  await initProviders(config.providers);
  seedDefaults();
  if (config.mcpServers) await connectMcpServers(config.mcpServers);
}

/**
 * Handle a tool call from the unified server.
 * @param {string} name - tool name
 * @param {object} args - tool arguments
 * @param {{ notifyFn?: (text: string) => void, elicitFn?: (opts: object) => Promise<object> }} [opts]
 */
export async function handleToolCall(name, args, opts = {}) {
  if (opts.notifyFn) _notifyFn = opts.notifyFn;
  const elicit = opts.elicitFn || null;

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

        if (elicit) {
          try {
            const result = await elicit({
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
            return ok('');
          } catch {
            // Elicitation not supported — fall back to plain list
          }
        }
        return ok(sessions.map(s => ({
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
        const cfg = loadConfig();
        const presets = listPresets(cfg);
        const current = getDefaultPreset(cfg);

        if (presets.length === 0) {
          return ok('No presets configured. Use /trib-agent:config to add presets.');
        }

        const choices = presets.map((p, i) => {
          const parts = [p.model];
          if (p.effort) parts.push(p.effort);
          if (p.fast) parts.push('fast');
          return { const: String(i), title: parts.join(' · ') };
        });

        const currentIdx = current ? presets.findIndex(p => p.name === current.name) : 0;
        const currentLabel = current ? `${current.model}${current.effort ? ' · ' + current.effort : ''}${current.fast ? ' · fast' : ''}` : 'none';

        if (elicit) {
          try {
            const result = await elicit({
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
            return ok('');
          } catch {
            // Elicitation not supported — fall back to text list
          }
        }
        // Fallback: text list
        const lines = presets.map((p, i) => {
          const parts = [p.model];
          if (p.effort) parts.push(p.effort);
          if (p.fast) parts.push('fast');
          const mark = current && p.name === current.name ? '  ← active' : '';
          return `[${i}] ${parts.join(' · ')}${mark}`;
        });
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
}

export async function start() { /* noop — standalone mode uses main() */ }
export async function stop() { await disconnectAll(); }

// --- Init providers + MCP clients, then start (standalone) ---

if (process.env.TRIB_UNIFIED !== '1') {
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
}
