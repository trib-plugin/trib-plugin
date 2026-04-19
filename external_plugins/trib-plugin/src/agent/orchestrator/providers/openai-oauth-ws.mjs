/**
 * OpenAI Codex OAuth — WebSocket transport.
 *
 * Single dispatch path for the openai-oauth provider (SSE removed in
 * v0.6.117). Uses the `responses_websockets=2026-02-06` beta WebSocket
 * upgrade on chatgpt.com/backend-api/codex/responses. Per-session
 * connections are pooled (5 min idle TTL, up to 8 parallel sockets per
 * key) so subsequent tool-loop iterations can send only the incremental
 * `input` delta plus `previous_response_id`, skipping the full
 * tools/system/history prefix each turn.
 *
 * References:
 * - pi-mono packages/ai/src/providers/openai-codex-responses.ts
 *   (acquireWebSocket/release, get_incremental_items delta logic).
 * - openai/codex codex-rs/core/src/client.rs (turn-state echo header).
 *
 * Exposes:
 *   sendViaWebSocket({ auth, body, sendOpts, onStreamDelta, onToolCall,
 *                      onStageChange, externalSignal, poolKey, cacheKey, iteration,
 *                      useModel, traceCtx })
 *
 * The caller (openai-oauth.mjs) supplies a fully built request body and the
 * auth bundle; this module handles connection caching, delta framing, event
 * parsing, and tracing.
 */
import WebSocket from 'ws';
import {
    extractCachedTokens,
    traceBridgeFetch,
    traceBridgeSse,
    traceBridgeUsage,
    appendBridgeTrace,
} from '../bridge-trace.mjs';

const CODEX_WS_URL = 'wss://chatgpt.com/backend-api/codex/responses';
const WS_IDLE_MS = 5 * 60_000;
const WS_HANDSHAKE_TIMEOUT_MS = 30_000;
// Codex can stall for 50+s between chunks on long reasoning requests
// (observed: iter 5 of a multi-file review produced sse_parse_ms=58265).
// Iter-boundary reasoning pauses after large tool_output batches (e.g.
// 8× multi_read) have been observed past 120s, so raising the ceiling
// to 300s. armPreStreamWatchdog releases on first chunk, so healthy
// requests are unaffected by the larger cap.
const WS_STREAM_IDLE_MS = 300_000;
// WS socket pool buckets are keyed by `poolKey` (the per-call sessionId)
// to isolate parallel bridge invocations — each gets its own socket so
// a second caller cannot grab a sibling's mid-turn entry (Codex would
// otherwise reject the new response.create with "No tool output found
// for function call ..."). The Codex handshake `session_id` header/URL
// uses `cacheKey` — a provider-scoped unified key (e.g. 'trib-codex')
// built in manager.mjs via providerCacheKey(). All orchestrator-internal
// dispatches targeting this provider share the same cacheKey, so the
// server-side prompt-cache shard is shared across every role/source.
// Codex dedupes cache by handshake session_id, not by
// body.prompt_cache_key alone (measured 2026-04-19 after the v0.6.151
// regression).
const MAX_POOLED_SOCKETS_PER_KEY = 8;

// poolKey -> Entry[]
// Entry: { socket, busy, idleTimer, lastResponseId, lastRequestSansInput,
//          lastInputLen, turnState, closing, ephemeral }
const _wsPool = new Map();

function _getPoolArr(poolKey) {
    if (!poolKey) return null;
    let arr = _wsPool.get(poolKey);
    if (!arr) {
        arr = [];
        _wsPool.set(poolKey, arr);
    }
    return arr;
}

function _removeFromPool(poolKey, entry) {
    if (!poolKey) return;
    const arr = _wsPool.get(poolKey);
    if (!arr) return;
    const idx = arr.indexOf(entry);
    if (idx >= 0) arr.splice(idx, 1);
    if (arr.length === 0) _wsPool.delete(poolKey);
}

function _scheduleIdleClose(poolKey, entry) {
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
        if (entry.busy) return;
        try { entry.socket.close(1000, 'idle_timeout'); } catch {}
        _removeFromPool(poolKey, entry);
    }, WS_IDLE_MS);
}

function _clearIdle(entry) {
    if (entry?.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
}

function _isOpen(entry) {
    return entry?.socket?.readyState === WebSocket.OPEN;
}

function _buildHandshakeHeaders({ auth, cacheKey, turnState }) {
    const headers = {
        'Authorization': `Bearer ${auth.access_token}`,
        'chatgpt-account-id': auth.account_id || '',
        'originator': 'trib',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
    };
    if (cacheKey) {
        const sid = String(cacheKey);
        headers['session_id'] = sid;
        headers['x-client-request-id'] = sid;
    }
    if (turnState) headers['x-codex-turn-state'] = turnState;
    return headers;
}

function _openSocket({ auth, cacheKey, turnState }) {
    const headers = _buildHandshakeHeaders({ auth, cacheKey, turnState });
    const url = CODEX_WS_URL + (cacheKey ? `?session_id=${encodeURIComponent(String(cacheKey))}` : '');
    return new Promise((resolve, reject) => {
        let settled = false;
        const socket = new WebSocket(url, { headers, handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS });
        const capturedHeaders = { turnState: null };
        socket.once('upgrade', (res) => {
            try {
                const ts = res?.headers?.['x-codex-turn-state'];
                if (typeof ts === 'string' && ts.length) capturedHeaders.turnState = ts;
            } catch {}
        });
        socket.once('open', () => {
            if (settled) return;
            settled = true;
            resolve({ socket, turnState: capturedHeaders.turnState });
        });
        socket.once('error', (err) => {
            if (settled) return;
            settled = true;
            try { socket.terminate(); } catch {}
            reject(err);
        });
        socket.once('unexpected-response', (_req, res) => {
            if (settled) return;
            settled = true;
            const status = res?.statusCode || 0;
            let body = '';
            res.on('data', c => { if (body.length < 2048) body += c.toString('utf-8'); });
            res.on('end', () => {
                try { socket.terminate(); } catch {}
                reject(Object.assign(new Error(`Codex WS handshake ${status}: ${body.slice(0, 200)}`), { httpStatus: status, httpBody: body }));
            });
        });
    });
}

async function acquireWebSocket({ auth, poolKey, cacheKey, forceFresh }) {
    if (poolKey && !forceFresh) {
        const arr = _wsPool.get(poolKey) || [];
        // Prune dead entries first.
        for (let i = arr.length - 1; i >= 0; i--) {
            if (!_isOpen(arr[i]) || arr[i].closing) {
                _clearIdle(arr[i]);
                arr.splice(i, 1);
            }
        }
        if (arr.length === 0) _wsPool.delete(poolKey);
        // Reuse any idle open entry (cache-warm path).
        const idle = arr.find(e => !e.busy);
        if (idle) {
            _clearIdle(idle);
            idle.busy = true;
            return { entry: idle, reused: true };
        }
        // All entries busy and bucket at cap: fall through to ephemeral socket.
        if (arr.length >= MAX_POOLED_SOCKETS_PER_KEY) {
            const { socket, turnState } = await _openSocket({ auth, cacheKey, turnState: null });
            const entry = {
                socket,
                busy: true,
                idleTimer: null,
                lastResponseId: null,
                lastRequestSansInput: null,
                lastInputLen: 0,
                turnState: turnState || null,
                closing: false,
                ephemeral: true,
            };
            socket.on('close', () => { entry.closing = true; });
            return { entry, reused: false };
        }
    }
    // Parallel sockets must not inherit sibling turnState or the Codex server
    // treats the new request as a continuation of another in-flight turn and
    // returns "No tool output found for function call …". turnState only
    // propagates within a single entry across its own iterations.
    const { socket, turnState } = await _openSocket({ auth, cacheKey, turnState: null });
    const entry = {
        socket,
        busy: true,
        idleTimer: null,
        lastResponseId: null,
        lastRequestSansInput: null,
        lastInputLen: 0,
        turnState: turnState || null,
        closing: false,
        ephemeral: false,
    };
    if (poolKey && !forceFresh) _getPoolArr(poolKey).push(entry);
    socket.on('close', () => {
        entry.closing = true;
        _removeFromPool(poolKey, entry);
    });
    return { entry, reused: false };
}

function releaseWebSocket({ entry, poolKey, keep }) {
    if (!entry) return;
    entry.busy = false;
    if (!keep || !_isOpen(entry) || !poolKey || entry.ephemeral) {
        try { entry.socket.close(1000, keep ? 'no_session' : 'release_no_keep'); } catch {}
        _removeFromPool(poolKey, entry);
        return;
    }
    _scheduleIdleClose(poolKey, entry);
}

// Port of pi-mono get_incremental_items: if the cached request (sans input)
// matches the current one and the current input starts with the cached input,
// return only the tail. Otherwise return the full input (fresh turn).
function _sansInput(body) {
    const { input: _ignored, ...rest } = body;
    return rest;
}

function _stableStringify(obj) {
    // Shallow stable-ish: JSON.stringify with sorted top-level keys. Nested
    // arrays (tools, include) are order-sensitive and reflect intent, so we
    // do not sort them.
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return JSON.stringify(obj);
    const keys = Object.keys(obj).sort();
    const parts = [];
    for (const k of keys) parts.push(JSON.stringify(k) + ':' + _stableStringify(obj[k]));
    return '{' + parts.join(',') + '}';
}

function _computeDelta({ entry, body }) {
    if (!entry || !entry.lastRequestSansInput || !entry.lastResponseId) {
        return { mode: 'full', frame: { type: 'response.create', ...body } };
    }
    const curSans = _stableStringify(_sansInput(body));
    if (curSans !== entry.lastRequestSansInput) {
        return { mode: 'full', frame: { type: 'response.create', ...body } };
    }
    const prevLen = entry.lastInputLen | 0;
    const curInput = Array.isArray(body.input) ? body.input : [];
    if (curInput.length < prevLen) {
        return { mode: 'full', frame: { type: 'response.create', ...body } };
    }
    const tail = curInput.slice(prevLen);
    return {
        mode: 'delta',
        frame: {
            ...body,
            type: 'response.create',
            previous_response_id: entry.lastResponseId,
            input: tail,
        },
    };
}

function _estimateFrameTokens(frame) {
    try {
        const s = JSON.stringify(frame);
        return Math.ceil(s.length / 4);
    } catch { return 0; }
}

function _parseEvent(raw) {
    try { return JSON.parse(raw); } catch { return null; }
}

async function _streamResponse({ entry, externalSignal, onStreamDelta, onToolCall }) {
    const socket = entry.socket;
    let content = '';
    let model = '';
    let responseId = '';
    const toolCalls = [];
    const pendingCalls = new Map();
    let usage;
    let done = false;
    let terminalError = null;
    let idleTimer = null;
    let abortHandler = null;
    let messageHandler = null;
    let closeHandler = null;
    let errorHandler = null;

    return new Promise((resolve, reject) => {
        // Pre-stream watchdog only: the timer fires if the server never sends
        // a first chunk within WS_STREAM_IDLE_MS after our last frame. Once
        // any chunk arrives, we consider the stream live and cancel the
        // timer — silent gaps between chunks (e.g. Codex spending 50s+
        // producing reasoning tokens mid-turn) are normal and should not
        // abort the turn. Truly stuck streams are caught by the external
        // signal (session close / user cancel), not by a heuristic idle.
        const armPreStreamWatchdog = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                terminalError = new Error(`Codex WS stream no first chunk within ${WS_STREAM_IDLE_MS}ms`);
                try { socket.close(4000, 'idle_timeout'); } catch {}
            }, WS_STREAM_IDLE_MS);
        };
        const resetIdle = () => {
            // First chunk disarms the watchdog for the rest of the stream.
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };
        const cleanup = () => {
            if (idleTimer) clearTimeout(idleTimer);
            if (messageHandler) socket.off('message', messageHandler);
            if (closeHandler) socket.off('close', closeHandler);
            if (errorHandler) socket.off('error', errorHandler);
            if (abortHandler && externalSignal) externalSignal.removeEventListener('abort', abortHandler);
        };
        const finish = () => {
            cleanup();
            if (terminalError) { reject(terminalError); return; }
            resolve({
                content,
                model,
                toolCalls: toolCalls.length ? toolCalls : undefined,
                usage,
                responseId: responseId || undefined,
            });
        };

        messageHandler = (data) => {
            resetIdle();
            const text = typeof data === 'string' ? data : data.toString('utf-8');
            const event = _parseEvent(text);
            if (!event || typeof event.type !== 'string') return;
            switch (event.type) {
                case 'response.created':
                    if (event.response?.model) model = event.response.model;
                    if (event.response?.id) responseId = event.response.id;
                    break;
                case 'response.output_text.delta':
                    content += event.delta || '';
                    try { onStreamDelta?.(); } catch {}
                    break;
                case 'response.output_item.added':
                    if (event.item?.type === 'function_call') {
                        pendingCalls.set(event.item.id || '', {
                            name: event.item.name || '',
                            callId: event.item.call_id || '',
                        });
                    }
                    break;
                case 'response.function_call_arguments.delta':
                    try { onStreamDelta?.(); } catch {}
                    break;
                case 'response.function_call_arguments.done': {
                    const itemId = event.item_id || '';
                    const pending = pendingCalls.get(itemId);
                    let args = {};
                    try { args = JSON.parse(event.arguments || '{}'); } catch {}
                    const call = {
                        id: pending?.callId || `tc_${Date.now()}_${toolCalls.length}`,
                        name: pending?.name || '',
                        arguments: args,
                    };
                    toolCalls.push(call);
                    try { onToolCall?.(call); } catch {}
                    try { onStreamDelta?.(); } catch {}
                    break;
                }
                case 'response.output_item.done':
                    // already captured via function_call_arguments.done /
                    // output_text.delta; nothing extra needed.
                    break;
                case 'response.completed': {
                    if (event.response?.usage) {
                        const u = event.response.usage;
                        usage = {
                            inputTokens: u.input_tokens || 0,
                            outputTokens: u.output_tokens || 0,
                            cachedTokens: extractCachedTokens(u),
                            // OpenAI Codex reports input_tokens as the total
                            // prompt volume (cached portion is a subset, not
                            // additive). Alias into the cross-provider
                            // `promptTokens` field so downstream loggers have
                            // uniform semantics.
                            promptTokens: u.input_tokens || 0,
                            raw: u,
                        };
                    }
                    if (!model && event.response?.model) model = event.response.model;
                    if (!responseId && event.response?.id) responseId = event.response.id;
                    if (!content && event.response?.output) {
                        for (const item of event.response.output) {
                            if (item.type === 'message') {
                                for (const c of item.content || []) {
                                    if (c.type === 'output_text') content += c.text || '';
                                }
                            }
                        }
                    }
                    done = true;
                    finish();
                    break;
                }
                case 'response.done':
                case 'response.incomplete':
                    done = true;
                    finish();
                    break;
                case 'error':
                    terminalError = new Error(`Codex WS error: ${event.message || event.error?.message || 'unknown'}`);
                    finish();
                    break;
                default:
                    // Trace-only events (response.in_progress, reasoning.*, etc.)
                    break;
            }
        };
        closeHandler = (code, reason) => {
            if (done) return;
            if (!terminalError) {
                const r = reason?.toString?.('utf-8') || '';
                terminalError = new Error(`Codex WS closed before response.completed (code=${code}${r ? `, reason=${r}` : ''})`);
            }
            finish();
        };
        errorHandler = (err) => {
            if (done) return;
            terminalError = err instanceof Error ? err : new Error(String(err));
            try { socket.close(4001, 'stream_error'); } catch {}
            finish();
        };
        if (externalSignal) {
            abortHandler = () => {
                if (done) return;
                const reason = externalSignal.reason;
                terminalError = reason instanceof Error ? reason : new Error('Codex WS aborted by session close');
                try { socket.close(4002, 'aborted'); } catch {}
                finish();
            };
            if (externalSignal.aborted) { abortHandler(); return; }
            externalSignal.addEventListener('abort', abortHandler, { once: true });
        }
        socket.on('message', messageHandler);
        socket.on('close', closeHandler);
        socket.on('error', errorHandler);
        armPreStreamWatchdog();
    });
}

/**
 * Dispatch one tool-loop iteration over a per-session cached WebSocket.
 * Returns the same shape as the SSE path: { content, model, toolCalls, usage }.
 */
export async function sendViaWebSocket({
    auth,
    body,
    sendOpts,
    onStreamDelta,
    onToolCall,
    onStageChange,
    externalSignal,
    poolKey,
    cacheKey,
    iteration,
    useModel,
    displayModel,
}) {
    const handshakeStart = Date.now();
    let acquired;
    try { onStageChange?.('requesting'); } catch {}
    try {
        acquired = await acquireWebSocket({ auth, poolKey, cacheKey });
    } catch (err) {
        if (err?.httpStatus) {
            traceBridgeFetch({
                sessionId: poolKey,
                headersMs: Date.now() - handshakeStart,
                httpStatus: err.httpStatus,
            });
        }
        throw err;
    }
    const { entry, reused } = acquired;
    traceBridgeFetch({
        sessionId: poolKey,
        headersMs: Date.now() - handshakeStart,
        httpStatus: reused ? 0 : 101,
    });

    const { mode, frame } = _computeDelta({ entry, body });
    const deltaTokens = _estimateFrameTokens(frame);

    try {
        entry.socket.send(JSON.stringify(frame));
    } catch (err) {
        releaseWebSocket({ entry, poolKey, keep: false });
        throw err instanceof Error ? err : new Error(String(err));
    }

    try { onStageChange?.('streaming'); } catch {}
    const sseStart = Date.now();
    let result;
    try {
        result = await _streamResponse({ entry, externalSignal, onStreamDelta, onToolCall });
    } catch (err) {
        releaseWebSocket({ entry, poolKey, keep: false });
        throw err;
    }
    traceBridgeSse({ sessionId: poolKey, sseParseMs: Date.now() - sseStart });

    // Update cache state for the next iteration in this session.
    if (result.responseId) {
        entry.lastResponseId = result.responseId;
        entry.lastRequestSansInput = _stableStringify(_sansInput(body));
        entry.lastInputLen = Array.isArray(body.input) ? body.input.length : 0;
    }

    const liveModel = result.model || useModel;
    traceBridgeUsage({
        sessionId: poolKey,
        iteration,
        inputTokens: result.usage?.inputTokens || 0,
        outputTokens: result.usage?.outputTokens || 0,
        cachedTokens: result.usage?.cachedTokens || 0,
        promptTokens: result.usage?.promptTokens || 0,
        model: liveModel,
        modelDisplay: displayModel ? displayModel(liveModel) : liveModel,
        responseId: result.responseId || null,
        rawUsage: result.usage?.raw || null,
        provider: 'openai-oauth',
    });
    // Extra WS-specific observability: transport + per-iteration delta bytes.
    try {
        appendBridgeTrace({
            sessionId: poolKey,
            iteration,
            kind: 'transport',
            transport: 'websocket',
            ws_mode: mode,
            iteration_delta_tokens: deltaTokens,
            reused_connection: reused,
        });
    } catch {}

    releaseWebSocket({ entry, poolKey, keep: true });
    const { responseId: _ignored, ...out } = result;
    return out;
}

// Test/debug surface — lets callers force-close all pooled sockets (e.g. on
// plugin unload). Not part of the send path.
export function _closeAllPooledSockets(reason = 'shutdown') {
    for (const arr of _wsPool.values()) {
        for (const entry of arr) {
            try { entry.socket.close(1000, reason); } catch {}
        }
    }
    _wsPool.clear();
}
