import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initProviders } from './orchestrator/providers/registry.mjs';
import { createSession, askSession, listSessions, closeSession, resumeSession, findSessionByScopeKey, findOrCreateSession, updateSessionStatus } from './orchestrator/session/manager.mjs';
import { loadConfig, getPluginData, listPresets, getDefaultPreset, setDefaultPreset, resolveRuntimeSpec } from './orchestrator/config.mjs';
import { connectMcpServers, disconnectAll } from './orchestrator/mcp/client.mjs';
import { listWorkflows, getWorkflow, seedDefaults } from './orchestrator/workflow-store.mjs';
import { initTrajectoryStore, recordTrajectory } from './orchestrator/trajectory.mjs';
import { startCycle3, stopCycle3 } from './orchestrator/cycle3.mjs';
import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? dirname(fileURLToPath(import.meta.url));

function readPluginVersion() {
  try {
    const manifestPath = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
    return JSON.parse(readFileSync(manifestPath, 'utf8')).version || '0.0.1';
  } catch {
    return '0.0.1';
  }
}

const PLUGIN_VERSION = readPluginVersion();

function getServerElicitFn() {
  return typeof server.elicitInput === 'function' ? (opts) => server.elicitInput(opts) : null;
}

function buildInstructions() {
  const lines = [
    'External model delegation: use MCP `bridge` tool. Session-based, parallel, scope maps to preset.',
    'Native Claude agents: use Agent tool with trib-plugin:Worker.',
    'Orchestrator MCP tools: `bridge`, `create_session`, `list_sessions`, `close_session`, `list_models`.',
  ];

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

// Seed default workflows into user data dir if none exist yet.
seedDefaults();

const INSTRUCTIONS = buildInstructions();

// --- Prompt store (file-backed, shared with bin/bridge CLI) ---
const _promptStorePath = join(getPluginData(), 'prompt-store.json');
let _promptSeq = 0;

function _psLoad() {
  try {
    return JSON.parse(readFileSync(_promptStorePath, 'utf-8'));
  } catch {
    return {};
  }
}

function _psSave(store) {
  writeFileSync(_promptStorePath, JSON.stringify(store) + '\n', 'utf-8');
}

const _promptStore = {
  get(key) {
    return _psLoad()[key] ?? null;
  },
  set(key, val) {
    const store = _psLoad();
    store[key] = val;
    _psSave(store);
  },
  delete(key) {
    const store = _psLoad();
    delete store[key];
    _psSave(store);
  },
  has(key) {
    return key in _psLoad();
  },
};

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

// Format token counts in Claude Code style: <1000 as-is, >=1000 as "9.9k".
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
  {
    name: 'set_prompt',
    title: 'Store Prompt',
    description: 'Store a long prompt and get a short reference key. Use with bridge tool\'s ref parameter.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The prompt content to store' },
        file: { type: 'string', description: 'Read content from this file path instead of content param' },
        key: { type: 'string', description: 'Optional custom key. Auto-generated if omitted.' },
      },
    },
  },
  {
    name: 'skill_suggest',
    description: 'Analyze trajectory data and suggest skills from repeating patterns. Returns a report of skill candidates.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bridge',
    title: 'Ask External Model',
    description: 'Send a prompt to an external AI model. Returns immediately with jobId. Result delivered via notification. Scope determines the default preset (reviewer/debugger→GPT5.4, explorer→gpt5.4-mini). Use ref instead of prompt to reference a stored prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send (or use ref/file instead)' },
        ref: { type: 'string', description: 'Reference key from prompt store' },
        file: { type: 'string', description: 'Read prompt from this file path' },
        scope: { type: 'string', description: 'Agent scope: reviewer, debugger, explorer, etc.' },
        preset: { type: 'string', description: 'Override preset name (e.g., GPT5.4, gpt5.4-mini)' },
        context: { type: 'string', description: 'Additional context to prepend' },
      },
    },
  },
];

// --- Handlers ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};
  return handleToolCall(name, args, {
    notifyFn: notify,
    elicitFn: getServerElicitFn(),
  });
});

// ── Module exports (for unified server) ──────────────────────────────

export { TOOLS as TOOL_DEFS };
export { INSTRUCTIONS as instructions };

export async function init() {
  const config = loadConfig();
  await initProviders(config.providers);
  seedDefaults();
  initTrajectoryStore(getPluginData());
  if (config.mcpServers) await connectMcpServers(config.mcpServers);
  startCycle3();
}

/**
 * Handle a tool call from the unified server.
 * @param {string} name - tool name
 * @param {object} args - tool arguments
 * @param {{ notifyFn?: (text: string) => void, elicitFn?: (opts: object) => Promise<object> }} [opts]
 */
export async function handleToolCall(name, args, opts = {}) {
  const notifyFn = typeof opts.notifyFn === 'function' ? opts.notifyFn : notify;
  const elicit = typeof opts.elicitFn === 'function' ? opts.elicitFn : null;

  try {
    switch (name) {
      case 'create_session': {
        const session = createSession(args);
        return ok({
          sessionId: session.id,
          provider: session.provider,
          model: session.model,
          contextWindow: session.contextWindow,
          toolsAvailable: session.tools.length,
          toolNames: session.tools.map((t) => t.name),
        });
      }

      case 'list_sessions': {
        const sessions = listSessions();
        if (sessions.length === 0) return ok('No active sessions.');
        return ok(sessions.map((s) => ({
          id: s.id,
          provider: s.provider,
          model: s.model,
          messages: s.messages.length,
          tools: s.tools.length,
          sentTokens: s.totalInputTokens,
          receivedTokens: s.totalOutputTokens,
          scope: s.scopeKey || null,
          status: s.status || 'idle',
          createdAt: new Date(s.createdAt).toISOString(),
          updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
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
        if (presets.length === 0) return ok('No presets configured.');
        const currentLabel = current ? `${current.model}${current.effort ? ' · ' + current.effort : ''}${current.fast ? ' · fast' : ''}` : 'none';
        const choices = presets.map((p, i) => {
          const parts = [p.model];
          if (p.effort) parts.push(p.effort);
          if (p.fast) parts.push('fast');
          return { const: String(i), title: parts.join(' · ') };
        });
        const currentIdx = current ? presets.findIndex((p) => p.name === current.name) : 0;
        const elicitFn = elicit || getServerElicitFn();
        if (elicitFn) {
          try {
            const result = await elicitFn({
              message: `Current: ${currentLabel}\nSelect a model preset:`,
              requestedSchema: {
                type: 'object',
                properties: {
                  preset: { type: 'string', title: 'Model Preset', oneOf: choices, default: String(currentIdx >= 0 ? currentIdx : 0) },
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
            // Fall through to plain listing.
          }
        }
        const lines = presets.map((p, i) => {
          const parts = [p.name, p.model];
          if (p.effort) parts.push(p.effort);
          if (p.fast) parts.push('fast');
          const mark = current && p.name === current.name ? '  ← active' : '';
          return `[${i}] ${parts.join(' · ')}${mark}`;
        });
        return ok({ current: currentLabel, presets: lines });
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

      case 'set_prompt': {
        let content = args.content;
        if (!content && args.file) {
          try {
            content = readFileSync(args.file, 'utf-8');
          } catch (e) {
            return fail(`Cannot read file: ${e.message}`);
          }
        }
        if (!content) return fail('content or file is required');
        const key = args.key || `p${++_promptSeq}`;
        _promptStore.set(key, content);
        return ok(`Stored as '${key}' (${content.length} chars)`);
      }

      case 'skill_suggest': {
        let db = null;
        try {
          const { getTrajectoryDb } = await import('./orchestrator/trajectory.mjs');
          db = getTrajectoryDb();
        } catch { /* trajectory module not available yet */ }
        const { getSkillSuggestionReport } = await import('./orchestrator/skill-suggest.mjs');
        const report = db ? getSkillSuggestionReport(db) : 'Trajectory store not initialized.';
        return ok(report);
      }

      case 'bridge': {
        let prompt = args.prompt;
        if (!prompt && args.file) {
          try {
            prompt = readFileSync(args.file, 'utf-8');
          } catch (e) {
            return fail(`Cannot read file: ${e.message}`);
          }
        }
        if (!prompt && args.ref) {
          prompt = _promptStore.get(args.ref);
          if (!prompt) return fail(`ref "${args.ref}" not found in prompt store`);
          _promptStore.delete(args.ref);
        }
        if (!prompt) return fail('prompt, file, or ref is required');

        const config = loadConfig();
        // Load role→preset mapping from user-workflow.json
        const wfPath = join(getPluginData(), 'user-workflow.json');
        let rolePresets = {};
        try { const wf = JSON.parse(readFileSync(wfPath, 'utf-8')); if (Array.isArray(wf.roles)) for (const r of wf.roles) rolePresets[r.name] = r.preset; } catch {}
        // Resolve scope → preset: exact match first, then prefix ("reviewer-a" → "reviewer")
        const resolvedPreset = args.scope && (rolePresets[args.scope] || rolePresets[Object.keys(rolePresets).find((k) => args.scope.startsWith(k + '-')) || '']);
        const presetName = args.preset || resolvedPreset || null;

        let preset = null;
        if (presetName) {
          preset = config.presets?.find((x) => x.id === presetName || x.name === presetName);
          if (!preset) return fail(`preset "${presetName}" not found`);
        } else {
          preset = getDefaultPreset(config);
          if (!preset) return fail('No preset specified and no default configured');
        }

        const scope = args.scope || 'default';
        const effectiveLane = 'bridge';
        const runtimeSpec = resolveRuntimeSpec(preset, {
          lane: effectiveLane,
          agentId: effectiveLane === 'bridge' ? scope : undefined,
        });

        const found = findOrCreateSession(runtimeSpec.scopeKey, () => createSession({
          preset,
          owner: effectiveLane === 'bridge' ? 'bridge' : 'user',
          scopeKey: runtimeSpec.scopeKey,
          lane: runtimeSpec.lane,
          cwd: process.cwd(),
        }));
        let session = found.id ? resumeSession(found.id) || found : found;

        const jobId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const scopeLabel = args.scope || 'default';
        const modelLabel = preset.model || preset.name;
        const emit = notifyFn;

        (async () => {
          const t0 = Date.now();
          let completed = true;
          let errorMessage = null;
          let result = null;
          const toolCallLog = [];
          updateSessionStatus(session.id, 'running');
          try {
            result = await askSession(session.id, prompt, args.context || null, (iteration, calls) => { for (const c of calls) toolCallLog.push({ name: c.name, iteration }); }, process.cwd());
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            const inTok = fmtTokens(result.usage?.inputTokens);
            const outTok = fmtTokens(result.usage?.outputTokens);
            const loopNote = result.iterations > 1 ? ` · ${result.iterations} loops` : '';
            const content = result.content || '(empty response)';
            const footer = `${modelLabel} · ${inTok} in · ${outTok} out · ${elapsed}s${loopNote}`;
            emit(`[${scopeLabel}] ${content}\n\n${footer}`);
            updateSessionStatus(session.id, 'idle');
          } catch (err) {
            completed = false;
            errorMessage = err instanceof Error ? err.message : String(err);
            emit(`[${scopeLabel}] ❌ ${errorMessage}\n\n${modelLabel}`);
            updateSessionStatus(session.id, 'error');
          } finally {
            try {
              const cfg = loadConfig();
              if (cfg.trajectory?.enabled !== false) {
                recordTrajectory({
                  session_id: session.id,
                  scope: scopeLabel,
                  preset: presetName || preset.name,
                  model: modelLabel,
                  agent_type: 'bridge',
                  tool_calls_json: JSON.stringify(toolCallLog),
                  iterations: result?.iterations || 1,
                  tokens_in: result?.usage?.inputTokens || 0,
                  tokens_out: result?.usage?.outputTokens || 0,
                  duration_ms: Date.now() - t0,
                  completed: completed ? 1 : 0,
                  error_message: errorMessage,
                });
              }
            } catch {}
          }
        })();

        return ok(`${jobId} · ${scopeLabel} · ${modelLabel}`);
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err);
  }
}

export async function start() { /* noop — standalone mode uses main() */ }
export async function stop() { stopCycle3(); await disconnectAll(); }

// --- Init providers + MCP clients, then start (standalone) ---

if (process.env.TRIB_UNIFIED !== '1') {
  async function main() {
    // loadConfig handles legacy mcp-tools.json migration into config.json automatically
    const config = loadConfig();
    await initProviders(config.providers);
    initTrajectoryStore(getPluginData());

    // MCP tool servers come from config.mcpServers (config.json)
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      process.stderr.write(`[trib-agent] Loading ${Object.keys(config.mcpServers).length} MCP tool server(s) from config.json\n`);
      await connectMcpServers(config.mcpServers);
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);

    process.on('SIGINT', async () => {
      await disconnectAll();
      process.exit(0);
    });

    // Block until the MCP connection closes (stdin EOF).
    await new Promise((resolve) => {
      server.onclose = resolve;
    });
  }

  main().catch((err) => {
    process.stderr.write(`[trib-agent] Failed to start: ${err}\n`);
    process.exit(1);
  });
}
