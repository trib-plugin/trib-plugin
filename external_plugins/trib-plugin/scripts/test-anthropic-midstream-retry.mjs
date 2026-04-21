/**
 * Tests for Anthropic OAuth mid-stream retry.
 *
 * Scope:
 * - classifier only retries after message_start and before message_stop
 * - user aborts are never retried
 * - once a tool call was surfaced, retry is disabled to avoid duplicate eager dispatch
 * - one retry is attempted on retryable mid-stream failures
 * - exhausted retries surface the first-attempt error with retry metadata
 */

import { AnthropicOAuthProvider, _classifyMidstreamError } from '../src/agent/orchestrator/providers/anthropic-oauth.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
    if (cond) passed++;
    else {
        failed++;
        console.error(`FAIL: ${msg}`);
    }
}

function captureStderr() {
    const lines = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
    return {
        lines,
        restore() { process.stderr.write = orig; },
    };
}

function mkBridgeStallErr() {
    const err = new Error('bridge stall watchdog: 600s');
    err.name = 'BridgeStallAbortError';
    return err;
}

function mkTimeoutErr() {
    const err = new Error('Anthropic OAuth SSE stream timed out after 300000ms of inactivity');
    err.code = 'ETIMEDOUT';
    return err;
}

{
    const c = _classifyMidstreamError(mkBridgeStallErr(), {
        attemptIndex: 0,
        sawMessageStart: true,
        sawCompleted: false,
        emittedToolCall: false,
        userAbort: false,
        watchdogAbort: null,
    });
    assert(c === 'bridge_stall', `bridge stall should retry (got ${c})`);
}

{
    const c = _classifyMidstreamError(new Error('aborted'), {
        attemptIndex: 0,
        sawMessageStart: true,
        sawCompleted: false,
        emittedToolCall: false,
        userAbort: true,
        watchdogAbort: null,
    });
    assert(c === null, `user abort should not retry (got ${c})`);
}

{
    const c = _classifyMidstreamError(mkBridgeStallErr(), {
        attemptIndex: 0,
        sawMessageStart: true,
        sawCompleted: false,
        emittedToolCall: true,
        userAbort: false,
        watchdogAbort: null,
    });
    assert(c === null, `tool-call-emitted path should not retry (got ${c})`);
}

{
    const cap = captureStderr();
    try {
        const provider = new AnthropicOAuthProvider({});
        provider.credentials = { accessToken: 'test', expiresAt: Date.now() + 3_600_000 };
        let requestCalls = 0;
        let parseCalls = 0;
        const result = await provider.send(
            [{ role: 'user', content: 'hello' }],
            'claude-haiku-4-5-20251001',
            [],
            {
                _doRequestFn: async () => {
                    requestCalls++;
                    return {
                        response: { ok: true, status: 200 },
                        controller: new AbortController(),
                        cancelHandler: null,
                    };
                },
                _parseSSEFn: async (_response, _signal, _abortStream, _onStreamDelta, _onToolCall, state) => {
                    parseCalls++;
                    state.sawMessageStart = true;
                    if (parseCalls === 1) throw mkBridgeStallErr();
                    state.sawCompleted = true;
                    return {
                        content: 'recovered',
                        usage: { inputTokens: 10, outputTokens: 3, cachedTokens: 0, cacheWriteTokens: 0, promptTokens: 10, raw: null },
                    };
                },
            },
        );
        assert(result.content === 'recovered', `happy retry should return second result (got ${result.content})`);
        assert(result.__midstreamRetries === 1, `happy retry should record one retry (got ${result.__midstreamRetries})`);
        assert(requestCalls === 2, `happy retry should request twice (got ${requestCalls})`);
        assert(parseCalls === 2, `happy retry should parse twice (got ${parseCalls})`);
        const progress = cap.lines.filter((line) => line.includes('mid-stream recovered'));
        assert(progress.length === 1, `happy retry should emit one progress line (got ${progress.length})`);
    } finally {
        cap.restore();
    }
}

{
    const cap = captureStderr();
    try {
        const provider = new AnthropicOAuthProvider({});
        provider.credentials = { accessToken: 'test', expiresAt: Date.now() + 3_600_000 };
        let parseCalls = 0;
        let thrown = null;
        try {
            await provider.send(
                [{ role: 'user', content: 'hello' }],
                'claude-haiku-4-5-20251001',
                [],
                {
                    _doRequestFn: async () => ({
                        response: { ok: true, status: 200 },
                        controller: new AbortController(),
                        cancelHandler: null,
                    }),
                    _parseSSEFn: async (_response, _signal, _abortStream, _onStreamDelta, _onToolCall, state) => {
                        parseCalls++;
                        state.sawMessageStart = true;
                        throw parseCalls === 1 ? mkBridgeStallErr() : mkTimeoutErr();
                    },
                },
            );
        } catch (err) {
            thrown = err;
        }
        assert(!!thrown, 'exhausted retry path should throw');
        assert(thrown?.name === 'BridgeStallAbortError', `exhausted retry should surface first error (got ${thrown?.name})`);
        assert(thrown?.midstreamRetries === 1, `exhausted retry should record one retry (got ${thrown?.midstreamRetries})`);
        assert(thrown?.midstreamClassifier === 'bridge_stall', `exhausted retry should preserve first classifier (got ${thrown?.midstreamClassifier})`);
    } finally {
        cap.restore();
    }
}

if (failed > 0) {
    console.error(`test-anthropic-midstream-retry: ${passed} passed, ${failed} failed`);
    process.exit(1);
}

console.log(`test-anthropic-midstream-retry: ${passed} passed`);
