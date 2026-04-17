import { initProviders } from './orchestrator/providers/registry.mjs';
import { createSession, askSession, listSessions, closeSession, resumeSession, findSessionByScopeKey, findOrCreateSession, updateSessionStatus, getSessionRuntime, SessionClosedError, setSmartBridge, resetStatelessSession, forEachSessionRuntime } from './orchestrator/session/manager.mjs';
import { ToolLoopAbortError } from './orchestrator/tool-loop-guard.mjs';
import { StreamStalledAbortError, startWatchdog as startStreamWatchdog } from './orchestrator/session/stream-watchdog.mjs';
import { loadConfig, getPluginData, listPresets, getDefaultPreset, setDefaultPreset, resolveRuntimeSpec } from './orchestrator/config.mjs';
import { connectMcpServers, disconnectAll } from './orchestrator/mcp/client.mjs';
import { setInternalToolsProvider } from './orchestrator/internal-tools.mjs';
import { listWorkflows, getWorkflow, seedDefaults } from './orchestrator/workflow-store.mjs';
import { initTrajectoryStore, recordTrajectory } from './orchestrator/trajectory.mjs';
import { ensureDataSeeds } from '../shared/seed.mjs';
import { startAgentMaintenance, stopAgentMaintenance } from './orchestrator/agent-maintenance.mjs';
import { writeFileSync, readFileSync, existsSync, watch } from 'fs';
import { join } from 'path';

// --- user-workflow.json loader ---
// The plugin already persists user role -> preset mapping in
//   <plugin-data>/user-workflow.json
// Smart Bridge consumes this directly instead of introducing a duplicate
// config key. fs.watch keeps Smart Bridge in sync when the user edits roles.

/**
 * @typedef {Object} RoleConfig
 * @property {string}      name               - unique role identifier
 * @property {string}      preset             - preset name from agent-config presets
 * @property {'read'|'read-write'|'full'} permission - tool permission category
 * @property {string|null} desc_path          - relative to CLAUDE_PLUGIN_ROOT
 * @property {'stateful'|'stateless'} behavior - pool-reuse semantics; drives cache strategy
 */

const VALID_PERMISSIONS = new Set(['read', 'read-write', 'full']);
const VALID_BEHAVIORS = new Set(['stateful', 'stateless']);

// Default behavior per-role when user-workflow.json omits the field.
// The 5 stateful roles run multi-turn; the 4 maintenance-ish roles are
// one-shot dispatches that must not leak transcript across calls.
const DEFAULT_BEHAVIOR = {
  worker: 'stateful',
  debugger: 'stateful',
  reviewer: 'stateful',
  researcher: 'stateful',
  tester: 'stateful',
  maintenance: 'stateless',
  'webhook-handler': 'stateless',
  'scheduler-task': 'stateless',
  'proactive-decision': 'stateless',
};

function applyRoleDefaults(raw) {
  const permission = VALID_PERMISSIONS.has(raw.permission) ? raw.permission : 'full';
  const desc_path = typeof raw.desc_path === 'string' ? raw.desc_path : null;
  const rawBehavior = typeof raw.behavior === 'string' ? raw.behavior : null;
  const behavior = VALID_BEHAVIORS.has(rawBehavior)
    ? rawBehavior
    : (DEFAULT_BEHAVIOR[raw.name] || 'stateful');

  return {
    name: raw.name,
    preset: raw.preset,
    permission,
    desc_path,
    behavior,
  };
}

function validateRoleConfig(role) {
  if (!role.name || typeof role.name !== 'string')
    throw new Error(`[user-workflow] role entry missing "name"`);
  if (!role.preset || typeof role.preset !== 'string')
    throw new Error(`[user-workflow] role "${role.name}" missing "preset"`);
  if (!VALID_PERMISSIONS.has(role.permission))
    throw new Error(`[user-workflow] role "${role.name}": invalid permission "${role.permission}" (expected: ${[...VALID_PERMISSIONS].join(", ")})`);
  if (!VALID_BEHAVIORS.has(role.behavior))
    throw new Error(`[user-workflow] role "${role.name}": invalid behavior "${role.behavior}" (expected: ${[...VALID_BEHAVIORS].join(", ")})`);
}

/** @type {Map<string, RoleConfig>} */
let _roleConfigCache = new Map();

function loadResolvedRoles() {
  const path = join(getPluginData(), 'user-workflow.json');
  const map = new Map();
  if (!existsSync(path)) return map;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(data?.roles)) {
      for (const raw of data.roles) {
        if (!raw?.name || !raw?.preset) continue;
        const resolved = applyRoleDefaults(raw);
        validateRoleConfig(resolved);
        map.set(resolved.name, resolved);
      }
    }
  } catch (e) {
    process.stderr.write(`[user-workflow] load error: ${e.message}\n`);
  }
  return map;
}

function loadUserWorkflowRoles() {
  _roleConfigCache = loadResolvedRoles();
  const out = {};
  for (const [name, cfg] of _roleConfigCache) out[name] = cfg.preset;
  return out;
}

/**
 * Get the fully-resolved RoleConfig for a given role name.
 * @param {string} roleName
 * @returns {RoleConfig|null}
 */
export function getRoleConfig(roleName) {
  return _roleConfigCache.get(roleName) ?? null;
}

let _userWorkflowWatcher = null;
function watchUserWorkflow(onChange) {
  if (_userWorkflowWatcher) return;
  const dir = getPluginData();
  try {
    _userWorkflowWatcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename === 'user-workflow.json') {
        try { onChange(loadUserWorkflowRoles()); } catch {}
      }
    });
  } catch {
    // fs.watch can fail on some platforms — best effort only.
  }
}

const AGENT_MCP_BASE = (() => {
  try {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (!root) return '';
    return readFileSync(join(root, 'rules', 'mcp-orchestration.md'), 'utf8').trim();
  } catch (e) {
    process.stderr.write(`[agent] rules/mcp-orchestration.md load failed: ${e.message}\n`);
    return '';
  }
})();

function buildInstructions() {
  const lines = [];
  if (AGENT_MCP_BASE) lines.push(AGENT_MCP_BASE);

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

// Seed plugin-owned scaffolding files (memory-config.json, etc.) so
// first-time installs land with the Pool B surface populated and the Config
// UI has real paths to edit.
ensureDataSeeds(getPluginData());

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

// --- Helpers ---

function ok(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function fail(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
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
    description: 'Create an external AI session. Auto-injects CLAUDE.md, agent rules, skills. Registers builtin+MCP tools. Optional Smart Bridge routing via taskType/role/profileId: when provided, a profile is resolved and its cache strategy + context filters are applied automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'openai, openai-oauth, anthropic, anthropic-oauth, gemini, groq, openrouter, xai, copilot, ollama, lmstudio, local' },
        model: { type: 'string', description: 'e.g., gpt-4o, claude-sonnet-4-0, gemini-2.5-pro' },
        systemPrompt: { type: 'string', description: 'Additional system prompt' },
        agent: { type: 'string', description: 'Agent template: "Worker", "Reviewer"' },
        preset: { type: 'string', enum: ['full', 'readonly', 'mcp'], description: 'Tool preset (default: full)' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
        cwd: { type: 'string', description: 'Working directory for builtin tool execution and CLAUDE.md/agents/skills lookup. Pass the project root (e.g. C:/Project). Defaults to MCP server cwd.' },
        taskType: { type: 'string', description: 'Smart Bridge routing: "maintenance", "worker", "reviewer", "researcher", "tester", "debugger", "one-shot", "lead". Picks a profile that controls cache strategy and context filtering.' },
        role: { type: 'string', description: 'Smart Bridge routing: user-defined role ("worker", "reviewer", etc). Mapped via user-workflow.json.' },
        profileId: { type: 'string', description: 'Smart Bridge routing: explicit profile id (e.g. "maintenance-light", "worker-full"). Overrides taskType/role.' },
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
    name: 'bridge_spawn',
    title: 'Spawn Bridge Agent',
    description: 'Create a Smart Bridge agent session with a role/taskType and optionally send the first prompt. Replacement for native Agent/TeamCreate flow — no team container required, sessions are standalone. When wait=true, returns the agent\'s first response synchronously. When wait=false, returns sessionId immediately for later bridge_send calls.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role: worker, reviewer, researcher, tester, debugger (mapped to profile via user-workflow.json).' },
        taskType: { type: 'string', description: 'Explicit task type override (maintenance, one-shot, etc).' },
        profileId: { type: 'string', description: 'Explicit profile id (overrides role/taskType).' },
        prompt: { type: 'string', description: 'Initial prompt for the agent. Required when wait=true.' },
        wait: { type: 'boolean', description: 'When true, send prompt and return the response. When false, return sessionId for later use. Default: true if prompt given, false otherwise.' },
        provider: { type: 'string', description: 'Override provider (defaults to profile.preferredProviders[0]).' },
        model: { type: 'string', description: 'Override model.' },
        cwd: { type: 'string', description: 'Working directory for agent tool execution.' },
      },
    },
  },
  {
    name: 'bridge_send',
    title: 'Send to Bridge Agent',
    description: 'Send a message to an existing bridge agent session. Returns the agent\'s response synchronously. Replacement for SendMessage in native team flow.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id returned by bridge_spawn or create_session.' },
        message: { type: 'string', description: 'Message content to send.' },
      },
      required: ['sessionId', 'message'],
    },
  },
  {
    name: 'bridge',
    title: 'Ask External Model',
    description: 'Send a prompt to an external AI model via Smart Bridge. The role field resolves to a preset via user-workflow.json, which in turn maps to model/provider. Returns immediately with jobId; result delivered via notification.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send (or use ref/file instead)' },
        role: { type: 'string', description: 'Role primitive only: worker, reviewer, researcher, debugger, tester. Mapped to preset via user-workflow.json. No suffix variants accepted.' },
        ref: { type: 'string', description: 'Reference key from prompt store' },
        file: { type: 'string', description: 'Read prompt from this file path' },
        context: { type: 'string', description: 'Additional context to prepend' },
        cwd: { type: 'string', description: 'Working directory for agent tool execution. Defaults to MCP server cwd.' },
      },
      required: ['prompt', 'role'],
    },
  },
];

// ── Module exports (for unified server) ──────────────────────────────

export { TOOLS as TOOL_DEFS };
export { INSTRUCTIONS as instructions };

export async function init() {
  const config = loadConfig();
  await initProviders(config.providers);
  seedDefaults();
  initTrajectoryStore(getPluginData());
  // External MCP servers only. Self-MCP loopback (mcpServers.trib-plugin)
  // is rejected — agent exposes the plugin's own tools (search,
  // search_memories, ...) in-process via the context injected by server.mjs;
  // no network round-trip, no self-spawn. search/search_memories are
  // guaranteed by the static tools.json manifest, so the prior FATAL check
  // is obsolete.
  const rawServers = (config.mcpServers && typeof config.mcpServers === 'object') ? config.mcpServers : {};
  const externalServers = {};
  for (const [name, cfg] of Object.entries(rawServers)) {
    if (name === 'trib-plugin') {
      process.stderr.write(`[mcp] dropping legacy self-ref mcpServers.trib-plugin entry (in-process tool bridge is used instead)\n`);
      continue;
    }
    externalServers[name] = cfg;
  }
  if (Object.keys(externalServers).length > 0) {
    await connectMcpServers(externalServers);
  }
  startAgentMaintenance();
  startStreamWatchdog(forEachSessionRuntime);
  // Smart Bridge — unified router + cache strategy + profile system.
  // User-role preset mapping comes from user-workflow.json (existing source
  // of truth). Preset catalog (provider/model/effort) comes from config.presets.
  try {
    const { initSmartBridge, getSmartBridge, setRoleResolver } = await import('./orchestrator/smart-bridge/index.mjs');
    const userRoles = loadUserWorkflowRoles();
    const presets = config.presets || [];
    // Inject the role resolver so SmartBridge.resolveSync() can read role
    // configs without lazy-importing this module (avoids the circular
    // require that the old router.mjs had).
    setRoleResolver(getRoleConfig);
    const sb = initSmartBridge({ userRoles, presets });
    // Inject into session manager so createSession() can resolve profiles
    // synchronously (no lazy-import race).
    setSmartBridge(sb);
    // Keep Smart Bridge in sync with user-workflow.json edits.
    watchUserWorkflow((nextRoles) => {
      try { getSmartBridge().updateUserRoles(nextRoles); } catch {}
    });
  } catch (e) {
    process.stderr.write(`[smart-bridge] init skipped: ${e.message}\n`);
  }
}

/**
 * Handle a tool call from the unified server.
 * @param {string} name - tool name
 * @param {object} args - tool arguments
 * @param {{ notifyFn?: (text: string) => void, elicitFn?: (opts: object) => Promise<object> }} [opts]
 */
export async function handleToolCall(name, args, opts = {}) {
  const notifyFn = typeof opts.notifyFn === 'function' ? opts.notifyFn : null;
  const elicit = typeof opts.elicitFn === 'function' ? opts.elicitFn : null;
  // Idempotent fallback — server.mjs populates the registry at boot via
  // loadModule('agent').then(...), but if eager init failed (missing deps,
  // file error), the first tool call still restores it here. Re-registration
  // is safe: setInternalToolsProvider replaces the executor/tools refs.
  if (typeof opts.toolExecutor === 'function' && Array.isArray(opts.internalTools)) {
    setInternalToolsProvider({
      executor: opts.toolExecutor,
      tools: opts.internalTools,
    });
  }

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

      case 'bridge_spawn': {
        // Smart Bridge agent spawn — replacement for native Agent tool flow.
        // Resolves profile → creates session → optionally sends initial prompt.
        const smartArgs = {
          role: args.role,
          taskType: args.taskType,
          profileId: args.profileId,
          cwd: args.cwd || process.cwd(),
          owner: 'bridge',
          lane: 'bridge',
          systemPrompt: args.systemPrompt,
        };
        if (args.provider) smartArgs.provider = args.provider;
        if (args.model) smartArgs.model = args.model;
        // Need either role/taskType/profileId OR explicit provider+model.
        if (!smartArgs.role && !smartArgs.taskType && !smartArgs.profileId
            && !(smartArgs.provider && smartArgs.model)) {
          return fail('bridge_spawn: role, taskType, profileId, or provider+model required');
        }
        // Let Smart Bridge derive provider/model from profile.fallbackPreset →
        // config.presets catalog. No hardcoded preset-to-model mapping here.
        if ((!smartArgs.provider || !smartArgs.model)
            && (smartArgs.role || smartArgs.taskType || smartArgs.profileId)) {
          try {
            const { getSmartBridge } = await import('./orchestrator/smart-bridge/index.mjs');
            const resolved = getSmartBridge().resolveSync({
              role: smartArgs.role,
              taskType: smartArgs.taskType,
              profileId: smartArgs.profileId,
            });
            if (resolved) {
              smartArgs.provider = smartArgs.provider || resolved.provider;
              smartArgs.model = smartArgs.model || resolved.model;
            }
          } catch { /* fall through — createSession will throw if incomplete */ }
        }
        const session = createSession(smartArgs);
        const shouldWait = args.wait === false ? false : !!args.prompt;
        if (shouldWait) {
          try {
            const result = await askSession(session.id, args.prompt);
            return ok({
              sessionId: session.id,
              profileId: session.profileId,
              provider: session.provider,
              model: session.model,
              response: result.content,
              usage: result.usage,
            });
          } catch (err) {
            return fail(`bridge_spawn ask failed: ${err.message}`);
          }
        }
        return ok({
          sessionId: session.id,
          profileId: session.profileId,
          provider: session.provider,
          model: session.model,
          hint: 'Use bridge_send(sessionId, message) to converse with this agent.',
        });
      }

      case 'bridge_send': {
        const sessionId = args.sessionId;
        const message = args.message;
        if (!sessionId || !message) return fail('bridge_send: sessionId and message are required');
        try {
          const result = await askSession(sessionId, message);
          return ok({
            sessionId,
            response: result.content,
            usage: result.usage,
          });
        } catch (err) {
          if (err instanceof SessionClosedError) {
            return fail(`Session ${sessionId} is closed`);
          }
          return fail(`bridge_send failed: ${err.message}`);
        }
      }

      case 'list_sessions': {
        const sessions = listSessions();
        if (sessions.length === 0) return ok('No active sessions.');
        const now = Date.now();
        return ok(sessions.map((s) => {
          const runtime = getSessionRuntime(s.id);
          // No runtime entry → session has no in-flight work; stage derives from
          // persisted status ('running' is only set by long-running callers; idle
          // otherwise). Single derivation, no legacy fallback path.
          const persistedStatus = s.status || 'idle';
          // Phase J: tombstones override status/stage. The persisted `status`
          // field may still be 'running' because close_session aborts rather
          // than touches it; `closed: true` is the authoritative signal.
          const isClosed = s.closed === true;
          const status = isClosed ? 'closed' : persistedStatus;
          const stage = isClosed
            ? 'closed'
            : (runtime?.stage || (persistedStatus === 'running' ? 'connecting' : 'idle'));
          const lastStreamDeltaAt = runtime?.lastStreamDeltaAt
            ? new Date(runtime.lastStreamDeltaAt).toISOString()
            : null;
          const staleSeconds = runtime?.lastStreamDeltaAt
            ? Math.floor((now - runtime.lastStreamDeltaAt) / 1000)
            : null;
          return {
            id: s.id,
            provider: s.provider,
            model: s.model,
            messages: s.messages.length,
            tools: s.tools.length,
            toolNames: Array.isArray(s.tools) ? s.tools.map((t) => t?.name).filter(Boolean) : [],
            sentTokens: s.totalInputTokens,
            receivedTokens: s.totalOutputTokens,
            scope: s.scopeKey || null,
            status,
            lastStatus: persistedStatus,
            createdAt: new Date(s.createdAt).toISOString(),
            updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
            stage,
            lastStreamDeltaAt,
            staleSeconds,
            lastToolCall: runtime?.lastToolCall || null,
          };
        }));
      }

      case 'close_session': {
        // Fire-and-forget: plant tombstone, abort in-flight controller, defer
        // cleanup. We don't wait for the abort to unwind — callers get an
        // immediate ack and unknown IDs return the same shape for simplicity
        // (Q1: unified {ok: true}).
        closeSession(args.sessionId);
        return ok({ ok: true, sessionId: args.sessionId });
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
        if (elicit) {
          try {
            const result = await elicit({
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
        if (!args.role) return fail('role is required');

        const config = loadConfig();
        // Load role→preset mapping from user-workflow.json. Role primitives only —
        // no suffix variants, exact match required.
        const wfPath = join(getPluginData(), 'user-workflow.json');
        let rolePresets = {};
        try { const wf = JSON.parse(readFileSync(wfPath, 'utf-8')); if (Array.isArray(wf.roles)) for (const r of wf.roles) rolePresets[r.name] = r.preset; } catch {}
        const presetName = rolePresets[args.role];
        if (!presetName) return fail(`role "${args.role}" not found in user-workflow.json`);

        let preset = config.presets?.find((x) => x.id === presetName || x.name === presetName);
        if (!preset) return fail(`preset "${presetName}" (mapped from role "${args.role}") not found in agent-config.json`);
        if (preset?.type === 'native') {
          const { translateNativePreset } = await import('./orchestrator/smart-bridge/index.mjs');
          preset = translateNativePreset(preset);
        }

        const role = args.role;
        const effectiveLane = 'bridge';
        const runtimeSpec = resolveRuntimeSpec(preset, {
          lane: effectiveLane,
          agentId: role,
        });

        const effectiveCwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();
        const createFreshSession = () => createSession({
          preset,
          owner: 'bridge',
          scopeKey: runtimeSpec.scopeKey,
          lane: runtimeSpec.lane,
          cwd: effectiveCwd,
          // Smart Bridge resolveSync picks a profile from the role.
          role,
          // Tag the usage row so bridge-trace analytics can slice lead
          // calls by the requested role (worker / reviewer / ...).
          sourceType: 'lead',
          sourceName: role,
        });
        const found = findOrCreateSession(runtimeSpec.scopeKey, createFreshSession);
        // resumeSession returns null for tombstoned / unresumable sessions.
        // In that case spin up a fresh session instead of returning the raw
        // closed record — a tombstone must never reach the caller, it would
        // be aborted immediately by the abort-controller wired during close.
        let session;
        if (found.id) {
          session = resumeSession(found.id);
          if (!session) {
            session = createFreshSession();
          }
        }
        else {
          session = found;
        }
        // Stateless profiles (sub-task, maintenance, etc.) carry no transcript
        // across dispatches. Truncate the message list to the initial Pool B
        // head so the provider cache handle stays warm while no prior-task
        // transcript leaks into the next call.
        if (session?.behavior === 'stateless' && session?.id) {
          try {
            const reset = resetStatelessSession(session.id);
            if (reset) session = reset;
          } catch (e) {
            process.stderr.write(`[bridge] stateless reset failed: ${e.message}\n`);
          }
        }

        const jobId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const modelLabel = preset.model || preset.name;
        const emit = notifyFn || (() => {});

        (async () => {
          const t0 = Date.now();
          let completed = true;
          let errorMessage = null;
          let result = null;
          const toolCallLog = [];
          updateSessionStatus(session.id, 'running');
          emit(`[${role}] started · ${modelLabel}`);
          try {
            result = await askSession(session.id, prompt, args.context || null, (iteration, calls) => { for (const c of calls) toolCallLog.push({ name: c.name, iteration }); }, effectiveCwd);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            const inTok = fmtTokens(result.usage?.inputTokens);
            const outTok = fmtTokens(result.usage?.outputTokens);
            const loopNote = result.iterations > 1 ? ` · ${result.iterations} loops` : '';
            const content = result.content || '(empty response)';
            const footer = `${modelLabel} · ${inTok} in · ${outTok} out · ${elapsed}s${loopNote}`;
            emit(`[${role}] ${content}\n\n${footer}`);
            updateSessionStatus(session.id, 'idle');
          } catch (err) {
            completed = false;
            errorMessage = err instanceof Error ? err.message : String(err);
            if (err instanceof SessionClosedError) {
              emit(`[${role}] ⏹ cancelled\n\n${modelLabel}`);
            } else if (err instanceof StreamStalledAbortError) {
              const info = err.info || {};
              const header = `⚠ stream stalled — ${info.staleSeconds}s no delta (stage: ${info.stage || 'unknown'})`;
              const body = `last tool call: ${info.lastToolCall || 'none'}\nprovider likely hung. Retry with a shorter prompt or a different provider.`;
              emit(`[${role}] ${header}\n${body}\n\n${modelLabel}`);
              updateSessionStatus(session.id, 'error');
            } else if (err instanceof ToolLoopAbortError) {
              const info = err.info || {};
              const header = `⚠ tool loop aborted — ${info.attemptCount}× ${info.toolName}:${info.errorCategory}`;
              const body = [
                `signature: ${info.signature}`,
                `last error: ${String(info.errorSample || '').slice(0, 200)}`,
                `args: ${String(info.argsSample || '').slice(0, 200)}`,
              ].join('\n');
              emit(`[${role}] ${header}\n${body}\n\n${modelLabel}`);
              updateSessionStatus(session.id, 'error');
            } else {
              emit(`[${role}] ❌ ${errorMessage}\n\n${modelLabel}`);
              updateSessionStatus(session.id, 'error');
            }
          } finally {
            try {
              const cfg = loadConfig();
              if (cfg.trajectory?.enabled !== false) {
                recordTrajectory({
                  session_id: session.id,
                  scope: role,
                  preset: presetName,
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

        return ok(`${jobId} · ${role} · ${modelLabel}`);
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err);
  }
}

export async function start() { /* noop — standalone mode uses main() */ }
export async function stop() { stopAgentMaintenance(); await disconnectAll(); }
