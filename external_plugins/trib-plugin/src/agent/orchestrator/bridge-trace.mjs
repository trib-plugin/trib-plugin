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
    // Test isolation — when run-all-tests.mjs sets this env, fixture
    // sessionIds (s1..s7, m1..m3) and other test-driven trace events
    // would otherwise pollute the production bridge-trace.jsonl, skewing
    // post-hoc stall / loop analysis. Skip the write entirely.
    if (process.env.TRIB_BRIDGE_TRACE_DISABLE === '1') return;
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

function traceToolLoopDetected({ sessionId, iteration, info }) {
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'tool_loop_detected',
        signature: info.signature,
        tool_name: info.toolName,
        error_category: info.errorCategory,
        attempt_count: info.attemptCount,
        args_sample: info.argsSample,
        error_sample: info.errorSample,
    });
}

function traceToolLoopAborted({ sessionId, iteration, info }) {
    appendBridgeTrace({
        sessionId,
        iteration,
        kind: 'tool_loop_aborted',
        signature: info.signature,
        tool_name: info.toolName,
        error_category: info.errorCategory,
        attempt_count: info.attemptCount,
        args_sample: info.argsSample,
        error_sample: info.errorSample,
    });
}

function traceStreamStalled({ sessionId, info }) {
    appendBridgeTrace({
        sessionId,
        kind: 'stream_stalled',
        stale_seconds: info.staleSeconds,
        last_tool_call: info.lastToolCall,
        stage: info.stage,
    });
}

function traceStreamAborted({ sessionId, info }) {
    appendBridgeTrace({
        sessionId,
        kind: 'stream_aborted',
        stale_seconds: info.staleSeconds,
        last_tool_call: info.lastToolCall,
        stage: info.stage,
    });
}

function traceBridgePreset({ sessionId, role, presetName, model, provider }) {
    // Fires once per dispatch right after the preset has been resolved and
    // its runtime spec (provider/model) assembled. Useful for after-the-fact
    // routing analysis: "which role landed on which preset / provider / model
    // on this request?"
    appendBridgeTrace({
        sessionId,
        kind: 'preset_assign',
        role: role || null,
        preset_name: presetName || null,
        model: model || null,
        provider: provider || null,
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

function traceBridgeUsage({ sessionId, iteration, inputTokens, outputTokens, cachedTokens, cacheWriteTokens, promptTokens, model, modelDisplay, responseId, rawUsage, provider }) {
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
        kind: 'usage_raw',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: cachedTokens,
        cache_write_tokens: cacheWriteTokens || 0,
        // Unified total-prompt field. Anthropic = input+cache_read+cache_write,
        // OpenAI/Gemini = input_tokens (cached is already a subset).
        prompt_tokens: typeof promptTokens === 'number'
            ? promptTokens
            : ((inputTokens || 0) + (cachedTokens || 0) + (cacheWriteTokens || 0)),
        model: model || null,
        model_display: modelDisplay || null,
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
    traceBridgePreset,
    traceBridgeSse,
    traceBridgeTool,
    traceBridgeUsage,
    traceStreamAborted,
    traceStreamStalled,
    traceToolLoopAborted,
    traceToolLoopDetected,
    warnBridgeOnce,
};
