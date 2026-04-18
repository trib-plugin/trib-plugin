/**
 * OpenAI ChatGPT OAuth (Codex) provider.
 *
 * Uses Codex Responses API (chatgpt.com/backend-api/codex/responses)
 * with SSE streaming. Authenticates via PKCE OAuth or reuses ~/.codex/auth.json.
 */
import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getPluginData } from '../config.mjs';
import { enrichModels } from './model-catalog.mjs';

// Codex Responses CLI docs (openai/codex command reference) specify
// session_id Type: uuid. Our session ids are Date-based strings, so Codex
// silently rejects them and never emits cached_tokens. Hash our session
// id into a deterministic UUIDv4-shaped string — same input → same UUID,
// so repeated turns keep landing on the same Codex conversation.
function sessionIdToUuid(sessionId) {
    if (!sessionId) return null;
    const h = createHash('sha256').update(String(sessionId)).digest('hex');
    const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
    return [
        h.slice(0, 8),
        h.slice(8, 12),
        '4' + h.slice(13, 16),
        variant + h.slice(17, 20),
        h.slice(20, 32),
    ].join('-');
}
import {
    extractCachedTokens,
    traceBridgeFetch,
    traceBridgeSse,
    traceBridgeUsage,
} from '../bridge-trace.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
// --- Constants ---
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CALLBACK_PORT = 1455;
// Version string baked into the models endpoint query — Codex rejects the
// request without it. Keep close to the latest published Codex CLI because
// older versions trigger a visibility-filtered catalog (e.g. only rollout
// models). Bump when the real CLI bumps.
const CODEX_CLIENT_VERSION = '0.107.0';
const CODEX_MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;

function _codexModelCachePath() {
    return join(getPluginData(), 'openai-oauth-models.json');
}

async function _loadCodexModelCache() {
    const path = _codexModelCachePath();
    if (!existsSync(path)) return null;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (!raw?.fetchedAt || !Array.isArray(raw.models)) return null;
        if (Date.now() - raw.fetchedAt > CODEX_MODEL_CACHE_TTL_MS) return null;
        return raw.models;
    } catch { return null; }
}

async function _saveCodexModelCache(models) {
    try {
        writeFileSync(_codexModelCachePath(), JSON.stringify({
            fetchedAt: Date.now(),
            models,
        }, null, 2));
        _inMemoryCodexCatalog = Array.isArray(models) ? models.slice() : null;
    } catch { /* best-effort */ }
}

// In-memory mirror of the on-disk catalog, same pattern as anthropic-oauth.
// Populated on first listModels() and after every _saveCodexModelCache.
let _inMemoryCodexCatalog = null;
let _codexRefreshInFlight = null;

function _codexCatalogHas(id) {
    if (!id || !Array.isArray(_inMemoryCodexCatalog)) return false;
    return _inMemoryCodexCatalog.some(m => m.id === id);
}

// Codex returns dated ids (gpt-5.4-mini-2026-03-17). Strip the trailing
// -YYYY-MM-DD to get the version alias (gpt-5.4-mini). Unknown shapes pass
// through unchanged.
function _displayCodexModel(id) {
    if (!id || typeof id !== 'string') return id;
    return id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function _normalizeCodexModel(m) {
    const id = m?.slug || m?.id;
    const family = _codexFamily(id);
    // Codex doesn't use dated ids — everything is effectively a version alias.
    return {
        id,
        name: m?.display_name || id,
        display: m?.display_name || id,
        family,
        provider: 'openai-oauth',
        contextWindow: m?.context_window || 1000000,
        outputTokens: m?.auto_compact_token_limit || 32768,
        tier: 'version',
        latest: false,
        description: m?.description || '',
        reasoningLevels: (m?.supported_reasoning_levels || []).map(r => r.effort),
    };
}

function _codexFamily(id) {
    const s = String(id || '').toLowerCase();
    if (s.includes('nano')) return 'gpt-nano';
    if (s.includes('mini')) return 'gpt-mini';
    if (s.includes('codex')) return 'gpt-codex';
    if (s.startsWith('gpt-5.4')) return 'gpt-5.4';
    if (s.startsWith('gpt-5.2')) return 'gpt-5.2';
    if (s.startsWith('gpt-5')) return 'gpt-5';
    return 'gpt';
}
function getOwnTokenPath() {
    const dir = getPluginData();
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return join(dir, 'openai-oauth.json');
}
function loadTokens() {
    // Try own token store first (has accurate expires_at from refresh)
    const ownPath = getOwnTokenPath();
    if (existsSync(ownPath)) {
        try {
            const own = JSON.parse(readFileSync(ownPath, 'utf-8'));
            if (own.access_token && own.refresh_token) return own;
        }
        catch { /* fall through */ }
    }
    // Otherwise read Codex CLI auth.json (initial bootstrap only)
    const codexPath = join(homedir(), '.codex', 'auth.json');
    if (existsSync(codexPath)) {
        try {
            const data = JSON.parse(readFileSync(codexPath, 'utf-8'));
            const tokens = data.tokens || data;
            if (tokens.access_token && tokens.refresh_token) {
                const expiresAt = typeof data.expires_at === 'number'
                    ? (data.expires_at < 1e12 ? data.expires_at * 1000 : data.expires_at)
                    : (data.last_refresh ? new Date(data.last_refresh).getTime() + 3600_000 : 0);
                return {
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token,
                    expires_at: expiresAt,
                    account_id: tokens.account_id || extractAccountId(tokens.access_token),
                };
            }
        }
        catch { /* fall through */ }
    }
    return null;
}
function saveTokens(tokens) {
    writeFileSync(getOwnTokenPath(), JSON.stringify(tokens, null, 2));
}
function extractAccountId(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3)
            return undefined;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        return payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
    }
    catch {
        return undefined;
    }
}
// --- Token refresh ---
async function refreshTokens(refreshToken) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: CLIENT_ID,
            }),
            signal: controller.signal,
        });
        if (!res.ok)
            return null;
        const json = await res.json();
        if (!json.access_token || !json.refresh_token || !json.expires_in)
            return null;
        const tokens = {
            access_token: json.access_token,
            refresh_token: json.refresh_token,
            expires_at: Date.now() + json.expires_in * 1000,
            account_id: extractAccountId(json.access_token),
        };
        saveTokens(tokens);
        return tokens;
    } catch (err) {
        if (err?.name === 'AbortError')
            throw new Error('OpenAI OAuth token refresh timed out after 30000ms');
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}
async function parseSSEStream(response, signal, abortStream, onStreamDelta, onToolCall) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let model = '';
    let toolCalls = [];
    let usage;
    let buffer = '';
    let idleTimedOut = false;
    let idleTimer = null;
    let responseId = '';
    const pendingCalls = new Map();
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
        if (signal.aborted) throw new Error('Codex SSE stream aborted');
        signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        resetIdleTimer();
        while (true) {
            let chunk;
            try { chunk = await reader.read(); } catch (err) {
                if (idleTimedOut) throw new Error('Codex SSE stream timed out after 60000ms of inactivity');
                if (signal?.aborted) throw new Error('Codex SSE stream aborted');
                throw err;
            }
            const { done, value } = chunk;
            if (done) break;
            resetIdleTimer();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;
                try {
                    const event = JSON.parse(data);
                    if (event.type === 'response.output_text.delta') {
                        content += event.delta || '';
                        try { onStreamDelta?.(); } catch {}
                    }
                    if (event.type === 'response.created') {
                        if (event.response?.model) model = event.response.model;
                        if (event.response?.id) responseId = event.response.id;
                    }
                    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
                        pendingCalls.set(event.item.id || '', {
                            name: event.item.name || '',
                            callId: event.item.call_id || '',
                        });
                    }
                    if (event.type === 'response.function_call_arguments.delta') {
                        try { onStreamDelta?.(); } catch {}
                    }
                    if (event.type === 'response.function_call_arguments.done') {
                        const itemId = event.item_id || '';
                        const pending = pendingCalls.get(itemId);
                        const call = {
                            id: pending?.callId || `tc_${Date.now()}_${toolCalls.length}`,
                            name: pending?.name || '',
                            arguments: JSON.parse(event.arguments || '{}'),
                        };
                        toolCalls.push(call);
                        // Eager dispatch: let the loop start executing the
                        // tool before `response.completed` arrives. The loop
                        // keys pending promises by call.id so order is safe.
                        try { onToolCall?.(call); } catch {}
                        try { onStreamDelta?.(); } catch {}
                    }
                    if (event.type === 'response.completed' && event.response?.usage) {
                        const u = event.response.usage;
                        usage = {
                            inputTokens: u.input_tokens || 0,
                            outputTokens: u.output_tokens || 0,
                            cachedTokens: extractCachedTokens(u),
                            raw: u,
                        };
                        if (!model && event.response.model) model = event.response.model;
                        if (!responseId && event.response.id) responseId = event.response.id;
                        if (!content && event.response.output) {
                            for (const item of event.response.output) {
                                if (item.type === 'message') {
                                    for (const c of item.content || []) {
                                        if (c.type === 'output_text') content += c.text || '';
                                    }
                                }
                            }
                        }
                    }
                } catch { /* skip malformed events */ }
            }
        }
        return { content, model, toolCalls: toolCalls.length ? toolCalls : undefined, usage, responseId: responseId || undefined };
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        try { reader.releaseLock(); } catch {}
    }
}
// --- Build Responses API request ---
/**
 * Convert a message slice to Responses API input items.
 */
function convertMessagesToResponsesInput(messages) {
    const out = [];
    for (const m of messages) {
        if (!m || m.role === 'system') continue;
        if (m.role === 'tool') {
            out.push({
                type: 'function_call_output',
                call_id: m.toolCallId || '',
                output: m.content,
            });
            continue;
        }
        if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
            if (m.content) out.push({ role: 'assistant', content: m.content });
            for (const tc of m.toolCalls) {
                out.push({
                    type: 'function_call',
                    call_id: tc.id,
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                });
            }
            continue;
        }
        out.push({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
        });
    }
    return out;
}
function buildRequestBody(messages, model, tools, sendOpts) {
    // Extract system/instructions
    const systemMsgs = messages.filter(m => m.role === 'system');
    const instructions = systemMsgs.map(m => m.content).join('\n\n') || 'You are a helpful assistant.';
    const opts = sendOpts || {};
    const input = convertMessagesToResponsesInput(messages);
    // Match the body shape pi-mono and the official Codex CLI ship so the
    // server-side auto-cache routes correctly. text.verbosity / include /
    // tool_choice / parallel_tool_calls are all inert without side effects
    // for most callers but their presence affects how Codex classifies the
    // request (and therefore whether the prompt cache is consulted).
    const body = {
        model,
        instructions,
        input,
        store: false,
        stream: true,
        reasoning: { effort: opts.effort || 'medium' },
        text: { verbosity: 'medium' },
        include: ['reasoning.encrypted_content'],
        tool_choice: 'auto',
        parallel_tool_calls: true,
    };
    const cacheKey = opts.promptCacheKey || opts.sessionId;
    if (cacheKey) {
        body.prompt_cache_key = String(cacheKey);
    }
    // NOTE: prompt_cache_retention is a public OpenAI Responses API parameter —
    // the Codex endpoint (chatgpt.com/backend-api/codex/responses) returns
    // 400 "Unsupported parameter" when it's included. Leave cache behavior
    // to the Codex server-side default (in-memory, 5-10 min). Callers who
    // want extended retention should use the public OpenAI API provider
    // instead of OAuth.
    if (opts.fast === true) {
        body.service_tier = 'priority';
    }
    // Add tools
    if (tools?.length) {
        body.tools = tools.map(t => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        }));
    }
    return body;
}
// --- Provider ---
export class OpenAIOAuthProvider {
    name = 'openai-oauth';
    tokens = null;
    _refreshPromise = null;
    config;
    constructor(config) {
        this.config = config || {};
        this.tokens = loadTokens();
    }
    async ensureAuth() {
        if (!this.tokens)
            throw new Error('OpenAI OAuth not authenticated. Run codex login first.');
        // Always refresh if expired or close to expiring (5min buffer)
        if (this.tokens.expires_at < Date.now() + 300_000) {
            process.stderr.write(`[openai-oauth] Token expired/expiring, refreshing...\n`);
            try {
                if (!this._refreshPromise) {
                    this._refreshPromise = refreshTokens(this.tokens.refresh_token)
                        .finally(() => { this._refreshPromise = null; });
                }
                const refreshed = await this._refreshPromise;
                if (refreshed) {
                    this.tokens = refreshed;
                    process.stderr.write(`[openai-oauth] Token refreshed, expires in ${Math.round((refreshed.expires_at - Date.now()) / 1000)}s\n`);
                }
                else {
                    throw new Error('refresh returned null');
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[openai-oauth] Refresh failed: ${msg}, re-reading auth files...\n`);
                // Re-read auth files in case user ran codex login
                const reloaded = loadTokens();
                if (reloaded && reloaded.access_token !== this.tokens?.access_token) {
                    this.tokens = reloaded;
                    process.stderr.write(`[openai-oauth] Reloaded tokens from disk\n`);
                    // Retry refresh with new tokens
                    try {
                        const refreshed2 = await refreshTokens(this.tokens.refresh_token);
                        if (refreshed2) { this.tokens = refreshed2; return this.tokens; }
                    } catch { /* fall through */ }
                }
                throw new Error('OpenAI OAuth token refresh failed. Run codex login to re-authenticate.');
            }
        }
        return this.tokens;
    }
    scrubTokens(text) {
        return text
            .replace(/Bearer [A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]')
            .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[REDACTED]"');
    }
    async send(messages, model, tools, sendOpts) {
        const opts = sendOpts || {};
        const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const externalSignal = opts.signal || null;
        let auth = await this.ensureAuth();
        const useModel = model || 'gpt-5.4';
        const body = buildRequestBody(messages, useModel, tools, sendOpts);
        const sessionId = opts.sessionId || null;
        const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
        const doRequest = async (token) => {
            const controller = createAbortController();
            const timeout = setTimeout(() => controller.abort(), 120_000);
            const fetchStartedAt = Date.now();
            // Bridge external cancellation → inner controller. We can't use
            // createChildAbortController here because `controller` was created
            // independently; instead we forward the abort directly.
            let cancelHandler = null;
            if (externalSignal) {
                if (externalSignal.aborted) {
                    clearTimeout(timeout);
                    controller.abort(externalSignal.reason);
                    throw externalSignal.reason instanceof Error
                        ? externalSignal.reason
                        : new Error('Codex request aborted by session close');
                }
                cancelHandler = () => { try { controller.abort(externalSignal.reason); } catch {} };
                externalSignal.addEventListener('abort', cancelHandler, { once: true });
            }
            try {
                try { onStageChange?.('requesting'); } catch {}
                const response = await fetch(CODEX_API_URL, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token.access_token}`,
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream',
                        'chatgpt-account-id': token.account_id || '',
                        'originator': 'codex_cli_rs',
                        'OpenAI-Beta': 'responses=experimental',
                        // Case D — match pi-mono's production-working
                        // implementation: both underscore `session_id` AND
                        // `x-client-request-id` carry the raw session id on
                        // every request. v0.6.55 used the dash variant
                        // (openai/codex#11732 fix on the Rust CLI), v0.6.62
                        // switched it to a UUID, neither produced cached
                        // tokens. pi-mono's badlogic/pi-mono#3196 issue
                        // thread confirms the cache-routing headers that
                        // actually work end-to-end through chatgpt.com's
                        // Envoy. Keep the dash variant alongside so both
                        // paths receive the value and we do not regress any
                        // deployment that the earlier fix covered.
                        ...(sessionId ? {
                            'session_id': String(sessionId),
                            'session-id': String(sessionId),
                            'x-client-request-id': String(sessionId),
                        } : {}),
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
                    throw reason instanceof Error ? reason : new Error('Codex request aborted by session close');
                }
                if (err?.name === 'AbortError')
                    throw new Error('Codex API initial response timed out after 120000ms');
                throw err;
            }
        };
        // Retry on transient 5xx / connect errors before SSE stream begins.
        // Codex /backend-api/codex/responses 503 has been observed to terminate
        // bridge sessions; once SSE parsing starts we commit and never retry.
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
                throw reason instanceof Error ? reason : new Error('Codex request aborted by session close');
            }
            if (attempt > 0) {
                process.stderr.write(`[openai-oauth] retry attempt ${attempt + 1}/${MAX_ATTEMPTS} after ${lastStatus || 'network error'}\n`);
                await sleep(BACKOFF_MS[attempt]);
                if (externalSignal?.aborted) {
                    const reason = externalSignal.reason;
                    throw reason instanceof Error ? reason : new Error('Codex request aborted by session close');
                }
            }
            try {
                ({ response, controller, cancelHandler } = await doRequest(auth));
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
        if (response.status === 401) {
            process.stderr.write(`[openai-oauth] Got 401, forcing token refresh and retrying...\n`);
            if (cancelHandler && externalSignal) externalSignal.removeEventListener('abort', cancelHandler);
            this.tokens.expires_at = 0;
            auth = await this.ensureAuth();
            ({ response, controller, cancelHandler } = await doRequest(auth));
        }
        if (!response.ok) {
            if (cancelHandler && externalSignal) externalSignal.removeEventListener('abort', cancelHandler);
            const text = await response.text().catch(() => '');
            const safeText = this.scrubTokens(text).slice(0, 200);
            process.stderr.write(`[openai-oauth] API error ${response.status}: ${safeText}\n`);

            // Phase I: on unknown/404 model errors, force a catalog refresh and
            // retry once. Protects against a silently-rotated model id.
            const isUnknownModel = response.status === 404
                || /unknown[_\s-]?model|model[_\s-]?not[_\s-]?found/i.test(safeText);
            if (isUnknownModel && !opts._modelRetry) {
                process.stderr.write(`[openai-oauth] unknown model - refreshing catalog + 1 retry\n`);
                await this._refreshModelCache();
                return this.send(messages, model, tools, { ...opts, _modelRetry: true });
            }
            throw new Error(`Codex API ${response.status}: ${safeText}`);
        }
        process.stderr.write(`[openai-oauth] Response ${response.status}, parsing SSE...\n`);
        try { onStageChange?.('streaming'); } catch {}
        try {
            const sseStartedAt = Date.now();
            const result = await parseSSEStream(response, controller.signal, () => controller.abort(), onStreamDelta, onToolCall);
            traceBridgeSse({
                sessionId,
                sseParseMs: Date.now() - sseStartedAt,
            });
            const liveModel = result.model || useModel;
            traceBridgeUsage({
                sessionId,
                iteration,
                inputTokens: result.usage?.inputTokens || 0,
                outputTokens: result.usage?.outputTokens || 0,
                cachedTokens: result.usage?.cachedTokens || 0,
                model: liveModel,
                modelDisplay: _displayCodexModel(liveModel),
                responseId: result.responseId || null,
                rawUsage: result.usage?.raw || null,
                provider: 'openai-oauth',
            });

            // Phase I: background catalog refresh when live response surfaces
            // a model id that isn't in our cached catalog.
            if (result.model && !_codexCatalogHas(result.model)) {
                void this._refreshModelCache();
            }

            process.stderr.write(`[openai-oauth] Done: ${result.content.length} chars, ${result.toolCalls?.length || 0} tool calls\n`);
            const { responseId: _ignored, ...out } = result;
            return out;
        } finally {
            if (cancelHandler && externalSignal) externalSignal.removeEventListener('abort', cancelHandler);
        }
    }
    async listModels() {
        // Dynamic lookup via Codex /backend-api/codex/models. Cached 24h.
        // Endpoint returns rich metadata (context_window, reasoning levels,
        // visibility) that is more detailed than /v1/models.
        const cached = await _loadCodexModelCache();
        if (cached) {
            _inMemoryCodexCatalog = cached.slice();
            return cached;
        }
        try {
            const auth = await this.ensureAuth();
            const url = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`;
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${auth.access_token}`,
                    'OpenAI-Beta': 'responses=experimental',
                    'originator': 'codex_cli_rs',
                    'chatgpt-account-id': auth.account_id || '',
                },
            });
            if (!res.ok) throw new Error(`codex list_models ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data?.models) ? data.models : [];
            const normalized = items.map(m => _normalizeCodexModel(m));
            const enriched = await enrichModels(normalized);
            await _saveCodexModelCache(enriched);
            return enriched;
        } catch (err) {
            process.stderr.write(`[openai-oauth] listModels fetch failed (${err.message})\n`);
            // No fallback catalog — empty list signals the UI to show a
            // "catalog unavailable, retry" state. Codex has no equivalent to
            // Anthropic's family tokens so there's no meaningful minimal list.
            return [];
        }
    }
    // Force a catalog refresh (ignores 24h TTL). De-duped via
    // _codexRefreshInFlight so concurrent callers share one HTTP round-trip.
    async _refreshModelCache() {
        if (_codexRefreshInFlight) return _codexRefreshInFlight;
        _codexRefreshInFlight = (async () => {
            try {
                const auth = await this.ensureAuth();
                const url = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`;
                const res = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${auth.access_token}`,
                        'OpenAI-Beta': 'responses=experimental',
                        'originator': 'codex_cli_rs',
                        'chatgpt-account-id': auth.account_id || '',
                    },
                });
                if (!res.ok) throw new Error(`codex list_models ${res.status}`);
                const data = await res.json();
                const items = Array.isArray(data?.models) ? data.models : [];
                const normalized = items.map(m => _normalizeCodexModel(m));
                const enriched = await enrichModels(normalized);
                await _saveCodexModelCache(enriched);
                process.stderr.write(`[openai-oauth] catalog refreshed (${enriched.length} models)\n`);
                return enriched;
            } catch (err) {
                process.stderr.write(`[openai-oauth] catalog refresh failed (${err.message})\n`);
                return null;
            } finally {
                _codexRefreshInFlight = null;
            }
        })();
        return _codexRefreshInFlight;
    }

    async isAvailable() {
        return this.tokens !== null;
    }
}
// --- Login flow (export for CLI use) ---
function generatePKCE() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}
export async function loginOAuth() {
    const pkce = generatePKCE();
    const state = randomBytes(16).toString('hex');
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('originator', 'codex_cli_rs');
    process.stderr.write(`\n[openai-oauth] Open this URL to log in:\n${url.toString()}\n\n`);
    try {
        const { exec } = await import('child_process');
        const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        exec(`${opener} "${url.toString()}"`);
    }
    catch { /* user opens manually */ }
    return new Promise((resolve) => {
        const timeout = setTimeout(() => { server.close(); resolve(null); }, 120_000);
        const server = createServer(async (req, res) => {
            const u = new URL(req.url || '/', `http://localhost:${CALLBACK_PORT}`);
            if (u.pathname !== '/auth/callback') {
                res.writeHead(404);
                res.end();
                return;
            }
            const code = u.searchParams.get('code');
            if (!code || u.searchParams.get('state') !== state) {
                res.writeHead(400);
                res.end('Invalid');
                clearTimeout(timeout);
                server.close();
                resolve(null);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>Login successful!</h2></body></html>');
            clearTimeout(timeout);
            server.close();
            // Exchange code for tokens
            const tokenRes = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code', client_id: CLIENT_ID,
                    code, code_verifier: pkce.verifier, redirect_uri: REDIRECT_URI,
                }),
            });
            if (!tokenRes.ok) {
                resolve(null);
                return;
            }
            const json = await tokenRes.json();
            if (!json.access_token || !json.refresh_token) {
                resolve(null);
                return;
            }
            const tokens = {
                access_token: json.access_token, refresh_token: json.refresh_token,
                expires_at: Date.now() + (json.expires_in || 3600) * 1000,
                account_id: extractAccountId(json.access_token),
            };
            saveTokens(tokens);
            resolve(tokens);
        });
        server.listen(CALLBACK_PORT, '127.0.0.1');
        server.on('error', () => { clearTimeout(timeout); resolve(null); });
    });
}
