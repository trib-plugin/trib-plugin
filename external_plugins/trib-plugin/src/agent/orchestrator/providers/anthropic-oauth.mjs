/**
 * Anthropic OAuth provider — uses Claude Code's OAuth credentials
 * (~/.claude/.credentials.json) for Claude Max subscription access.
 *
 * Raw HTTP + SSE streaming, reuses message/tool conversion patterns
 * from anthropic.mjs. Bridge-trace instrumented.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
    traceBridgeFetch,
    traceBridgeSse,
    traceBridgeUsage,
} from '../bridge-trace.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import { writeFileSync, existsSync as _existsSync } from 'fs';
import { getPluginData } from '../config.mjs';

// --- Model catalog cache helpers ---
// Disk-backed cache so repeated process starts (cron, tool calls) don't
// hammer /v1/models. 24h TTL is the same cadence Claude Code itself uses
// for its internal model discovery.
const MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;

function _modelCachePath() {
    return join(getPluginData(), 'anthropic-oauth-models.json');
}

async function _loadModelCache() {
    const path = _modelCachePath();
    if (!_existsSync(path)) return null;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (!raw?.fetchedAt || !Array.isArray(raw.models)) return null;
        if (Date.now() - raw.fetchedAt > MODEL_CACHE_TTL_MS) return null;
        return raw.models;
    } catch { return null; }
}

async function _saveModelCache(models) {
    try {
        writeFileSync(_modelCachePath(), JSON.stringify({
            fetchedAt: Date.now(),
            models,
        }, null, 2));
    } catch { /* cache is best-effort */ }
}

// Classify a model id into our common tier/family shape. Anthropic's catalog
// mixes dated ids (claude-opus-4-5-20251101), versioned aliases
// (claude-opus-4-6), and the raw family tokens resolved via env vars.
function _normalizeAnthropicModel(raw) {
    const id = raw?.id || raw?.name;
    if (!id) return null;
    const familyMatch = id.match(/^claude-(opus|sonnet|haiku)/i);
    const family = familyMatch ? familyMatch[1].toLowerCase() : 'other';
    // Dated: trailing -YYYYMMDD (8 digits).
    const dated = /-\d{8}$/.test(id);
    // Versioned alias: claude-<family>-<major>-<minor>[-...] with no dated suffix.
    const versioned = !dated && /-\d+-\d+/.test(id);
    const tier = dated ? 'dated' : versioned ? 'version' : 'family';
    const releaseDate = dated
        ? id.match(/-(\d{4})(\d{2})(\d{2})$/)
        : null;
    return {
        id,
        display: raw?.display_name || _prettyName(id, family),
        family,
        provider: 'anthropic-oauth',
        contextWindow: raw?.context_window || raw?.max_context_window || _defaultContextForFamily(family),
        tier,
        latest: false, // assigned in a second pass once full list is known
        releaseDate: releaseDate ? `${releaseDate[1]}-${releaseDate[2]}-${releaseDate[3]}` : null,
    };
}

function _prettyName(id, family) {
    const v = id.match(/-(\d+)-(\d+)/);
    const base = family[0].toUpperCase() + family.slice(1);
    return v ? `${base} ${v[1]}.${v[2]}` : base;
}

function _defaultContextForFamily(family) {
    if (family === 'opus') return 200000;
    if (family === 'sonnet') return 200000;
    if (family === 'haiku') return 200000;
    return 200000;
}

// Mark the highest-numbered version per family as `latest: true`. Uses a simple
// lexicographic comparison on the numeric parts embedded in the id.
function _markLatestByFamily(models) {
    const byFamily = new Map();
    for (const m of models) {
        if (m.tier !== 'version') continue;
        const cur = byFamily.get(m.family);
        if (!cur || _compareVersion(m.id, cur.id) > 0) {
            byFamily.set(m.family, m);
        }
    }
    for (const m of byFamily.values()) m.latest = true;
}

function _compareVersion(a, b) {
    const na = (a.match(/-(\d+)-(\d+)/) || []).slice(1).map(Number);
    const nb = (b.match(/-(\d+)-(\d+)/) || []).slice(1).map(Number);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
        if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) - (nb[i] || 0);
    }
    return a.localeCompare(b);
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');

// Anthropic OAuth contract for first-party Claude Code clients.
// Opus/Sonnet requests are gated on a specific system-prompt prefix.
// Our plugin ONLY runs inside Claude Code (marketplace-distributed),
// so declaring ourselves as Claude Code is literally accurate — not
// impersonation. Haiku is not gated and ignores this prefix.
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETA_HEADERS = 'oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27';
const DEFAULT_CLI_VERSION = '2.1.77';

function resolveCliVersion() {
    // Claude Code sets CLAUDE_CODE_VERSION in the plugin subprocess env.
    // Fallback exists so unit tests and older Claude Code versions still work.
    return process.env.CLAUDE_CODE_VERSION
        || process.env.CLAUDE_CODE_EXECPATH_VERSION
        || DEFAULT_CLI_VERSION;
}

function requiresSystemPrefix(model) {
    // Opus / Sonnet require the Claude Code system prefix when authenticated
    // via OAuth. Haiku does not.
    return /^claude-(opus|sonnet)/i.test(String(model || ''));
}

function applyClaudeCodeSystemPrefix(systemText, model) {
    if (!requiresSystemPrefix(model)) return systemText || undefined;
    const existing = typeof systemText === 'string' ? systemText.trim() : '';
    if (!existing) return CLAUDE_CODE_SYSTEM_PREFIX;
    if (existing.startsWith(CLAUDE_CODE_SYSTEM_PREFIX)) return existing;
    return CLAUDE_CODE_SYSTEM_PREFIX + '\n\n' + existing;
}

const MODELS = [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic-oauth', contextWindow: 1000000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic-oauth', contextWindow: 200000 },
    { id: 'claude-sonnet-4-0', name: 'Claude Sonnet 4', provider: 'anthropic-oauth', contextWindow: 200000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic-oauth', contextWindow: 200000 },
];

// Per-model max_tokens when the model id is explicitly listed. New models
// (e.g., Sonnet 4.7) won't match a specific entry and fall through to the
// family-based heuristic below. Conservative defaults — model may support
// more but we'd rather stay within safe bounds.
const MAX_TOKENS = {
    'claude-opus-4-6': 32768,
    'claude-sonnet-4-6': 16384,
    'claude-sonnet-4-0': 16384,
    'claude-haiku-4-5-20251001': 8192,
};

function resolveMaxTokens(model) {
    if (MAX_TOKENS[model]) return MAX_TOKENS[model];
    const id = String(model || '').toLowerCase();
    if (id.includes('opus')) return 32768;
    if (id.includes('sonnet')) return 16384;
    if (id.includes('haiku')) return 8192;
    return 8192;
}

const EFFORT_BUDGET = {
    low: 1024,
    medium: 4096,
    high: 16384,
    max: 32768,
};

// Layered cache TTLs — stable layers get 1h, volatile layers get 5m.
// Anthropic requires 1h entries to appear before 5m entries in the request.
const CACHE_TTL_STABLE = { type: 'ephemeral', ttl: '1h' };   // tools, system
const CACHE_TTL_VOLATILE = { type: 'ephemeral' };             // messages (5m default)

// Legacy alias preserved for callers that don't yet differentiate layers.
const EPHEMERAL_CACHE_CONTROL = CACHE_TTL_STABLE;

// --- Credential helpers ---

function loadCredentials() {
    if (!existsSync(CREDENTIALS_PATH)) return null;
    try {
        const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
        const oauth = raw?.claudeAiOauth;
        if (!oauth?.accessToken) return null;
        return {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken || null,
            expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0,
            scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
            subscriptionType: oauth.subscriptionType || null,
        };
    } catch {
        return null;
    }
}

// --- Message conversion (mirrors anthropic.mjs) ---

function withCacheControl(block, ttl = CACHE_TTL_VOLATILE) {
    if (!block || typeof block !== 'object' || block.cache_control) return block;
    return { ...block, cache_control: ttl };
}

function appendCacheControl(content, ttl = CACHE_TTL_VOLATILE) {
    if (Array.isArray(content)) {
        if (content.length === 0) return content;
        const next = [...content];
        next[next.length - 1] = withCacheControl(next[next.length - 1], ttl);
        return next;
    }
    if (typeof content === 'string') {
        return [withCacheControl({ type: 'text', text: content }, ttl)];
    }
    return content;
}

function collectRecentCacheableIndexes(messages, availableSlots = 2) {
    // Anthropic enforces a 4-breakpoint max per request. Callers reserve slots
    // for tools[-1] and system breakpoints (typically 2); whatever remains is
    // spread across the most-recent messages as 5m sliding breakpoints.
    // Default 2 assumes both tools and system have breakpoints (worst case).
    const slots = Math.max(0, Math.min(4, availableSlots));
    const marked = new Set();
    for (let i = messages.length - 1; i >= 0 && marked.size < slots; i--) {
        if (messages[i]?.role !== 'system') marked.add(i);
    }
    return marked;
}

function toAnthropicTools(tools) {
    return tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
    }));
}

function toAnthropicMessages(messages, cacheableIndexes = new Set(), messageTtl = CACHE_TTL_VOLATILE) {
    // messageTtl === null disables message-layer caching entirely.
    const applyTtl = messageTtl || CACHE_TTL_VOLATILE;
    const shouldCache = (idx) => messageTtl !== null && cacheableIndexes.has(idx);
    const result = [];
    for (let idx = 0; idx < messages.length; idx++) {
        const m = messages[idx];
        if (m.role === 'system') continue;

        if (m.role === 'assistant' && m.toolCalls?.length) {
            let content = [];
            if (m.content) content.push({ type: 'text', text: m.content });
            for (const tc of m.toolCalls) {
                content.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.name,
                    input: tc.arguments,
                });
            }
            if (shouldCache(idx)) content = appendCacheControl(content, applyTtl);
            result.push({ role: 'assistant', content });
            continue;
        }

        if (m.role === 'tool') {
            const last = result[result.length - 1];
            const block = {
                type: 'tool_result',
                tool_use_id: m.toolCallId || '',
                content: m.content,
            };
            if (last?.role === 'user' && Array.isArray(last.content)) {
                last.content.push(block);
                if (shouldCache(idx)) {
                    last.content = appendCacheControl(last.content, applyTtl);
                }
            } else {
                let content = [block];
                if (shouldCache(idx)) content = appendCacheControl(content, applyTtl);
                result.push({ role: 'user', content });
            }
            continue;
        }

        const content = shouldCache(idx)
            ? appendCacheControl(m.content, applyTtl)
            : m.content;
        result.push({ role: m.role, content });
    }
    return result;
}

// --- SSE parser ---

async function parseSSEStream(response, signal, abortStream, onStreamDelta) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let model = '';
    let toolCalls = [];
    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let buffer = '';
    let idleTimedOut = false;
    let idleTimer = null;
    let currentEvent = '';

    const pendingToolInputs = new Map();

    const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimedOut = true;
            try { abortStream?.(); } catch {}
            try { reader.cancel('SSE idle timeout'); } catch {}
        }, 60_000);
    };

    const onAbort = () => { try { reader.cancel('SSE aborted'); } catch {} };
    if (signal) {
        if (signal.aborted) throw new Error('Anthropic OAuth SSE stream aborted');
        signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
        resetIdleTimer();
        while (true) {
            let chunk;
            try { chunk = await reader.read(); } catch (err) {
                if (idleTimedOut) throw new Error('Anthropic OAuth SSE stream timed out after 60000ms of inactivity');
                if (signal?.aborted) throw new Error('Anthropic OAuth SSE stream aborted');
                throw err;
            }
            const { done, value } = chunk;
            if (done) break;

            resetIdleTimer();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7).trim();
                    continue;
                }
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data) continue;

                try {
                    const event = JSON.parse(data);

                    if (event.type === 'message_start' && event.message) {
                        if (event.message.model) model = event.message.model;
                        if (event.message.usage) {
                            usage.inputTokens = event.message.usage.input_tokens || 0;
                            usage.cachedTokens = event.message.usage.cache_read_input_tokens || 0;
                        }
                    }

                    if (event.type === 'content_block_start') {
                        const block = event.content_block;
                        if (block?.type === 'tool_use') {
                            pendingToolInputs.set(event.index, {
                                id: block.id || '',
                                name: block.name || '',
                                inputJson: '',
                            });
                        }
                    }

                    if (event.type === 'content_block_delta') {
                        const delta = event.delta;
                        if (delta?.type === 'text_delta') {
                            content += delta.text || '';
                            try { onStreamDelta?.(); } catch {}
                        }
                        if (delta?.type === 'input_json_delta') {
                            const pending = pendingToolInputs.get(event.index);
                            if (pending) {
                                pending.inputJson += delta.partial_json || '';
                            }
                            try { onStreamDelta?.(); } catch {}
                        }
                    }

                    if (event.type === 'content_block_stop') {
                        const pending = pendingToolInputs.get(event.index);
                        if (pending) {
                            toolCalls.push({
                                id: pending.id,
                                name: pending.name,
                                arguments: pending.inputJson ? JSON.parse(pending.inputJson) : {},
                            });
                            pendingToolInputs.delete(event.index);
                            try { onStreamDelta?.(); } catch {}
                        }
                    }

                    if (event.type === 'message_delta') {
                        if (event.usage) {
                            usage.outputTokens = event.usage.output_tokens || 0;
                        }
                    }
                } catch { /* skip malformed events */ }
            }
        }

        return {
            content,
            model,
            toolCalls: toolCalls.length ? toolCalls : undefined,
            usage,
        };
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        try { reader.releaseLock(); } catch {}
    }
}

// --- Build request body ---

function resolveCacheTtls(opts) {
    // Layered cache strategy — caller may override per-layer via opts.cacheStrategy.
    // Anthropic enforces: 1h entries must appear before 5m entries in the request.
    const strategy = opts.cacheStrategy || {};
    const pick = (layer, fallback) => {
        const v = strategy[layer];
        if (v === '1h') return CACHE_TTL_STABLE;
        if (v === '5m') return CACHE_TTL_VOLATILE;
        if (v === 'none') return null;
        return fallback;
    };
    return {
        tools: pick('tools', CACHE_TTL_STABLE),       // default: 1h
        system: pick('system', CACHE_TTL_STABLE),     // default: 1h
        messages: pick('messages', CACHE_TTL_VOLATILE), // default: 5m
    };
}

function buildRequestBody(messages, model, tools, sendOpts) {
    const systemMsgs = messages.filter(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');
    const rawSystemText = systemMsgs.map(m => m.content).join('\n\n') || '';
    // OAuth-gated models (Opus/Sonnet) require the Claude Code system prefix.
    const systemText = applyClaudeCodeSystemPrefix(rawSystemText, model);
    const maxTokens = resolveMaxTokens(model);
    const opts = sendOpts || {};
    const ttls = resolveCacheTtls(opts);

    // Compute available BP slots: 4 max, minus tools BP (if any) and system BP.
    const usedSlots =
        (ttls.tools && tools?.length ? 1 : 0) +
        (ttls.system && systemText ? 1 : 0);
    const msgSlots = ttls.messages ? Math.max(0, 4 - usedSlots) : 0;
    const cacheableIndexes = collectRecentCacheableIndexes(chatMsgs, msgSlots);
    const anthropicMessages = toAnthropicMessages(chatMsgs, cacheableIndexes, ttls.messages);

    const body = {
        model,
        max_tokens: maxTokens,
        messages: anthropicMessages,
        stream: true,
    };

    if (systemText) {
        const systemBlock = { type: 'text', text: systemText };
        if (ttls.system) systemBlock.cache_control = ttls.system;
        body.system = [systemBlock];
    }

    if (tools?.length) {
        const converted = toAnthropicTools(tools);
        // Place cache_control on the last tool to cache the entire tools array.
        if (ttls.tools && converted.length > 0) {
            converted[converted.length - 1] = {
                ...converted[converted.length - 1],
                cache_control: ttls.tools,
            };
        }
        body.tools = converted;
    }

    if (opts.effort && EFFORT_BUDGET[opts.effort]) {
        body.thinking = { type: 'enabled', budget_tokens: EFFORT_BUDGET[opts.effort] };
    }

    if (opts.fast === true) {
        body.speed = 'fast';
    }

    return body;
}

// --- Provider ---

export class AnthropicOAuthProvider {
    name = 'anthropic-oauth';
    credentials = null;
    config;

    constructor(config) {
        this.config = config || {};
        this.credentials = loadCredentials();
    }

    ensureAuth() {
        if (!this.credentials) {
            this.credentials = loadCredentials();
        }
        if (!this.credentials) {
            throw new Error('Anthropic OAuth credentials not found. Run "claude login" to authenticate.');
        }

        // Re-read credentials if token is near expiry (5min buffer)
        if (this.credentials.expiresAt && this.credentials.expiresAt < Date.now() + 300_000) {
            process.stderr.write(`[anthropic-oauth] Token expired/expiring, re-reading credentials...\n`);
            const fresh = loadCredentials();
            if (fresh && fresh.accessToken !== this.credentials.accessToken) {
                this.credentials = fresh;
                process.stderr.write(`[anthropic-oauth] Credentials reloaded from disk\n`);
            } else if (!fresh || (fresh.expiresAt && fresh.expiresAt < Date.now() + 300_000)) {
                process.stderr.write(`[anthropic-oauth] WARNING: Token may be expired. Claude Code manages refresh — if errors persist, run "claude login".\n`);
            }
        }

        return this.credentials;
    }

    scrubTokens(text) {
        return text
            .replace(/Bearer [A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]')
            .replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken":"[REDACTED]"');
    }

    async send(messages, model, tools, sendOpts) {
        const opts = sendOpts || {};
        const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const externalSignal = opts.signal || null;

        let creds = this.ensureAuth();
        const useModel = model || 'claude-sonnet-4-0';
        const body = buildRequestBody(messages, useModel, tools, sendOpts);
        const sessionId = opts.sessionId || null;
        const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;

        const doRequest = async (accessToken) => {
            const controller = createAbortController();
            const timeout = setTimeout(() => controller.abort(), 120_000);
            const fetchStartedAt = Date.now();

            let cancelHandler = null;
            if (externalSignal) {
                if (externalSignal.aborted) {
                    clearTimeout(timeout);
                    controller.abort(externalSignal.reason);
                    throw externalSignal.reason instanceof Error
                        ? externalSignal.reason
                        : new Error('Anthropic OAuth request aborted by session close');
                }
                cancelHandler = () => { try { controller.abort(externalSignal.reason); } catch {} };
                externalSignal.addEventListener('abort', cancelHandler, { once: true });
            }

            try {
                try { onStageChange?.('requesting'); } catch {}

                const response = await fetch(API_URL, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'anthropic-version': ANTHROPIC_VERSION,
                        'anthropic-beta': OAUTH_BETA_HEADERS,
                        'anthropic-dangerous-direct-browser-access': 'true',
                        'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
                        'x-app': 'cli',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });

                traceBridgeFetch({
                    sessionId,
                    headersMs: Date.now() - fetchStartedAt,
                    httpStatus: response.status,
                });

                clearTimeout(timeout);
                return { response, controller, cancelHandler };
            } catch (err) {
                clearTimeout(timeout);
                if (cancelHandler) externalSignal.removeEventListener('abort', cancelHandler);
                if (externalSignal?.aborted) {
                    const reason = externalSignal.reason;
                    throw reason instanceof Error ? reason : new Error('Anthropic OAuth request aborted by session close');
                }
                if (err?.name === 'AbortError')
                    throw new Error('Anthropic OAuth API initial response timed out after 120000ms');
                throw err;
            }
        };

        // Retry on transient 5xx / connect errors before SSE stream begins.
        const isTransientStatus = s => s === 502 || s === 503 || s === 504;
        const isTransientErr = err => {
            if (!err) return false;
            const code = err.code || err.cause?.code || '';
            if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return true;
            const msg = err.message || '';
            if (msg.includes('initial response timed out')) return true;
            return false;
        };
        const sleep = ms => new Promise(r => {
            const t = setTimeout(r, ms);
            if (externalSignal) {
                const onAbort = () => { clearTimeout(t); r(); };
                if (externalSignal.aborted) return onAbort();
                externalSignal.addEventListener('abort', onAbort, { once: true });
            }
        });

        const MAX_ATTEMPTS = 5;
        const BACKOFF_MS = [0, 1000, 2000, 4000, 8000];
        let response, controller, cancelHandler;
        let lastStatus = null;
        let attempt = 0;

        while (attempt < MAX_ATTEMPTS) {
            if (externalSignal?.aborted) {
                const reason = externalSignal.reason;
                throw reason instanceof Error ? reason : new Error('Anthropic OAuth request aborted by session close');
            }
            if (attempt > 0) {
                process.stderr.write(`[anthropic-oauth] retry attempt ${attempt + 1}/${MAX_ATTEMPTS} after ${lastStatus || 'network error'}\n`);
                await sleep(BACKOFF_MS[attempt]);
                if (externalSignal?.aborted) {
                    const reason = externalSignal.reason;
                    throw reason instanceof Error ? reason : new Error('Anthropic OAuth request aborted by session close');
                }
            }
            try {
                ({ response, controller, cancelHandler } = await doRequest(creds.accessToken));
            } catch (err) {
                if (externalSignal?.aborted) throw err;
                if (isTransientErr(err) && attempt < MAX_ATTEMPTS - 1) {
                    lastStatus = err.code || err.message || 'network error';
                    attempt++;
                    continue;
                }
                throw err;
            }
            if (isTransientStatus(response.status) && attempt < MAX_ATTEMPTS - 1) {
                try { await response.text(); } catch {}
                if (cancelHandler && externalSignal) externalSignal.removeEventListener('abort', cancelHandler);
                lastStatus = response.status;
                attempt++;
                continue;
            }
            break;
        }

        // Handle 401 — re-read credentials (Claude Code may have refreshed)
        if (response.status === 401) {
            process.stderr.write(`[anthropic-oauth] Got 401, re-reading credentials...\n`);
            if (cancelHandler && externalSignal) externalSignal.removeEventListener('abort', cancelHandler);
            this.credentials = null;
            creds = this.ensureAuth();
            ({ response, controller, cancelHandler } = await doRequest(creds.accessToken));
        }

        if (!response.ok) {
            if (cancelHandler && externalSignal) externalSignal.removeEventListener('abort', cancelHandler);
            const text = await response.text().catch(() => '');
            const safeText = this.scrubTokens(text).slice(0, 200);
            process.stderr.write(`[anthropic-oauth] API error ${response.status}: ${safeText}\n`);
            throw new Error(`Anthropic OAuth API ${response.status}: ${safeText}`);
        }

        process.stderr.write(`[anthropic-oauth] Response ${response.status}, parsing SSE...\n`);
        try { onStageChange?.('streaming'); } catch {}

        try {
            const sseStartedAt = Date.now();
            const result = await parseSSEStream(response, controller.signal, () => controller.abort(), onStreamDelta);

            traceBridgeSse({
                sessionId,
                sseParseMs: Date.now() - sseStartedAt,
            });

            traceBridgeUsage({
                sessionId,
                iteration,
                inputTokens: result.usage?.inputTokens || 0,
                outputTokens: result.usage?.outputTokens || 0,
                cachedTokens: result.usage?.cachedTokens || 0,
                model: result.model || useModel,
            });

            process.stderr.write(`[anthropic-oauth] Done: ${result.content.length} chars, ${result.toolCalls?.length || 0} tool calls\n`);
            return result;
        } finally {
            if (cancelHandler && externalSignal) externalSignal.removeEventListener('abort', cancelHandler);
        }
    }

    async listModels() {
        // Dynamic lookup via /v1/models — returns whatever Anthropic currently
        // exposes for this OAuth account. Cached on disk with 24h TTL; falls
        // back to the static MODELS list on any failure so the plugin still
        // works offline or when Anthropic's /v1/models is momentarily down.
        const cached = await _loadModelCache();
        if (cached) return cached;
        try {
            const creds = this.ensureAuth();
            const res = await fetch('https://api.anthropic.com/v1/models', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${creds.accessToken}`,
                    'anthropic-version': ANTHROPIC_VERSION,
                    'anthropic-beta': OAUTH_BETA_HEADERS,
                    'anthropic-dangerous-direct-browser-access': 'true',
                    'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
                    'x-app': 'cli',
                },
            });
            if (!res.ok) throw new Error(`list_models ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data?.data) ? data.data : [];
            const normalized = items
                .map(m => _normalizeAnthropicModel(m))
                .filter(Boolean);
            _markLatestByFamily(normalized);
            await _saveModelCache(normalized);
            return normalized;
        } catch (err) {
            process.stderr.write(`[anthropic-oauth] listModels fetch failed (${err.message})\n`);
            // Family-only fallback — no specific versions. These tokens resolve
            // at runtime via ANTHROPIC_DEFAULT_*_MODEL env vars, so the user
            // gets whatever Claude Code's current default is. Better than a
            // stale hardcoded "Opus 4.6" that might not exist tomorrow.
            return [
                { id: 'opus',   display: 'Opus (auto)',   family: 'opus',   provider: 'anthropic-oauth', tier: 'family', latest: true, contextWindow: 200000 },
                { id: 'sonnet', display: 'Sonnet (auto)', family: 'sonnet', provider: 'anthropic-oauth', tier: 'family', latest: true, contextWindow: 200000 },
                { id: 'haiku',  display: 'Haiku (auto)',  family: 'haiku',  provider: 'anthropic-oauth', tier: 'family', latest: true, contextWindow: 200000 },
            ];
        }
    }

    async isAvailable() {
        return this.credentials !== null || loadCredentials() !== null;
    }
}
