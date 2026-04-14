import { getProvider } from '../providers/registry.mjs';
import { trimMessages } from './trim.mjs';
import { agentLoop } from './loop.mjs';
import { getMcpTools } from '../mcp/client.mjs';
import { BUILTIN_TOOLS } from '../tools/builtin.mjs';
import { collectSkillsCached, buildSkillToolDef, collectClaudeMd, loadAgentTemplate, composeSystemPrompt } from '../context/collect.mjs';
import { saveSession, loadSession, deleteSession, listStoredSessions } from './store.mjs';
import { extractAndSave, restoreStatePacket } from './state-packet.mjs';
import { loadConfig } from '../config.mjs';
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
    const skillTool = buildSkillToolDef(skills);
    switch (preset) {
        case 'mcp':
            return [...mcp, ...(skillTool ? [skillTool] : [])];
        case 'readonly': {
            const readTools = BUILTIN_TOOLS.filter(t => ['read', 'grep', 'glob'].includes(t.name));
            return [...readTools, ...mcp, ...(skillTool ? [skillTool] : [])];
        }
        case 'full':
        default:
            return [...BUILTIN_TOOLS, ...mcp, ...(skillTool ? [skillTool] : [])];
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
export function createSession(opts) {
    const presetObj = opts.preset && typeof opts.preset === 'object' ? opts.preset : null;
    const providerName = presetObj?.provider || opts.provider;
    const modelName = presetObj?.model || opts.model;
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
    const claudeMd = collectClaudeMd(opts.cwd);
    const agentTemplate = opts.agent ? loadAgentTemplate(opts.agent, opts.cwd) : null;
    const skills = collectSkillsCached(opts.cwd);
    const skillsSummary = skills.length
        ? skills.map(s => `- ${s.name}: ${s.description}`).join('\n')
        : undefined;
    const systemPrompt = composeSystemPrompt({
        userPrompt: opts.systemPrompt,
        claudeMd: claudeMd || undefined,
        agentTemplate: agentTemplate || undefined,
        skillsSummary,
    });
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
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
        scopeKey: opts.scopeKey || null,
        lane: opts.lane || 'bridge',
        cwd: opts.cwd,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        totalInputTokens: 0,
        totalOutputTokens: 0,
    };
    saveSession(session);
    return session;
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

export async function askSession(sessionId, prompt, context, onToolCall, cwdOverride) {
    const unlock = await acquireSessionLock(sessionId);
    try {
        const session = loadSession(sessionId);
        if (!session)
            throw new Error(`Session "${sessionId}" not found`);
        const provider = getProvider(session.provider);
        if (!provider)
            throw new Error(`Provider "${session.provider}" not available`);
        if (context) {
            session.messages.push({ role: 'user', content: `Additional context:\n\n${context}` });
            session.messages.push({ role: 'assistant', content: 'Noted.' });
        }
        const beforeCount = session.messages.length + 1;
        const budget = Math.floor(session.contextWindow * 0.25);
        const promptTokenEstimate = prompt.length * 0.5; // conservative for CJK
        if (promptTokenEstimate > budget * 0.7) {
            process.stderr.write(`[session] Warning: prompt is very large (est. ${Math.round(promptTokenEstimate)} tokens vs ${budget} budget)\n`);
        }
        const outgoing = trimMessages([...session.messages, { role: 'user', content: prompt }], budget);
        const messagesDropped = beforeCount - outgoing.length;
        const effectiveCwd = cwdOverride || session.cwd;
        const result = await agentLoop(provider, outgoing, session.model, session.tools, onToolCall, effectiveCwd, {
            effort: session.effort || null,
            fast: session.fast === true,
        });
        // Update and save
        session.messages = outgoing;
        if (result.content) {
            session.messages.push({ role: 'assistant', content: result.content });
        }
        session.updatedAt = Date.now();
        if (result.usage) {
            session.totalInputTokens += result.usage.inputTokens;
            session.totalOutputTokens += result.usage.outputTokens;
        }
        saveSession(session);
        // Async state packet extraction — skip for bridge sessions (short-lived, not reused)
        if (session.owner !== 'bridge') {
            const spCfg = loadConfig();
            if (spCfg.statePacket?.enabled !== false && session.scopeKey && session.messages.filter(m => m.role !== 'system').length > (spCfg.statePacket?.threshold || 20)) {
                extractAndSave(session).catch(() => {});
            }
        }
        return {
            ...result,
            trimmed: messagesDropped > 0,
            messagesDropped,
        };
    } finally {
        unlock();
    }
}
// --- find or create session by scopeKey (atomic, prevents duplicate creation) ---
const _scopeCreateLocks = new Map();
export function findSessionByScopeKey(scopeKey) {
    if (!scopeKey) return null;
    const sessions = listStoredSessions();
    return sessions.find(s => s.scopeKey === scopeKey) || null;
}
export function findOrCreateSession(scopeKey, createFn) {
    if (!scopeKey) return createFn();
    // Synchronous lock: if another call is creating for this scope, wait
    const existing = findSessionByScopeKey(scopeKey);
    if (existing) {
        return existing;
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
    if (!session.owner) session.owner = 'user';
    // Inject state packet if available (scope-keyed, after system messages)
    restoreStatePacket(session);
    // Refresh tools (MCP connections may have changed)
    const oldTools = session.tools || [];
    const skills = collectSkillsCached(session.cwd);
    session.tools = resolveToolPreset((preset || session.preset || 'full'), skills);
    const newTools = session.tools;
    const missing = oldTools.filter(t => !newTools.find(n => n.name === t.name));
    if (missing.length) {
        process.stderr.write(`[session] Warning: ${missing.length} tools no longer available: ${missing.map(t => t.name).join(', ')}\n`);
    }
    saveSession(session);
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
    session.messages = (session.messages || []).filter(m => m && m.role === 'system');
    session.totalInputTokens = 0;
    session.totalOutputTokens = 0;
    session.updatedAt = Date.now();
    saveSession(session);
    return true;
}
export function updateSessionStatus(id, status) {
    const session = loadSession(id);
    if (!session) return false;
    session.status = status;
    session.updatedAt = Date.now();
    saveSession(session);
    return true;
}
export function closeSession(id) {
    return deleteSession(id);
}
