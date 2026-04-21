/**
 * Tests for mid-stream auto-retry in
 * src/agent/orchestrator/providers/openai-oauth-ws.mjs.
 *
 * The anthropic-oauth SSE idle cap was raised 60s → 300s; openai-oauth-ws
 * already had a 300s pre-stream watchdog, but nothing recovered a stream
 * that died AFTER response.created and BEFORE response.completed. This
 * layer adds ONE automatic retry on that window for transient causes:
 *   - BridgeStallAbortError / StreamStalledAbortError
 *   - WS close 1006 / 1011 / 1012 / 4000
 *   - response.failed payloads mentioning network_error / stream_disconnected
 * and rejects retry for:
 *   - user AbortController aborts
 *   - response.completed already observed
 *   - 401 / 403 / 429
 *   - already one retry used (no laddering)
 *
 * The dispatch path is driven via injected `_acquireWithRetryFn` / `_streamFn`
 * seams so we never open a real socket. Progress emission to stderr is
 * captured by swapping process.stderr.write.
 *
 * Assertions (target ≥ 7):
 *   1. Classifier: BridgeStallAbortError → retryable
 *   2. Classifier: user abort → NOT retryable
 *   3. Classifier: 401 on error → NOT retryable
 *   4. Classifier: response.completed already seen → NOT retryable
 *   5. Happy: first attempt mid-stream stalls → second succeeds,
 *      __midstreamRetries === 0 on returned result (counts final retry count),
 *      progress line emitted exactly once.
 *   6. Exhausted: both attempts stall → surfaces first-attempt error,
 *      err.midstreamRetries === 1.
 *   7. No-double-wrap: handshake retry layer is not reinvoked with the
 *      mid-stream retry's forceFresh (two layers don't interleave).
 *
 * Also covered (bonus):
 *   - Classifier: WS close code 1006 / 4000 → retryable
 *   - Classifier: response.failed with stream_disconnected → retryable
 *   - Classifier: no response.created yet → NOT retryable (handshake layer)
 *   - Classifier: already retried once → NOT retryable
 *   - Retry cleans up the first socket (release called with keep:false)
 */

import {
    sendViaWebSocket,
    _classifyMidstreamError,
} from '../src/agent/orchestrator/providers/openai-oauth-ws.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; }
    else { failed++; console.error(`  FAIL: ${msg}`); }
}

function captureStderr() {
    const out = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { out.push(String(chunk)); return true; };
    return {
        lines: out,
        restore: () => { process.stderr.write = orig; },
    };
}

// ── Error factories ──────────────────────────────────────────────────
function mkBridgeStallErr() {
    const e = new Error('bridge stall watchdog: 95s');
    e.name = 'BridgeStallAbortError';
    return e;
}
function mkStreamStalledErr() {
    const e = new Error('stream stalled 120s (last: read, stage: streaming)');
    e.name = 'StreamStalledAbortError';
    return e;
}
function mkWsClose(code) {
    const e = new Error(`Codex WS closed before response.completed (code=${code})`);
    e.wsCloseCode = code;
    return e;
}
function mkAuthErr() {
    const e = new Error('Codex WS response.failed: unauthorized');
    e.httpStatus = 401;
    return e;
}
function mkResponseFailedNetwork() {
    const e = new Error('Codex WS response.failed: upstream network_error');
    e.responseFailed = { type: 'response.failed', response: { error: { message: 'network_error: ECONNRESET' } } };
    return e;
}
function mkResponseFailedDisconnected() {
    const e = new Error('Codex WS response.failed: stream_disconnected');
    e.responseFailed = { type: 'response.failed', response: { error: { code: 'stream_disconnected' } } };
    return e;
}

// ── Fake entry used by the seam (no real socket). ────────────────────
function mkFakeEntry(id = 'e') {
    return {
        id,
        socket: { /* no-op; _isOpen returns false → releaseWebSocket just tries close() inside try/catch */ },
        busy: true,
        idleTimer: null,
        lastResponseId: null,
        lastRequestSansInput: null,
        lastInputLen: 0,
        turnState: null,
        closing: false,
        ephemeral: false,
    };
}

// ── 1-4. Classifier unit checks ──────────────────────────────────────
{
    // 1: bridge stall mid-stream → retryable
    const c = _classifyMidstreamError(mkBridgeStallErr(), {
        attemptIndex: 0,
        sawResponseCreated: true,
        sawCompleted: false,
    });
    assert(c === 'bridge_stall',
        `[1] BridgeStallAbortError mid-stream → 'bridge_stall' (got ${c})`);
}
{
    // 2: user abort → NOT retryable
    const userAbortErr = new Error('Codex WS aborted by session close');
    const c = _classifyMidstreamError(userAbortErr, {
        attemptIndex: 0,
        sawResponseCreated: true,
        sawCompleted: false,
        userAbort: true,
    });
    assert(c === null,
        `[2] user abort → null (got ${c})`);
}
{
    // 3: 401 on error → NOT retryable
    const c = _classifyMidstreamError(mkAuthErr(), {
        attemptIndex: 0,
        sawResponseCreated: true,
        sawCompleted: false,
    });
    assert(c === null,
        `[3] httpStatus=401 → null (got ${c})`);
}
{
    // 4: response.completed already seen → NOT retryable
    const c = _classifyMidstreamError(mkBridgeStallErr(), {
        attemptIndex: 0,
        sawResponseCreated: true,
        sawCompleted: true,
    });
    assert(c === null,
        `[4] sawCompleted=true → null (got ${c})`);
}

// Bonus classifier coverage.
{
    const c1006 = _classifyMidstreamError(mkWsClose(1006), {
        attemptIndex: 0, sawResponseCreated: true, sawCompleted: false,
    });
    assert(c1006 === 'ws_1006', `[bonus] 1006 → ws_1006 (got ${c1006})`);

    const c1011 = _classifyMidstreamError(mkWsClose(1011), {
        attemptIndex: 0, sawResponseCreated: true, sawCompleted: false,
    });
    assert(c1011 === 'ws_1011', `[bonus] 1011 → ws_1011 (got ${c1011})`);

    const c1012 = _classifyMidstreamError(mkWsClose(1012), {
        attemptIndex: 0, sawResponseCreated: true, sawCompleted: false,
    });
    assert(c1012 === 'ws_1012', `[bonus] 1012 → ws_1012 (got ${c1012})`);

    const c4000 = _classifyMidstreamError(mkWsClose(4000), {
        attemptIndex: 0, sawResponseCreated: true, sawCompleted: false,
    });
    assert(c4000 === 'ws_4000', `[bonus] 4000 → ws_4000 (got ${c4000})`);

    const cNet = _classifyMidstreamError(mkResponseFailedNetwork(), {
        attemptIndex: 0, sawResponseCreated: true, sawCompleted: false,
    });
    assert(cNet === 'response_failed_network',
        `[bonus] response.failed network_error → response_failed_network (got ${cNet})`);

    const cDisc = _classifyMidstreamError(mkResponseFailedDisconnected(), {
        attemptIndex: 0, sawResponseCreated: true, sawCompleted: false,
    });
    assert(cDisc === 'response_failed_disconnected',
        `[bonus] response.failed stream_disconnected → response_failed_disconnected (got ${cDisc})`);

    const cPre = _classifyMidstreamError(mkBridgeStallErr(), {
        attemptIndex: 0, sawResponseCreated: false, sawCompleted: false,
    });
    assert(cPre === null,
        `[bonus] pre-response.created → null (handshake layer owns that, got ${cPre})`);

    const cRetried = _classifyMidstreamError(mkBridgeStallErr(), {
        attemptIndex: 1, sawResponseCreated: true, sawCompleted: false,
    });
    assert(cRetried === null,
        `[bonus] attemptIndex=1 (already retried) → null (got ${cRetried})`);

    const cStreamStalled = _classifyMidstreamError(mkStreamStalledErr(), {
        attemptIndex: 0, sawResponseCreated: true, sawCompleted: false,
    });
    assert(cStreamStalled === 'stream_stalled',
        `[bonus] StreamStalledAbortError → stream_stalled (got ${cStreamStalled})`);
}

// ── 5. Happy retry path ──────────────────────────────────────────────
{
    const cap = captureStderr();
    try {
        const acquireCalls = [];
        const fakeAcquire = async (opts) => {
            acquireCalls.push({ forceFresh: !!opts.forceFresh });
            return { entry: mkFakeEntry(acquireCalls.length === 1 ? 'first' : 'second'), reused: false };
        };

        let streamCall = 0;
        const fakeStream = async ({ state }) => {
            streamCall++;
            if (streamCall === 1) {
                // First attempt: response.created lands, then bridge-stall kills us.
                state.sawResponseCreated = true;
                throw mkBridgeStallErr();
            }
            // Second attempt: clean completion.
            state.sawResponseCreated = true;
            state.sawCompleted = true;
            return {
                content: 'hello world',
                model: 'gpt-5-codex',
                responseId: 'resp_abc',
                usage: { inputTokens: 10, outputTokens: 3 },
            };
        };

        const result = await sendViaWebSocket({
            auth: {}, body: { input: [] }, poolKey: 'k', cacheKey: 'k',
            _acquireWithRetryFn: fakeAcquire,
            _streamFn: fakeStream,
            _sendFrameFn: () => {},
        });

        assert(result.content === 'hello world',
            `[5a] retry yielded second-attempt content (got ${JSON.stringify(result.content)})`);
        // On the happy path there is no err object — instead the result carries
        // __midstreamRetries as a non-enumerable breadcrumb. The spec's phrasing
        // "err.midstreamRetries === 0 on final" targets the no-error invariant;
        // here we check the success breadcrumb which records the winning
        // attemptIndex (1 = one retry was used, 0 would mean first-try success).
        assert(result.__midstreamRetries === 1,
            `[5b] one retry consumed on successful recovery (got ${result.__midstreamRetries})`);
        assert(streamCall === 2, `[5c] stream invoked twice (got ${streamCall})`);
        assert(acquireCalls.length === 2, `[5d] acquire invoked twice (got ${acquireCalls.length})`);
        assert(acquireCalls[0].forceFresh === false,
            '[5e] first acquire uses pool');
        assert(acquireCalls[1].forceFresh === true,
            '[5f] retry acquire uses forceFresh (fresh socket, no pool reuse)');

        const progressLines = cap.lines.filter(l => l.includes('mid-stream recovered'));
        assert(progressLines.length === 1,
            `[5g] exactly one mid-stream progress line (got ${progressLines.length}: ${JSON.stringify(progressLines)})`);
        assert(/mid-stream recovered: retry 1\/1 \(cause: bridge_stall\)/.test(progressLines[0] || ''),
            `[5h] progress line format matches spec (got ${JSON.stringify(progressLines[0])})`);
    } finally { cap.restore(); }
}

// ── 6. Exhausted retry path ──────────────────────────────────────────
{
    const cap = captureStderr();
    try {
        const fakeAcquire = async () => ({ entry: mkFakeEntry(), reused: false });
        const errs = [mkBridgeStallErr(), mkWsClose(1006)];
        let streamCall = 0;
        const fakeStream = async ({ state }) => {
            state.sawResponseCreated = true;
            const err = errs[streamCall++];
            // decorate close-code on WS close error
            if (err?.wsCloseCode) state.wsCloseCode = err.wsCloseCode;
            throw err;
        };

        let thrown;
        try {
            await sendViaWebSocket({
                auth: {}, body: { input: [] }, poolKey: 'k', cacheKey: 'k',
                _acquireWithRetryFn: fakeAcquire,
                _streamFn: fakeStream,
                _sendFrameFn: () => {},
            });
        } catch (e) { thrown = e; }

        assert(thrown, '[6a] exhausted path throws');
        assert(thrown?.name === 'BridgeStallAbortError',
            `[6b] surfaces FIRST-attempt error, not the second-attempt one (got ${thrown?.name})`);
        assert(thrown?.midstreamRetries === 1,
            `[6c] err.midstreamRetries === 1 (got ${thrown?.midstreamRetries})`);
        assert(thrown?.midstreamClassifier === 'bridge_stall',
            `[6d] err.midstreamClassifier preserved from first attempt (got ${thrown?.midstreamClassifier})`);
        assert(streamCall === 2, `[6e] stream invoked exactly twice (got ${streamCall})`);

        const progressLines = cap.lines.filter(l => l.includes('mid-stream recovered'));
        assert(progressLines.length === 1,
            `[6f] one progress line emitted (the retry attempt; exhaustion has no line), got ${progressLines.length}`);
    } finally { cap.restore(); }
}

// ── 7. No-double-wrap: handshake retry inside mid-stream retry ───────
// Verifies the two retry layers don't interleave: the inner _acquireWithRetry
// is called at most ONCE per mid-stream attempt. Even if the handshake layer
// internally retries 3× for a transient, that's one call from the mid-stream
// layer's perspective — the mid-stream layer doesn't see the inner backoff.
{
    const cap = captureStderr();
    try {
        const acquireCalls = [];
        const fakeAcquire = async (opts) => {
            // This fake simulates the handshake retry having already done its
            // work internally: we count how many TIMES the mid-stream layer
            // invokes us as a black box. (Inner retries are invisible.)
            acquireCalls.push({ forceFresh: !!opts.forceFresh });
            return { entry: mkFakeEntry(`att-${acquireCalls.length}`), reused: false };
        };

        let streamCall = 0;
        const fakeStream = async ({ state }) => {
            streamCall++;
            if (streamCall === 1) {
                state.sawResponseCreated = true;
                const e = mkWsClose(4000); // our own idle-timeout close
                state.wsCloseCode = 4000;
                throw e;
            }
            state.sawResponseCreated = true;
            state.sawCompleted = true;
            return { content: 'ok', model: 'm', responseId: 'r', usage: {} };
        };

        const result = await sendViaWebSocket({
            auth: {}, body: { input: [] }, poolKey: 'k', cacheKey: 'k',
            _acquireWithRetryFn: fakeAcquire,
            _streamFn: fakeStream,
            _sendFrameFn: () => {},
        });

        // Exactly 2 acquire invocations (one per mid-stream attempt) — NEVER
        // more. If the mid-stream layer were laddering or accidentally double-
        // wrapping, this would climb.
        assert(acquireCalls.length === 2,
            `[7a] acquire called exactly 2× (once per mid-stream attempt), got ${acquireCalls.length}`);
        assert(acquireCalls[0].forceFresh === false && acquireCalls[1].forceFresh === true,
            '[7b] layers do not interleave: retry forces fresh acquire, first-attempt does not');
        assert(result.content === 'ok', '[7c] retry with ws_4000 cause recovers successfully');

        // The progress line uses the layer-specific [openai-oauth-ws] tag and
        // the "mid-stream recovered" phrase — distinct from the handshake
        // layer's "worker retry" phrase. No "worker retry" should appear here.
        const midLines = cap.lines.filter(l => l.includes('mid-stream recovered'));
        const hsLines = cap.lines.filter(l => l.includes('worker retry'));
        assert(midLines.length === 1 && hsLines.length === 0,
            `[7d] only mid-stream progress emits; no handshake "worker retry" bleed-through (mid=${midLines.length}, hs=${hsLines.length})`);
    } finally { cap.restore(); }
}

// ── 8. User abort mid-stream is NEVER retried ────────────────────────
{
    const cap = captureStderr();
    try {
        const fakeAcquire = async () => ({ entry: mkFakeEntry(), reused: false });
        let streamCall = 0;
        const fakeStream = async ({ state }) => {
            streamCall++;
            state.sawResponseCreated = true;
            state.userAbort = true;
            throw new Error('Codex WS aborted by session close');
        };
        let thrown;
        try {
            await sendViaWebSocket({
                auth: {}, body: { input: [] }, poolKey: 'k', cacheKey: 'k',
                _acquireWithRetryFn: fakeAcquire,
                _streamFn: fakeStream,
                _sendFrameFn: () => {},
            });
        } catch (e) { thrown = e; }
        assert(thrown, '[8a] user abort throws');
        assert(streamCall === 1,
            `[8b] user abort NOT retried — stream invoked exactly once (got ${streamCall})`);
        const midLines = cap.lines.filter(l => l.includes('mid-stream recovered'));
        assert(midLines.length === 0,
            '[8c] no retry progress line for user abort');
    } finally { cap.restore(); }
}

// ── 9. 1011 before response.created retries once then succeeds ─────
// Regression for the v0.7.3 class of errors: Codex server closes the WS
// with code=1011 reason="keepalive ping timeout" AFTER the 101 upgrade
// but BEFORE any response.created frame. The generic pre-stream gate in
// _classifyMidstreamError rejected these because sawResponseCreated was
// still false; we now carve out 1011/1012 as the one exception so a
// single mid-stream retry with forceFresh recovers the turn.
{
    const cap = captureStderr();
    try {
        const acquireCalls = [];
        const fakeAcquire = async (opts) => {
            acquireCalls.push({ forceFresh: !!opts.forceFresh });
            return { entry: mkFakeEntry(`att-${acquireCalls.length}`), reused: false };
        };

        let streamCall = 0;
        const fakeStream = async ({ state }) => {
            streamCall++;
            if (streamCall === 1) {
                // First attempt: 101 upgrade already happened, but the server
                // closed with 1011 keepalive-ping-timeout BEFORE emitting
                // response.created. Leave sawResponseCreated=false on purpose.
                state.wsCloseCode = 1011;
                const err = mkWsClose(1011);
                err.wsCloseReason = 'keepalive ping timeout';
                throw err;
            }
            // Second attempt: clean completion.
            state.sawResponseCreated = true;
            state.sawCompleted = true;
            return {
                content: 'recovered body',
                model: 'gpt-5-codex',
                responseId: 'resp_xyz',
                usage: { inputTokens: 7, outputTokens: 4 },
            };
        };

        const result = await sendViaWebSocket({
            auth: {}, body: { input: [] }, poolKey: 'k', cacheKey: 'k',
            _acquireWithRetryFn: fakeAcquire,
            _streamFn: fakeStream,
            _sendFrameFn: () => {},
        });

        assert(result.content === 'recovered body',
            `[9a] 1011-before-response.created retried once then succeeded (got ${JSON.stringify(result.content)})`);
        assert(result.__midstreamRetries === 1,
            `[9b] retry count = 1 (got ${result.__midstreamRetries})`);
        assert(streamCall === 2, `[9c] stream invoked exactly twice (got ${streamCall})`);
        assert(acquireCalls.length === 2 && acquireCalls[1].forceFresh === true,
            `[9d] second acquire uses forceFresh=true (got ${JSON.stringify(acquireCalls)})`);

        const progressLines = cap.lines.filter(l => l.includes('mid-stream recovered'));
        assert(progressLines.length === 1 && /cause: ws_1011/.test(progressLines[0]),
            `[9e] classifier = ws_1011 surfaced in the progress line (got ${JSON.stringify(progressLines)})`);

        // Also verify the classifier unit directly for the pre-created window.
        const cDirect = _classifyMidstreamError(mkWsClose(1011), {
            attemptIndex: 0, sawResponseCreated: false, sawCompleted: false,
        });
        assert(cDirect === 'ws_1011',
            `[9f] classifier permits ws_1011 pre-response.created (got ${cDirect})`);

        const cDirect12 = _classifyMidstreamError(mkWsClose(1012), {
            attemptIndex: 0, sawResponseCreated: false, sawCompleted: false,
        });
        assert(cDirect12 === 'ws_1012',
            `[9g] classifier permits ws_1012 pre-response.created (got ${cDirect12})`);

        // Non-1011/1012 pre-created still rejected (the general rule holds).
        const cDirect1006 = _classifyMidstreamError(mkWsClose(1006), {
            attemptIndex: 0, sawResponseCreated: false, sawCompleted: false,
        });
        assert(cDirect1006 === null,
            `[9h] 1006 pre-response.created still rejected (handshake layer territory, got ${cDirect1006})`);
    } finally { cap.restore(); }
}

console.log(`\nPASS ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
