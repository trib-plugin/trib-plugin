import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getPluginData } from './config.mjs';
import { normalizeUsage } from './smart-bridge/cache-obs.mjs';

const HISTORY_DIR = join(getPluginData(), 'history');
const TRACE_PATH = join(HISTORY_DIR, 'bridge-trace.jsonl');
const WARNED_KEYS = new Set();

function normalizeSessionId(sessionId) {
    return sessionId ? String(sessionId) : 'no-session';
}

function appendBridgeTrace(record = {}) {
    try {
        mkdirSync(HISTORY_DIR, { recursive: true });
        const row = {
            ts: record.ts || new Date().toISOString(),
            ...record,
            sessionId: normalizeSessionId(record.sessionId),
        };
        appendFileSync(TRACE_PATH, `${JSON.stringify(row)}\n`, 'utf8');
    }
    catch {
        // Never break bridge execution for telemetry.
    }
}

function estimateProviderPayloadBytes(messages, model, tools) {
    try {
        return Buffer.byteLength(JSON.stringify({ model, messages, tools: tools || [] }), 'utf8');
    }
    catch {
        return null;
    }
}

function extractCachedTokens(usage) {
    const candidates = [
        usage?.input_tokens_details?.cached_tokens,
        usage?.prompt_tokens_details?.cached_tokens,
        usage?.inputTokensDetails?.cachedTokens,
        usage?.promptTokensDetails?.cachedTokens,
    ];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return 0;
}

function warnBridgeOnce(key, message) {
    if (!key || WARNED_KEYS.has(key)) return;
    WARNED_KEYS.add(key);
    try {
        process.stderr.write(`${message}\n`);
    }
    catch {
        // Ignore logging failures.
    }
}

function traceBridgeLoop({ sessionId, iteration, sendMs, messageCount, bodyBytesEst }) {
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'loop',
        send_ms: sendMs,
        message_count: messageCount,
        body_bytes_est: bodyBytesEst,
    });
}

function traceBridgeTool({ sessionId, iteration, toolName, toolKind, toolMs }) {
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'tool',
        tool_name: toolName,
        tool_kind: toolKind,
        tool_ms: toolMs,
    });
}

function traceBridgeFetch({ sessionId, headersMs, httpStatus }) {
    appendBridgeTrace({
        sessionId,
        kind: 'fetch',
        headers_ms: headersMs,
        http_status: httpStatus,
    });
}

function traceBridgeSse({ sessionId, sseParseMs }) {
    appendBridgeTrace({
        sessionId,
        kind: 'sse',
        sse_parse_ms: sseParseMs,
    });
}

function traceBridgeUsage({ sessionId, iteration, inputTokens, outputTokens, cachedTokens, cacheWriteTokens, model, responseId, rawUsage, provider }) {
    // Phase H: attach normalized cache observation when provider info is available
    let normalized = undefined;
    if (rawUsage && provider) {
        try {
            normalized = normalizeUsage(provider, rawUsage);
        } catch {
            // cache-obs normalization failed — skip, keep rawUsage intact
        }
    } else if (rawUsage && !provider) {
        warnBridgeOnce(
            'bridge-trace:missing-provider',
            `[bridge-trace] rawUsage present but no provider field — skipping normalizeUsage. Provider should pass {provider: '...'} to traceBridgeUsage.`,
        );
    }
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'usage',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: cachedTokens,
        cache_write_tokens: cacheWriteTokens || 0,
        model: model || null,
        response_id: responseId || null,
        raw_usage: rawUsage || null,
        normalized,
    });
}

function estimateGeminiTokens(contents = []) {
    try {
        let chars = 0;
        for (const item of contents) {
            chars += JSON.stringify(item).length;
        }
        return Math.ceil(chars / 4);
    }
    catch {
        return 0;
    }
}

export {
    appendBridgeTrace,
    estimateGeminiTokens,
    estimateProviderPayloadBytes,
    extractCachedTokens,
    traceBridgeFetch,
    traceBridgeLoop,
    traceBridgeSse,
    traceBridgeTool,
    traceBridgeUsage,
    warnBridgeOnce,
};
