import { createRequire } from 'module';
import { join } from 'path';
import { homedir } from 'os';
import { getProvider } from '../providers/registry.mjs';
import { agentLoop } from './loop.mjs';
import { getMcpTools } from '../mcp/client.mjs';
import { BUILTIN_TOOLS } from '../tools/builtin.mjs';
import { collectSkillsCached, buildSkillToolDefs, collectClaudeMd, loadAgentTemplate, composeSystemPrompt, collectProjectMd } from '../context/collect.mjs';
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

function resolveToolPreset(preset, skills) {
    const now = Date.now();
    if (!_mcpToolsCache || now - _mcpToolsCacheTime > MCP_CACHE_TTL) {
        _mcpToolsCache = getMcpTools();
        _mcpToolsCacheTime = now;
    }
    const mcp = _mcpToolsCache;
    const skillTools = buildSkillToolDefs(skills);
    switch (preset) {
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
let nextId = Date.now();
const CONTEXT_WINDOWS = {
    'gpt-4o': 128000, 'gpt-4.1': 1000000, 'gpt-4.1-mini': 1000000, 'o4-mini': 200000,
    'gpt-5.4-mini': 1000000, 'gpt-5.4': 1000000, 'gpt-5.4-nano': 1000000, 'gpt-5.4-pro': 1000000,
    'gpt-5.2-codex': 1000000, 'gpt-5.2': 1000000, 'gpt-5.1-codex': 1000000,
    'claude-opus-4-0': 200000, 'claude-sonnet-4-0': 200000, 'claude-haiku-4-5-20251001': 200000,
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
//     profile controls context filtering (skip.claudemd/skills/etc) and cache
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
    // Legacy claudeMd is retained as a fallback when bridgeRules is empty
    // (e.g. a test harness running without plugin-data initialised).
    const claudeMd = bridgeRules ? '' : collectClaudeMd(opts.cwd);

    const { systemTier2, tier3Reminder } = composeSystemPrompt({
        userPrompt: opts.systemPrompt,
        bridgeRules: bridgeRules || undefined,
        claudeMd: claudeMd || undefined,
        agentTemplate: agentTemplate || undefined,
        hasSkills: skills.length > 0,
        profile: profile || undefined,
        role: opts.role || null,
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
    const tools = resolveToolPreset(toolPreset, skills);
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

// Phase C Ship 5 — Profile-level cold-cache singleflight.
//
// Two Worker/Sub asks can arrive for the same profile (e.g. sub-task) across
// different sessions. When the provider cache for that profile is already
// warm, both calls hit and nothing special is needed. When it is cold, both
// calls would independently pay the cache-write premium (2× input on
// Anthropic) — wasting money without improving cache state.
//
// This guard serialises the cold-state ask: the first call goes through
// immediately (and performs the cache write); the second call waits for the
// first to complete (bounded by COLD_FLIGHT_TIMEOUT_MS) and then finds the
// cache warm, paying only cache-read cost. Once warm, the guard becomes a
// no-op so concurrent warm asks stay parallel.
const _profileColdFlight = new Map();
const COLD_FLIGHT_TIMEOUT_MS = 60_000;

function _isProfileWarm(profileId) {
    if (!profileId || !_smartBridgeApi) return false;
    const entry = _smartBridgeApi.registry?.data?.profiles?.[profileId];
    return !!(entry && (entry.expiresAt || 0) > Date.now());
}

async function _waitForColdProfile(profileId) {
    if (!profileId || _isProfileWarm(profileId)) return;
    const inFlight = _profileColdFlight.get(profileId);
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
        // Timeout or in-flight failure — proceed anyway. The worst case is a
        // second write premium, which is exactly what the guard ordinarily
        // prevents but is acceptable as a bounded fallback.
    }
}

function _registerColdFlight(profileId) {
    if (!profileId) return () => {};
    let resolve;
    const flight = new Promise(r => { resolve = r; });
    _profileColdFlight.set(profileId, flight);
    return () => {
        resolve();
        if (_profileColdFlight.get(profileId) === flight) {
            _profileColdFlight.delete(profileId);
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
    // Phase C Ship 5 — cold-cache singleflight. If this profile has no warm
    // entry and another ask is already in flight for it, wait so the peer can
    // complete the cache write first; we then ride warm. No-op when warm.
    await _waitForColdProfile(preSession.profileId);
    const releaseColdFlight = !_isProfileWarm(preSession.profileId)
        ? _registerColdFlight(preSession.profileId)
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
                        const entry = _smartBridgeApi.registry?.data?.profiles?.[session.profileId];
                        prefixHashForLog = entry?.prefixHash || null;
                    }
                } catch {}
            }
            // Append to llm-usage.jsonl with the rich bridge usage fields.
            if (result.usage) {
                logLlmCall({
                    ts: new Date().toISOString(),
                    preset: session.presetName || null,
                    model: session.model,
                    provider: session.provider,
                    mode: 'active',
                    duration: Date.now() - _askStartedAt,
                    profileId: session.profileId || null,
                    sessionId: session.id,
                    inputTokens: result.usage.inputTokens || 0,
                    outputTokens: result.usage.outputTokens || 0,
                    cacheReadTokens: result.usage.cachedTokens || 0,
                    cacheWriteTokens: result.usage.cacheWriteTokens || 0,
                    prefixHash: prefixHashForLog,
                    costUsd: result.usage.costUsd || 0,
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
    // Refresh tools (MCP connections may have changed)
    const oldTools = session.tools || [];
    const skills = collectSkillsCached(session.cwd);
    session.tools = resolveToolPreset((preset || session.preset || 'full'), skills);
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
