import { createRequire } from 'module';
import { join } from 'path';
import { homedir } from 'os';
import { getProvider } from '../providers/registry.mjs';
import { agentLoop } from './loop.mjs';
import { getMcpTools } from '../mcp/client.mjs';
import { getInternalTools } from '../internal-tools.mjs';
import { BUILTIN_TOOLS } from '../tools/builtin.mjs';
import { collectSkillsCached, buildSkillToolDefs, loadAgentTemplate, loadRoleTemplate, composeSystemPrompt, collectProjectMd } from '../context/collect.mjs';
import { saveSession, loadSession, deleteSession, listStoredSessions, getStoredSessionsRaw, sweepStaleSessions, markSessionClosed } from './store.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import { logLlmCall } from '../../../shared/llm/usage-log.mjs';

// Phase B: Pool B Tier 2 content builder (common rules only).
// Loaded once per process via createRequire so the CJS module reaches us.
const _require = createRequire(import.meta.url);
const _rulesBuilder = (() => {
    const candidates = [
        process.env.CLAUDE_PLUGIN_ROOT && join(process.env.CLAUDE_PLUGIN_ROOT, 'lib', 'rules-builder.cjs'),
    ].filter(Boolean);
    for (const p of candidates) {
        try { return _require(p); } catch { /* fall through */ }
    }
    // Fallback: walk up from this file's location to find lib/rules-builder.cjs.
    try { return _require('../../../../lib/rules-builder.cjs'); } catch { return null; }
})();

function _buildBridgeRules() {
    if (!_rulesBuilder || typeof _rulesBuilder.buildBridgeInjectionContent !== 'function') return '';
    const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
        || join(homedir(), '.claude', 'plugins', 'marketplaces', 'trib-plugin', 'external_plugins', 'trib-plugin');
    const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
        || join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin');
    try {
        return _rulesBuilder.buildBridgeInjectionContent({ PLUGIN_ROOT, DATA_DIR });
    } catch (e) {
        process.stderr.write(`[session] bridge rules build failed: ${e.message}\n`);
        return '';
    }
}

// Smart Bridge is optional — injected via setSmartBridge() during plugin init
// so session creation never depends on a circular import. If never injected,
// createSession simply falls back to classic preset-only behavior.
let _smartBridgeApi = null;
let _smartBridgeWarned = false;

/**
 * Inject the Smart Bridge singleton. Called once by agent/index.mjs init()
 * after initSmartBridge(). Safe to call multiple times — later calls
 * replace the previous reference.
 */
export function setSmartBridge(api) {
    _smartBridgeApi = api || null;
}

function getSmartBridgeSync() {
    return _smartBridgeApi;
}

// ── Phase B §6 Worker lifecycle triggers ────────────────────────────────
// Defaults can be overridden per call via opts or via agent-config.json →
// { workerLifecycle: { idleMs, softTokens, hardTokens } }.
const DEFAULT_LIFECYCLE = Object.freeze({
    idleMs: 5 * 60 * 1000,
    softTokens: 150_000,
    hardTokens: 180_000,
});

function _lifecycleConfig(opts = {}) {
    return {
        idleMs: opts.idleMs ?? DEFAULT_LIFECYCLE.idleMs,
        softTokens: opts.softTokens ?? DEFAULT_LIFECYCLE.softTokens,
        hardTokens: opts.hardTokens ?? DEFAULT_LIFECYCLE.hardTokens,
    };
}

/**
 * Classify a session against Phase B §6 close triggers.
 *
 * Returns one of:
 *   null             — session still usable
 *   'idle'           — last completed ask() older than idleMs
 *   'hard-tokens'    — cumulative tokens ≥ hardTokens (must close)
 *   'soft-tokens'    — cumulative tokens ≥ softTokens (schedule close)
 *
 * Callers (bridge_spawn / askSession wrappers) decide how to act: hard-tokens
 * and idle trigger close-and-respawn immediately; soft-tokens may defer.
 */
export function isSessionStale(session, opts = {}) {
    if (!session) return null;
    const cfg = _lifecycleConfig(opts);
    const now = Date.now();
    const tokens = session.tokensCumulative || 0;
    if (tokens >= cfg.hardTokens) return 'hard-tokens';
    const lastUsed = session.lastUsedAt || session.updatedAt || session.createdAt || now;
    if (now - lastUsed > cfg.idleMs) return 'idle';
    if (tokens >= cfg.softTokens) return 'soft-tokens';
    return null;
}

/**
 * Thrown when a session is closed while a call is in-flight. Callers (bridge
 * handler, CLI) should render this as "cancelled" rather than a hard error.
 */
export class SessionClosedError extends Error {
    constructor(sessionId, reason) {
        super(reason ? `Session "${sessionId}" closed: ${reason}` : `Session "${sessionId}" closed`);
        this.name = 'SessionClosedError';
        this.sessionId = sessionId;
        this.cancelled = true;
    }
}
let _mcpToolsCache = null;
let _mcpToolsCacheTime = 0;
const MCP_CACHE_TTL = 60000; // 1 minute

function _getMcpToolsCached() {
    const now = Date.now();
    if (!_mcpToolsCache || now - _mcpToolsCacheTime > MCP_CACHE_TTL) {
        // Merge externally-connected MCP tools with the plugin's in-process
        // tools (registered by agent's toolExecutor bridge). Internal tools
        // are exposed to LLMs under their bare names (search, search_memories,
        // reply, ...) — no mcp__ prefix, since the dispatcher in server.mjs
        // handles them directly without a transport.
        const mcp = getMcpTools() || [];
        const internalRaw = getInternalTools() || [];
        const internal = internalRaw.map(t => ({
            name: t.name,
            description: typeof t.description === 'string' ? t.description.slice(0, 2048) : '',
            inputSchema: t.inputSchema || { type: 'object', properties: {} },
            // Keep annotations so the permission filter / role invariants can
            // tell read-only from write-capable internal tools (reply, react,
            // edit_message, schedule_*, reload_config all declare
            // readOnlyHint:false in tools.json).
            annotations: t.annotations || {},
        }));
        // Sort deterministically by name — protects BP_1 hash stability from
        // listTools() ordering churn. Anthropic / OpenAI / Gemini all hash
        // the tools array verbatim, so any reorder rewrites the prefix.
        _mcpToolsCache = [...mcp, ...internal].sort((a, b) => {
            const an = a?.name || '';
            const bn = b?.name || '';
            return an < bn ? -1 : an > bn ? 1 : 0;
        });
        _mcpToolsCacheTime = now;
    }
    return _mcpToolsCache;
}

// Phase D-2 — profile.tools resolution.
//
// `toolSpec` may be:
//   • Array<string>  (profile.tools) — toolset ids like "tools:filesystem",
//                     "tools:git", "tools:mcp", "tools:search",
//                     "tools:readonly", or the literal "full"
//   • 'full' / 'readonly' / 'mcp'  — legacy preset.tools strings
//   • null / undefined             — same as 'full' (historical default)
//
// Array form is the Phase B/D target: each profile declares its tool surface
// explicitly, BP_1 hash differs across profiles with different tool subsets
// (by design — sub-task profile cannot see bash; worker-full can), and
// adding a new toolset id here is a localised change.
// Phase L — permission-based tool filter. Applied AFTER toolSpec expansion so
// every profile still gets the same base set, but `read` roles have write tools
// stripped and `read-write` is a pass-through. `full` disables the filter.
//
// Bash is dual-use (cat/ls vs rm/cp); we ship it in all tiers and rely on the
// role's Tier 3 system-reminder to forbid destructive shells. See
// docs/common-permission-manual.md.
//
// MCP tools are not filtered by name here — MCP surfaces too many per-plugin
// actions to pattern-match reliably. Role system-prompts declare which MCP
// actions are allowed (see "Tool Categories" in the common guide).
const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'multi_edit', 'notebook_edit']);

// A tool counts as write-capable if:
//   (a) its bare name is a built-in writer (write/edit/…), OR
//   (b) its tools.json annotation says readOnlyHint:false (which internal
//       tools like reply/react/edit_message/schedule_*/reload_config set).
// MCP tools (mcp__foo__bar) have no annotations here and are deliberately
// excluded — per-server MCP surfaces are too varied to pattern-match; role
// system-prompts gate them textually instead.
function _isWriteTool(t) {
    const name = String(t?.name || '').toLowerCase();
    if (WRITE_TOOL_NAMES.has(name)) return true;
    const ann = t?.annotations;
    if (ann && typeof ann === 'object' && ann.readOnlyHint === false) return true;
    return false;
}

function _applyPermissionFilter(tools, permission) {
    if (!Array.isArray(tools)) return tools;
    if (!permission || permission === 'full') return tools;
    if (permission === 'read') {
        return tools.filter(t => !_isWriteTool(t));
    }
    if (permission === 'read-write') {
        return tools;
    }
    return tools;
}

function resolveSessionTools(toolSpec, skills, permission) {
    const mcp = _getMcpToolsCached();
    const skillTools = buildSkillToolDefs(skills);

    const base = _computeBaseTools(toolSpec, mcp, skillTools);
    const filtered = _applyPermissionFilter(base, permission);
    if (permission && permission !== 'full' && filtered.length !== base.length) {
        process.stderr.write(`[session] permission=${permission} tools=${filtered.length} (filtered from ${base.length})\n`);
    }
    return filtered;
}

function _computeBaseTools(toolSpec, mcp, skillTools) {
    if (Array.isArray(toolSpec)) {
        if (toolSpec.length === 0) {
            // Explicit "no tools" — skill meta tools still travel so the model
            // can at least discover and invoke skills if that is the one
            // dynamic surface the profile retains.
            return [...skillTools];
        }
        if (toolSpec.includes('full')) {
            return [...BUILTIN_TOOLS, ...mcp, ...skillTools];
        }
        const byName = new Map();
        const add = (tool) => { if (tool?.name && !byName.has(tool.name)) byName.set(tool.name, tool); };
        const addMany = (arr) => { for (const t of arr) add(t); };
        for (const tagRaw of toolSpec) {
            const tag = String(tagRaw || '').trim();
            switch (tag) {
                case 'tools:filesystem':
                    addMany(BUILTIN_TOOLS.filter(t => ['read', 'write', 'edit', 'grep', 'glob'].includes(t.name)));
                    break;
                case 'tools:readonly':
                    addMany(BUILTIN_TOOLS.filter(t => ['read', 'grep', 'glob'].includes(t.name)));
                    break;
                case 'tools:bash':
                case 'tools:git':
                case 'tools:analysis':
                    addMany(BUILTIN_TOOLS.filter(t => t.name === 'bash'));
                    break;
                case 'tools:mcp':
                    addMany(mcp);
                    break;
                case 'tools:search':
                    addMany(mcp.filter(t => /search/i.test(t?.name || '')));
                    break;
                default:
                    process.stderr.write(`[session] unknown toolset id "${tag}" (profile.tools); skipping\n`);
            }
        }
        return [...byName.values(), ...skillTools];
    }

    switch (toolSpec) {
        case 'mcp':
            return [...mcp, ...skillTools];
        case 'readonly': {
            const readTools = BUILTIN_TOOLS.filter(t => ['read', 'grep', 'glob'].includes(t.name));
            return [...readTools, ...mcp, ...skillTools];
        }
        case 'full':
        default:
            return [...BUILTIN_TOOLS, ...mcp, ...skillTools];
    }
}

// Kept for backwards compatibility with callers that pass a raw string.
function resolveToolPreset(preset, skills) {
    return resolveSessionTools(preset, skills);
}
let nextId = Date.now();
const CONTEXT_WINDOWS = {
    'gpt-4o': 128000, 'gpt-4.1': 1000000, 'gpt-4.1-mini': 1000000, 'o4-mini': 200000,
    'gpt-5.4-mini': 1000000, 'gpt-5.4': 1000000, 'gpt-5.4-nano': 1000000, 'gpt-5.4-pro': 1000000,
    'gpt-5.2-codex': 1000000, 'gpt-5.2': 1000000, 'gpt-5.1-codex': 1000000,
    'claude-opus-4-7': 1000000, 'claude-opus-4-0': 200000, 'claude-sonnet-4-0': 200000, 'claude-haiku-4-5-20251001': 200000,
    'gemini-2.5-pro': 1000000, 'gemini-2.5-flash': 1000000, 'gemini-2.0-flash': 1000000,
    'llama-3.3-70b-versatile': 128000, 'llama3.3:latest': 8192, 'grok-3-beta': 131072,
};
function guessContextWindow(model) {
    if (CONTEXT_WINDOWS[model])
        return CONTEXT_WINDOWS[model];
    if (model.includes('llama') || model.includes('mistral') || model.includes('phi'))
        return 8192;
    return 128000;
}
// --- create_session ---
// opts can pass either a `preset` object (from config.presets) or raw provider/model.
// Preset shape: { name, provider, model, effort?, fast?, tools? }
//
// Smart Bridge integration:
//   opts.taskType / opts.role / opts.profileId — enables profile-aware routing.
//     Rule-based SmartRouter resolves these synchronously; the resolved
//     profile controls context filtering (skip.skills/memory/etc) and cache
//     strategy. If no rule matches, falls back to classic preset behavior.
//   opts.profile — pre-resolved profile (bypasses router; used by async
//     callers who already ran SmartBridge.resolve()).
//   opts.providerCacheOpts — pre-resolved cache options merged into ask() sendOpts.
export function createSession(opts) {
    const presetObj = opts.preset && typeof opts.preset === 'object' ? opts.preset : null;

    // --- Smart Bridge profile resolution (best-effort, sync) ---
    let profile = opts.profile || null;
    let providerCacheOpts = opts.providerCacheOpts || null;
    if (!profile && (opts.taskType || opts.role || opts.profileId)) {
        const smartBridge = getSmartBridgeSync();
        if (smartBridge) {
            try {
                const resolved = smartBridge.resolveSync({
                    taskType: opts.taskType,
                    role: opts.role,
                    profileId: opts.profileId,
                    preset: presetObj?.name || (typeof opts.preset === 'string' ? opts.preset : null),
                    provider: opts.provider || presetObj?.provider,
                });
                if (resolved) {
                    profile = resolved.profile;
                    providerCacheOpts = resolved.providerCacheOpts;
                }
            } catch (e) {
                // Smart Bridge error — log once, fall back to classic behavior.
                if (!_smartBridgeWarned) {
                    _smartBridgeWarned = true;
                    process.stderr.write(`[session] smart bridge resolve failed: ${e.message}\n`);
                }
            }
        }
    }

    const providerName = opts.provider || presetObj?.provider
        || (profile?.preferredProviders?.[0]);
    const modelName = opts.model || presetObj?.model;
    const toolPreset = presetObj?.tools || (typeof opts.preset === 'string' ? opts.preset : null) || opts.tools || 'full';
    const effort = presetObj?.effort || opts.effort || null;
    const fast = presetObj?.fast === true || opts.fast === true;
    if (!providerName)
        throw new Error('createSession: provider is required');
    if (!modelName)
        throw new Error('createSession: model is required');
    const provider = getProvider(providerName);
    if (!provider)
        throw new Error(`Provider "${providerName}" not found or not enabled`);
    const id = `sess_${nextId++}_${Date.now()}`;
    const messages = [];
    const agentTemplate = opts.agent ? loadAgentTemplate(opts.agent, opts.cwd) : null;
    const skills = collectSkillsCached(opts.cwd);

    // Phase B Tier 2 content — Pool B common prefix (bit-identical across roles).
    const bridgeRules = _buildBridgeRules();
    // Project MD (cwd-based, Tier 3 slot).
    const projectContext = collectProjectMd(opts.cwd);

    // Role template (Phase B §4 — UI-managed). Reads <DATA_DIR>/roles/<role>.md
    // and parses frontmatter (description, permission). The template is
    // injected into the Tier 3 system-reminder so role differences never
    // touch the BP_2 cache prefix.
    const resolvedRole = opts.role || profile?.taskType || null;
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    const roleTemplate = resolvedRole && dataDir
        ? loadRoleTemplate(resolvedRole, dataDir)
        : null;

    const { systemTier2, tier3Reminder } = composeSystemPrompt({
        userPrompt: opts.systemPrompt,
        bridgeRules: bridgeRules || undefined,
        agentTemplate: agentTemplate || undefined,
        roleTemplate: roleTemplate || undefined,
        hasSkills: skills.length > 0,
        profile: profile || undefined,
        role: resolvedRole,
        taskBrief: opts.taskBrief || null,
        projectContext: projectContext || null,
    });
    if (systemTier2) {
        messages.push({ role: 'system', content: systemTier2 });
    }
    if (tier3Reminder) {
        messages.push({ role: 'user', content: `<system-reminder>\n${tier3Reminder}\n</system-reminder>` });
        messages.push({ role: 'assistant', content: 'Understood. Context absorbed.' });
    }
    if (opts.files?.length) {
        const fileContext = opts.files
            .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
            .join('\n\n');
        messages.push({ role: 'user', content: `Reference files:\n\n${fileContext}` });
        messages.push({ role: 'assistant', content: 'Understood. I have the files in context.' });
    }
    // Profile wins over preset.tools — profile.tools carries toolset ids
    // (['tools:filesystem','tools:search']) that expand to an explicit tool
    // subset, which is how BP_1 actually gets shaped per Phase B spec. When
    // no profile resolves, fall back to the preset.tools string ('full' /
    // 'readonly' / 'mcp') so raw createSession callers still work.
    const toolSpec = Array.isArray(profile?.tools) ? profile.tools : toolPreset;

    // Phase L — resolve permission for tool filtering. Priority:
    //   opts.permission (explicit)
    //   profile.permission (from role config)
    //   'full' (no filter)
    const permission = opts.permission || profile?.permission || null;
    const tools = resolveSessionTools(toolSpec, skills, permission);

    // Phase L invariants — throw at session create if role/tools contract
    // is violated. Better to fail loudly here than to spawn a reviewer that
    // silently has Write access.
    const toolNameSet = new Set(tools.map(t => String(t?.name || '')));
    if (resolvedRole === 'researcher') {
        // Accept either a bare in-process search (internal-tools registry) or
        // an MCP-prefixed search tool from an external server. The old check
        // required `mcp__…search…`, which broke after we moved search into
        // the in-process registry with the bare name `search`.
        const hasSearch = [...toolNameSet].some(n => n === 'search' || (/search/.test(n) && /mcp/.test(n)));
        if (!hasSearch) {
            throw new Error('Phase L invariant: role=researcher requires a search tool (bare "search" or an MCP search) in the session tool list.');
        }
    }
    if (resolvedRole === 'reviewer' && permission === 'read') {
        // Use the same write-tool definition as the permission filter so we
        // don't accept annotation-based write tools (reply/react/etc.) that
        // the bare-name check would miss.
        const forbidden = tools.filter(_isWriteTool).map(t => String(t?.name || ''));
        if (forbidden.length) {
            throw new Error(`Phase L invariant: role=reviewer permission=read must not contain write tools (found: ${forbidden.join(', ')}).`);
        }
    }
    if (resolvedRole) {
        process.stderr.write(`[session] role=${resolvedRole} permission=${permission || 'full'} tools=${tools.length}\n`);
    }
    const session = {
        id,
        provider: providerName,
        model: modelName,
        messages,
        contextWindow: guessContextWindow(modelName),
        tools,
        preset: toolPreset,
        presetName: presetObj?.name || null,
        effort,
        fast,
        agent: opts.agent,
        owner: opts.owner || 'user',
        mcpPid: process.pid,
        scopeKey: opts.scopeKey || null,
        lane: opts.lane || 'bridge',
        cwd: opts.cwd,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        totalInputTokens: 0,
        totalOutputTokens: 0,
        // Phase B §6 Worker lifecycle — refreshed on each completed ask().
        // `isSessionStale()` reads these to decide close-and-respawn.
        lastUsedAt: Date.now(),
        tokensCumulative: 0,
        role: opts.role || null,
        // Origin tag written into every bridge-trace usage row so analytics
        // can slice by (sourceType, sourceName) — e.g. maintenance/cycle1,
        // scheduler/daily-standup, webhook/github-push, lead/worker.
        sourceType: opts.sourceType || null,
        sourceName: opts.sourceName || null,
        // Stable cache key for any tagged dispatch (bridge/scheduler/webhook)
        // so multiple sessions of the same role share the same Codex cache
        // shard. The profile.behavior flag is no longer gating this — every
        // session that carries a sourceType gets a role-scoped key. Untagged
        // sessions (direct MCP surface) fall back to the session id.
        promptCacheKey: (opts.sourceType && (opts.sourceName || opts.role))
            ? `trib:${opts.sourceType}:${opts.sourceName || opts.role}`
            : id,
        // Hermes-style in-flight compressor state
        compressionCount: 0,
        previousSummary: null,
        // Smart Bridge metadata — optional. Applied on every ask() to merge
        // profile-driven cache settings into provider sendOpts.
        profileId: profile?.id || null,
        providerCacheOpts: providerCacheOpts || null,
        // Profile lifecycle behavior, copied at spawn so role names remain
        // user-configurable without leaking into reset logic. "stateless"
        // sessions are truncated back to the initial head between dispatches.
        behavior: profile?.behavior || null,
        // Frozen head length covering the bit-identical Pool B prefix (system
        // Tier 2 + Tier 3 reminder + ack, plus optional reference-files pair).
        // resetStatelessSession() truncates messages to this length between
        // dispatches so the provider cache handle survives while per-task
        // transcript does not.
        initialHeadLength: messages.length,
    };
    saveSession(session);
    return session;
}

/**
 * Phase C Ship 3 — reset a stateless session for the next dispatch.
 *
 * Profiles marked `behavior: "stateless"` (e.g. `sub-task`) carry no
 * transcript across dispatches — only the prefix-handle is reused, per
 * Phase B §4.5. Instead of destroying and recreating the session (which
 * would churn the `prompt_cache_key` and force a fresh Anthropic prefix
 * write), we truncate the message list back to the initial Pool B head
 * and clear compressor state.
 *
 * Idempotent: on a freshly created session `messages.length === head`, so
 * the slice is a no-op. Safe to call unconditionally after resume.
 */
export function resetStatelessSession(sessionId) {
    const session = loadSession(sessionId);
    if (!session) return null;
    const head = Number.isInteger(session.initialHeadLength) ? session.initialHeadLength : 0;
    let mutated = false;
    if (head > 0 && session.messages.length > head) {
        session.messages = session.messages.slice(0, head);
        mutated = true;
    }
    if (session.compressionCount) {
        session.compressionCount = 0;
        mutated = true;
    }
    if (session.previousSummary) {
        session.previousSummary = null;
        mutated = true;
    }
    if (mutated) {
        session.updatedAt = Date.now();
        saveSession(session);
    }
    return session;
}

// ── Runtime liveness map ──────────────────────────────────────────────
// In-memory only. Tracks per-session stage + stream heartbeat so list_sessions
// can surface whether a session is actually alive vs stuck. Never persisted —
// heartbeats would otherwise churn the session JSON on every SSE delta.
// Entry shape: {
//   stage, lastStreamDeltaAt, lastToolCall, lastError, updatedAt,
//   controller?: AbortController,  // set while an ask is in flight
//   generation?: number,            // snapshot taken at ask start
//   closed?: boolean,               // flipped by closeSession()
// }
const _runtimeState = new Map();
const VALID_STAGES = new Set([
    'connecting', 'requesting', 'streaming', 'tool_running', 'idle', 'error', 'done', 'cancelling',
]);
function _touchRuntime(id) {
    let entry = _runtimeState.get(id);
    if (!entry) {
        entry = { stage: 'idle', lastStreamDeltaAt: null, lastToolCall: null, lastError: null, updatedAt: Date.now() };
        _runtimeState.set(id, entry);
    }
    return entry;
}
export function updateSessionStage(id, stage) {
    if (!id || !VALID_STAGES.has(stage)) return;
    const entry = _touchRuntime(id);
    entry.stage = stage;
    entry.updatedAt = Date.now();
}
/**
 * Reset heartbeat-visible fields for a new ask. Preserves controller/generation/
 * closed (lifecycle) but clears the previous run's streaming state so stale
 * lastToolCall / lastStreamDeltaAt from the previous ask don't leak into the
 * new one.
 */
export function markSessionAskStart(id) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'connecting';
    entry.lastStreamDeltaAt = null;
    entry.lastToolCall = null;
    entry.lastError = null;
    entry.updatedAt = Date.now();
}
export function markSessionStreamDelta(id) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.lastStreamDeltaAt = Date.now();
    // Only promote to 'streaming' if we were in a pre-stream stage; never downgrade
    // mid-tool (tool_running has its own delta source if the tool streams back).
    if (entry.stage === 'connecting' || entry.stage === 'requesting') {
        entry.stage = 'streaming';
    }
    entry.updatedAt = Date.now();
}
export function markSessionToolCall(id, toolName) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'tool_running';
    entry.lastToolCall = toolName || null;
    entry.updatedAt = Date.now();
}
export function markSessionDone(id) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'done';
    entry.lastError = null;
    entry.updatedAt = Date.now();
}
export function markSessionError(id, msg) {
    if (!id) return;
    const entry = _touchRuntime(id);
    entry.stage = 'error';
    entry.lastError = msg ? String(msg).slice(0, 200) : null;
    entry.updatedAt = Date.now();
}
export function getSessionRuntime(id) {
    return id ? (_runtimeState.get(id) || null) : null;
}
/**
 * Iterate all active session runtimes. Used by the stream watchdog.
 * Returns an iterable of [sessionId, entry] pairs; consumers should
 * treat entries as read-only snapshots and avoid mutating them.
 */
export function forEachSessionRuntime() {
    return _runtimeState.entries();
}
function _clearSessionRuntime(id) {
    if (id) _runtimeState.delete(id);
}

/**
 * Wrap an async call so that if the session's controller aborts mid-flight,
 * the wrapper settles with a SessionClosedError even if the underlying promise
 * hasn't returned yet. The original promise is kept alive with a detached
 * `.catch()` to prevent unhandled-rejection warnings once it eventually
 * settles. Callers still must check generation/closed after await returns
 * to handle providers that ignore the AbortSignal entirely.
 */
export async function _api_call_with_interrupt(sessionId, fn) {
    const entry = _touchRuntime(sessionId);
    if (!entry.controller) entry.controller = createAbortController();
    const signal = entry.controller.signal;
    if (signal.aborted) throw new SessionClosedError(sessionId, 'aborted before call');
    const underlying = fn(signal);
    underlying.catch(() => {}); // prevent unhandled rejection if we race ahead
    let onAbort = null;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new SessionClosedError(sessionId, 'aborted during call'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([underlying, aborted]);
    } finally {
        // If the underlying promise settled first, the abort listener is
        // still attached. Remove it to avoid accumulating listeners across
        // many asks on the same session.
        if (onAbort && !signal.aborted) {
            try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
        }
    }
}

// Per-session mutex: queues concurrent askSession calls to prevent message loss
const _sessionLocks = new Map();
function acquireSessionLock(sessionId) {
    let entry = _sessionLocks.get(sessionId);
    if (!entry) {
        entry = { promise: Promise.resolve(), count: 0 };
        _sessionLocks.set(sessionId, entry);
    }
    entry.count++;
    const prev = entry.promise;
    let release;
    entry.promise = new Promise(r => { release = r; });
    return prev.then(() => () => {
        entry.count--;
        if (entry.count === 0) _sessionLocks.delete(sessionId);
        release();
    });
}

// Phase D-2 — Shard-level cold-cache singleflight.
//
// The relevant cache-concurrency unit is the provider shard, not the logical
// profile. Anthropic's Sonnet shard and OpenAI's Codex shard are completely
// separate caches even when both serve the same `sub-task` profile; locking
// them under one key (v0.6.50 behaviour) either over-serialised warm warm
// crossings or under-locked concurrent cold writes. The shard key used here
// is `${provider}:${model}:${profileId}` — provider separates physical
// shards, model guards against cross-model prefix reuse, and profileId
// stands in for prefix-hash until the registry has a hash on file. The
// first concurrent cold ask goes through and pays the write premium; peers
// on the same shard wait up to COLD_FLIGHT_TIMEOUT_MS and then ride warm.
const _shardColdFlight = new Map();
const COLD_FLIGHT_TIMEOUT_MS = 60_000;

function _shardKey(provider, model, profileId) {
    if (!provider || !profileId) return null;
    const modelPart = model || '_';
    return `${provider}:${modelPart}:${profileId}`;
}

function _isShardWarm(provider, model, profileId) {
    if (!provider || !profileId || !_smartBridgeApi) return false;
    const entry = _smartBridgeApi.registry?.data?.profiles?.[profileId]?.[provider];
    if (!entry) return false;
    // Registry does not yet track `model` per entry; treat model mismatch as
    // unknown-warm rather than cold because Anthropic/OpenAI prefix caches
    // are keyed on prompt content (which encodes the model implicitly when
    // tools embed the model name). Good enough for singleflight gating.
    return (entry.expiresAt || 0) > Date.now();
}

async function _waitForColdShard(provider, model, profileId) {
    const key = _shardKey(provider, model, profileId);
    if (!key || _isShardWarm(provider, model, profileId)) return;
    const inFlight = _shardColdFlight.get(key);
    if (!inFlight) return;
    try {
        await Promise.race([
            inFlight,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('cold-flight timeout')),
                COLD_FLIGHT_TIMEOUT_MS,
            )),
        ]);
    } catch {
        // Timeout or in-flight failure — proceed anyway. Worst case we pay a
        // second write premium, which is the bounded fallback.
    }
}

function _registerShardColdFlight(provider, model, profileId) {
    const key = _shardKey(provider, model, profileId);
    if (!key) return () => {};
    let resolve;
    const flight = new Promise(r => { resolve = r; });
    _shardColdFlight.set(key, flight);
    return () => {
        resolve();
        if (_shardColdFlight.get(key) === flight) {
            _shardColdFlight.delete(key);
        }
    };
}

export async function askSession(sessionId, prompt, context, onToolCall, cwdOverride) {
    const _askStartedAt = Date.now();
    const unlock = await acquireSessionLock(sessionId);
    // ── Synchronous pre-await setup (must happen before any await so
    //    closeSession() can't interleave between load and registration) ──
    const preSession = loadSession(sessionId);
    if (!preSession) {
        unlock();
        throw new Error(`Session "${sessionId}" not found`);
    }
    if (preSession.closed === true) {
        unlock();
        throw new SessionClosedError(sessionId, 'session already closed');
    }
    // Phase D-2 — shard-level cold-cache singleflight. Serialise only when
    // the specific (provider, model, profile) shard is cold. Same profile on
    // a different provider holds its own warm/cold state, so Anthropic
    // traffic never blocks OpenAI traffic or vice versa.
    await _waitForColdShard(preSession.provider, preSession.model, preSession.profileId);
    const releaseColdFlight = !_isShardWarm(preSession.provider, preSession.model, preSession.profileId)
        ? _registerShardColdFlight(preSession.provider, preSession.model, preSession.profileId)
        : () => {};
    const askGeneration = typeof preSession.generation === 'number' ? preSession.generation : 0;
    const runtime = _touchRuntime(sessionId);
    // Fresh controller per ask — the previous ask's controller may have aborted.
    runtime.controller = createAbortController();
    runtime.generation = askGeneration;
    runtime.closed = false;
    markSessionAskStart(sessionId);
    try {
        // Preprocessing is inside try so provider-not-available / trim failures
        // fall into the catch and mark the session as errored rather than
        // leaving stage='connecting' forever.
        try {
            const session = preSession;
            const provider = getProvider(session.provider);
            if (!provider)
                throw new Error(`Provider "${session.provider}" not available`);
            if (context) {
                session.messages.push({ role: 'user', content: `Additional context:\n\n${context}` });
                session.messages.push({ role: 'assistant', content: 'Noted.' });
            }
            const beforeCount = session.messages.length + 1;
            // Soft warning only; real size management (compaction primary,
            // byte-budget trim as safety net) lives in agentLoop. Selecting a
            // 25% pre-trim here would starve compaction's 50% threshold.
            const softBudget = Math.floor(session.contextWindow * 0.25);
            const promptTokenEstimate = prompt.length * 0.5; // conservative for CJK
            if (promptTokenEstimate > softBudget * 0.7) {
                process.stderr.write(`[session] Warning: prompt is very large (est. ${Math.round(promptTokenEstimate)} tokens vs ${softBudget} soft budget)\n`);
            }
            const outgoing = [...session.messages, { role: 'user', content: prompt }];
            const effectiveCwd = cwdOverride || session.cwd;
            const result = await _api_call_with_interrupt(sessionId, (signal) =>
                agentLoop(provider, outgoing, session.model, session.tools, onToolCall, effectiveCwd, {
                    effort: session.effort || null,
                    fast: session.fast === true,
                    sessionId,
                    promptCacheKey: session.promptCacheKey || sessionId,
                    signal,
                    providerState: session.providerState ?? undefined,
                    session,
                    // Smart Bridge cache settings — merged last so session overrides
                    // don't get overridden by defaults. When session has no profile,
                    // providerCacheOpts is null and this spread is a no-op.
                    ...(session.providerCacheOpts || {}),
                    onStageChange: (stage) => updateSessionStage(sessionId, stage),
                    onStreamDelta: () => markSessionStreamDelta(sessionId),
                }),
            );
            // Post-loop validation: if closeSession() landed while we were awaiting,
            // drop the save so the tombstone on disk isn't overwritten.
            const currentRuntime = _runtimeState.get(sessionId);
            if (currentRuntime?.closed || currentRuntime?.generation !== askGeneration) {
                throw new SessionClosedError(sessionId, 'closed during call');
            }
            // Update and save. outgoing is mutated in place by agentLoop
            // (compaction + safety trim), so its length reflects post-loop state.
            const messagesDropped = Math.max(0, beforeCount - outgoing.length);
            session.messages = outgoing;
            if (result.content) {
                session.messages.push({ role: 'assistant', content: result.content });
            }
            session.updatedAt = Date.now();
            session.lastUsedAt = Date.now();
            if (result.usage) {
                session.totalInputTokens += result.usage.inputTokens;
                session.totalOutputTokens += result.usage.outputTokens;
                session.tokensCumulative = (session.tokensCumulative || 0)
                    + (result.usage.inputTokens || 0)
                    + (result.usage.outputTokens || 0);
            }
            // Smart Bridge cache stats — record hit/miss after every successful
            // ask so the registry reflects all bridge traffic, not just
            // maintenance cycles. Guarded against any smart-bridge error so
            // metric recording never breaks the ask itself.
            let prefixHashForLog = null;
            if (session.profileId && result.usage && _smartBridgeApi) {
                try {
                    const profile = _smartBridgeApi.getProfile(session.profileId);
                    if (profile) {
                        const systemMsg = session.messages[0]?.role === 'system' ? session.messages[0].content : '';
                        _smartBridgeApi.recordCall(profile, session.provider, {
                            systemPrompt: systemMsg,
                            tools: session.tools || [],
                            usage: result.usage,
                        });
                        const entry = _smartBridgeApi.registry?.data?.profiles?.[session.profileId]?.[session.provider];
                        prefixHashForLog = entry?.prefixHash || null;
                    }
                } catch {}
            }
            // Append to bridge-trace.jsonl with the rich bridge usage fields.
            if (result.usage) {
                const inputTokens = result.usage.inputTokens || 0;
                const outputTokens = result.usage.outputTokens || 0;
                const cacheReadTokens = result.usage.cachedTokens || 0;
                const cacheWriteTokens = result.usage.cacheWriteTokens || 0;
                let costUsd = result.usage.costUsd || 0;
                if (!costUsd) {
                    try {
                        const { computeCostUsd } = await import('../../../shared/llm/cost.mjs');
                        costUsd = computeCostUsd({
                            model: session.model,
                            inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                        });
                    } catch { /* best-effort */ }
                }
                logLlmCall({
                    ts: new Date().toISOString(),
                    sourceType: session.sourceType || 'lead',
                    sourceName: session.sourceName || session.role || null,
                    preset: session.presetName || null,
                    model: session.model,
                    provider: session.provider,
                    duration: Date.now() - _askStartedAt,
                    profileId: session.profileId || null,
                    sessionId: session.id,
                    inputTokens,
                    outputTokens,
                    cacheReadTokens,
                    cacheWriteTokens,
                    prefixHash: prefixHashForLog,
                    costUsd,
                });
            }
            // Persist opaque providerState for future stateful providers.
            // No provider currently emits it (Codex OAuth is stateless per
            // contract), so this branch is dormant — kept so a future
            // Responses-API provider with stable continuation can plug in
            // without reworking the session shape.
            if (result.providerState !== undefined) {
                session.providerState = result.providerState;
            }
            saveSession(session, { expectedGeneration: askGeneration });
            markSessionDone(sessionId);
            return {
                ...result,
                trimmed: messagesDropped > 0,
                messagesDropped,
            };
        } catch (err) {
            if (err instanceof SessionClosedError) {
                // Cancellation is not an error; propagate silently so callers
                // can render it as "cancelled" rather than a red failure.
                throw err;
            }
            markSessionError(sessionId, err && err.message ? err.message : String(err));
            throw err;
        }
    } finally {
        // Clear the controller only if it's still ours (closeSession may have
        // swapped it). Leave the rest of the runtime entry intact so list_sessions
        // can still surface the final stage (done/error/cancelling).
        const entry = _runtimeState.get(sessionId);
        if (entry && entry.generation === askGeneration) {
            entry.controller = null;
        }
        // Phase C Ship 5 — release cold-flight waiters. Called unconditionally
        // so a failed cache write doesn't leave peers blocked until the
        // 60s timeout.
        try { releaseColdFlight(); } catch { /* ignore */ }
        unlock();
    }
}
// --- find or create session by scopeKey (atomic, prevents duplicate creation) ---
const _scopeCreateLocks = new Map();
export function findSessionByScopeKey(scopeKey) {
    if (!scopeKey) return null;
    const sessions = listStoredSessions();
    // Exclude tombstoned sessions (`closed === true`) so callers never receive
    // a session whose controller was aborted by closeSession(). The `closed`
    // bit is the authoritative tombstone flag; `status === 'error'` is not,
    // since transient-error sessions remain resumable.
    return sessions.find(s => s.scopeKey === scopeKey && s.closed !== true) || null;
}
export function findOrCreateSession(scopeKey, createFn) {
    if (!scopeKey) return createFn();
    // Synchronous lock: if another call is creating for this scope, wait
    const existing = findSessionByScopeKey(scopeKey);
    if (existing) {
        // Phase B §6.1 — Worker lifecycle triggers evaluated on reuse.
        // Stale sessions (idle > 5min OR tokens ≥ hard threshold) are closed
        // and a fresh session is spawned. Soft-token returns here are left
        // to the caller to decide (defer vs immediate close).
        const stale = isSessionStale(existing);
        if (stale === 'idle' || stale === 'hard-tokens') {
            try { markSessionClosed(existing.id); } catch { /* ignore */ }
            process.stderr.write(`[session] respawn on ${stale} (scope=${scopeKey}, id=${existing.id})\n`);
        } else {
            return existing;
        }
    }
    // Check again with lock to prevent race
    if (_scopeCreateLocks.has(scopeKey)) {
        // Another create just happened, re-check
        const retry = findSessionByScopeKey(scopeKey);
        if (retry) return retry;
    }
    _scopeCreateLocks.set(scopeKey, true);
    try {
        const session = createFn();
        return session;
    } finally {
        _scopeCreateLocks.delete(scopeKey);
    }
}
// --- resume (reload tools for a stored session) ---
export function resumeSession(sessionId, preset) {
    const session = loadSession(sessionId);
    if (!session)
        return null;
    // Resuming a closed session is a resurrection attempt — refuse. The guarded
    // save below would also block the write, but failing fast here is cleaner
    // than silently dropping the tool-refresh side effects.
    if (session.closed === true) return null;
    if (!session.owner) session.owner = 'user';
    // Backfill compressor state for sessions created before the feature landed.
    if (typeof session.compressionCount !== 'number') session.compressionCount = 0;
    if (session.previousSummary === undefined) session.previousSummary = null;
    // Refresh tools (MCP connections may have changed).
    // Re-resolve from profile.tools when the session stored a profileId —
    // otherwise fall back to preset.tools. Same resolution order as
    // createSession so resume and spawn produce identical BP_1 shapes.
    const oldTools = session.tools || [];
    const skills = collectSkillsCached(session.cwd);
    let toolSpec = preset || session.preset || 'full';
    if (session.profileId && _smartBridgeApi?.getProfile) {
        try {
            const profile = _smartBridgeApi.getProfile(session.profileId);
            if (Array.isArray(profile?.tools)) toolSpec = profile.tools;
        } catch { /* ignore lookup failures, keep preset fallback */ }
    }
    session.tools = resolveSessionTools(toolSpec, skills, session.permission || null);
    const newTools = session.tools;
    const missing = oldTools.filter(t => !newTools.find(n => n.name === t.name));
    if (missing.length) {
        process.stderr.write(`[session] Warning: ${missing.length} tools no longer available: ${missing.map(t => t.name).join(', ')}\n`);
    }
    saveSession(session, { expectedGeneration: session.generation });
    return session;
}
// --- CRUD ---
export function getSession(id) {
    return loadSession(id);
}
export function listSessions() {
    return listStoredSessions();
}
// --- Clear messages (keep system prompt + provider/model/cwd) ---
export function clearSessionMessages(sessionId) {
    const session = loadSession(sessionId);
    if (!session)
        return false;
    // Don't resurrect a closed session just to clear its messages.
    if (session.closed === true) return false;
    session.messages = (session.messages || []).filter(m => m && m.role === 'system');
    session.totalInputTokens = 0;
    session.totalOutputTokens = 0;
    session.updatedAt = Date.now();
    saveSession(session, { expectedGeneration: session.generation });
    return true;
}
export function updateSessionStatus(id, status) {
    const session = loadSession(id);
    if (!session) return false;
    // Respect tombstones — don't resurrect a closed session just to update a
    // status label (bridge handler emits running→idle/error around askSession).
    if (session.closed === true) return false;
    session.status = status;
    session.updatedAt = Date.now();
    saveSession(session, { expectedGeneration: session.generation });
    return true;
}
/**
 * Close a session. Plants a `closed=true` tombstone on disk with a bumped
 * generation (so any racing saveSession() drops its write), aborts the
 * in-flight controller if one exists, and clears the in-memory runtime entry.
 *
 * IMPORTANT: we deliberately do NOT unlink the session file here. The tombstone
 * on disk is the authoritative signal that blocks resurrection — a late
 * saveSession() re-reads disk via _shouldDrop() and will find the tombstone.
 * If we delete the file, a late save sees no file, decides nothing to drop,
 * and recreates the session in its pre-close state.
 *
 * Long-term cleanup: `sweepTombstones()` below unlinks tombstones older than
 * TOMBSTONE_MAX_AGE_MS (24h — vastly longer than any realistic in-flight race).
 */
export function closeSession(id) {
    if (!id) return false;
    // 1. Tombstone first — this wins the race against saveSession().
    const newGen = markSessionClosed(id);
    // 2. Mark runtime as closed so post-await validation in askSession fires.
    const entry = _runtimeState.get(id);
    if (entry) {
        entry.closed = true;
        if (typeof newGen === 'number') entry.generation = newGen;
        entry.stage = 'cancelling';
        entry.updatedAt = Date.now();
        // 3. Abort the in-flight controller. Providers that honour the signal
        //    unwind immediately; providers that don't will still be caught by
        //    the generation check after their await eventually returns.
        try { entry.controller?.abort(new SessionClosedError(id, 'closeSession')); } catch { /* ignore */ }
    }
    // 4. Defer runtime map clear to next tick so any settling askSession can
    //    observe `closed=true` / bumped generation before we yank the entry.
    //    Disk tombstone remains — that's what blocks resurrection.
    setImmediate(() => {
        _clearSessionRuntime(id);
    });
    return true;
}

// --- Periodic idle session cleanup ---
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const TOMBSTONE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — far longer than any realistic ask race window
let _cleanupTimer = null;

function sweepIdleSessions() {
    try {
        const { cleaned, remaining, details } = sweepStaleSessions();
        if (cleaned > 0) {
            for (const d of details) {
                _clearSessionRuntime(d.id);
                process.stderr.write(`[bridge-session] idle cleanup: closed ${d.id} (idle ${d.idleMinutes}m, owner=${d.owner})\n`);
            }
            process.stderr.write(`[bridge-session] idle sweep: cleaned ${cleaned} session(s), ${remaining} remaining\n`);
        }
    } catch (e) {
        process.stderr.write(`[bridge-session] idle sweep error: ${e && e.message || e}\n`);
    }
}

/**
 * Unlink tombstone session files (closed=true) older than TOMBSTONE_MAX_AGE_MS.
 *
 * Rationale: closeSession() leaves the tombstone on disk as the authoritative
 * resurrection-blocker for racing saveSession() calls. That race resolves in
 * microseconds (the window inside _doSave between temp write and rename), so
 * 24h is vastly safe. After the TTL expires we reclaim the disk slot.
 *
 * Uses `getStoredSessionsRaw()` rather than `listStoredSessions()` because the
 * latter's inline 30-min idle cleanup would race-unlink tombstones before we
 * get to log them — we want to own the unlink decision and stderr line here.
 */
export function sweepTombstones() {
    try {
        const now = Date.now();
        const sessions = getStoredSessionsRaw();
        let cleaned = 0;
        for (const s of sessions) {
            if (!s.closed) continue;
            const updated = Number(s.updatedAt);
            if (!Number.isFinite(updated)) continue;
            const age = now - updated;
            if (age < TOMBSTONE_MAX_AGE_MS) continue;
            try {
                deleteSession(s.id);
                _clearSessionRuntime(s.id);
                cleaned++;
                process.stderr.write(`[session-sweep] unlinked tombstone ${s.id} (age=${Math.floor(age / 1000)}s)\n`);
            } catch (e) {
                process.stderr.write(`[session-sweep] unlink failed ${s.id}: ${e && e.message || e}\n`);
            }
        }
        return cleaned;
    } catch (e) {
        process.stderr.write(`[session-sweep] tombstone sweep error: ${e && e.message || e}\n`);
        return 0;
    }
}

function _runCleanupCycle() {
    sweepIdleSessions();
    sweepTombstones();
}

export function startIdleCleanup() {
    if (_cleanupTimer) return;
    _cleanupTimer = setInterval(_runCleanupCycle, CLEANUP_INTERVAL_MS);
    if (_cleanupTimer.unref) _cleanupTimer.unref(); // don't block process exit
}

export function stopIdleCleanup() {
    if (_cleanupTimer) {
        clearInterval(_cleanupTimer);
        _cleanupTimer = null;
    }
}

/** Exposed for tests and shutdown cleanup. */
export function _getCleanupTimer() {
    return _cleanupTimer;
}
