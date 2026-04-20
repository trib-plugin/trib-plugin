/**
 * Tests for the bridge handshake retry layer in
 * src/agent/orchestrator/providers/openai-oauth-ws.mjs.
 *
 * The `ws` package throws `Opening handshake has timed out` after the
 * configured handshakeTimeout; under flaky networks this single-shot failure
 * used to bubble out of sendViaWebSocket and waste the caller's turn. We
 * layered bounded exponential-backoff retry around acquireWebSocket: transient
 * classes (timeout / reset / DNS / 5xx) retry up to 3× with 500/1000/2000 ms
 * backoff, permanent auth/quota (401/403/404/429) short-circuit immediately.
 *
 * These tests drive the retry wrapper directly with a fake `_acquire` so we
 * never open a real socket. Progress emission to stderr is captured by
 * temporarily swapping process.stderr.write.
 *
 * Checks:
 *   1. Success on first attempt → no retry, no progress line.
 *   2. Transient then success → retry count reported on stderr.
 *   3. All retries exhausted → final error surfaces (attempts=3).
 *   4. Permanent 401 → does NOT retry (single attempt, no progress line).
 *   5. Retry count embedded on error object (err.attempts).
 *   6. Classifier correctness (timeout / reset / dns / 5xx / 401 / 429 / unknown).
 *   7. Backoff schedule respects exponential growth (500 → 1000).
 */

import {
    _acquireWithRetry,
    _classifyHandshakeError,
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

function mkTimeoutErr() {
    return new Error('Opening handshake has timed out');
}
function mkResetErr() {
    return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
}
function mkAuthErr() {
    return Object.assign(new Error('Codex WS handshake 401: unauthorized'), { httpStatus: 401 });
}
function mkQuotaErr() {
    return Object.assign(new Error('Codex WS handshake 429: too many'), { httpStatus: 429 });
}
function mk5xxErr() {
    return Object.assign(new Error('Codex WS handshake 503: overloaded'), { httpStatus: 503 });
}

// Fake sleep that just records the delay (never actually sleeps).
function mkSleepRecorder() {
    const delays = [];
    return {
        delays,
        fn: (ms) => { delays.push(ms); return Promise.resolve(); },
    };
}

// Fake acquire that dispenses from a canned outcomes array.
function mkFakeAcquire(outcomes) {
    let i = 0;
    return async () => {
        const step = outcomes[i++];
        if (!step) throw new Error(`fake acquire out of outcomes at call ${i}`);
        if (step.ok) return { entry: { id: step.id || 'entry' }, reused: false };
        throw step.err;
    };
}

// ── 1. classifier correctness ─────────────────────────────────────────────
{
    assert(_classifyHandshakeError(mkTimeoutErr()) === 'timeout',
        'classifier: handshake-timeout message → timeout');
    assert(_classifyHandshakeError(mkResetErr()) === 'reset',
        'classifier: ECONNRESET → reset');
    assert(_classifyHandshakeError(mk5xxErr()) === 'http_503',
        'classifier: 503 → http_503');
    assert(_classifyHandshakeError(mkAuthErr()) === null,
        'classifier: 401 → null (do not retry)');
    assert(_classifyHandshakeError(mkQuotaErr()) === null,
        'classifier: 429 → null (do not retry)');
    assert(_classifyHandshakeError(Object.assign(new Error('x'), { code: 'EAI_AGAIN' })) === 'dns',
        'classifier: EAI_AGAIN → dns');
    assert(_classifyHandshakeError(new Error('some random failure')) === null,
        'classifier: unknown error → null (default-deny)');
    assert(_classifyHandshakeError(null) === null,
        'classifier: null → null');
}

// ── 2. success on first try → no retry, no progress line ──────────────────
{
    const cap = captureStderr();
    const sleep = mkSleepRecorder();
    const retries = [];
    try {
        const r = await _acquireWithRetry({
            auth: {},
            poolKey: 'k',
            cacheKey: 'k',
            onRetry: (info) => retries.push(info),
            _acquire: mkFakeAcquire([{ ok: true, id: 'first' }]),
            _sleepFn: sleep.fn,
        });
        assert(r.entry.id === 'first', 'first-try success returns entry');
        assert(retries.length === 0, 'no onRetry invocations on first-try success');
        assert(sleep.delays.length === 0, 'no backoff sleeps on first-try success');
        const progressLines = cap.lines.filter(l => l.includes('worker retry'));
        assert(progressLines.length === 0,
            `no stderr "worker retry" on first-try success (saw: ${JSON.stringify(progressLines)})`);
    } finally { cap.restore(); }
}

// ── 3. transient failure then success → retry count reported ──────────────
{
    const cap = captureStderr();
    const sleep = mkSleepRecorder();
    const retries = [];
    try {
        const r = await _acquireWithRetry({
            auth: {}, poolKey: 'k', cacheKey: 'k',
            onRetry: (info) => retries.push(info),
            _acquire: mkFakeAcquire([
                { ok: false, err: mkTimeoutErr() },
                { ok: true, id: 'second' },
            ]),
            _sleepFn: sleep.fn,
        });
        assert(r.entry.id === 'second', 'retry returns entry from 2nd attempt');
        assert(retries.length === 1, 'onRetry fired exactly once');
        assert(retries[0].attempt === 1 && retries[0].max === 3,
            `onRetry payload shape (got ${JSON.stringify(retries[0])})`);
        assert(retries[0].classifier === 'timeout',
            `classifier on retry = timeout (got ${retries[0].classifier})`);
        assert(sleep.delays.length === 1 && sleep.delays[0] === 500,
            `first backoff = 500ms (got ${sleep.delays.join(',')})`);
        const progressLines = cap.lines.filter(l => l.includes('worker retry'));
        assert(progressLines.length === 1 && /worker retry 1\/3/.test(progressLines[0]),
            `stderr progress line for retry 1/3 (saw: ${JSON.stringify(progressLines)})`);
        assert(/transient: timeout/.test(progressLines[0] || ''),
            'progress line includes classifier');
    } finally { cap.restore(); }
}

// ── 4. two transient failures then success (attempt=3) ────────────────────
{
    const cap = captureStderr();
    const sleep = mkSleepRecorder();
    const retries = [];
    try {
        const r = await _acquireWithRetry({
            auth: {}, poolKey: 'k', cacheKey: 'k',
            onRetry: (info) => retries.push(info),
            _acquire: mkFakeAcquire([
                { ok: false, err: mkTimeoutErr() },
                { ok: false, err: mkResetErr() },
                { ok: true, id: 'third' },
            ]),
            _sleepFn: sleep.fn,
        });
        assert(r.entry.id === 'third', 'third attempt succeeds after two transients');
        assert(retries.length === 2, 'two onRetry invocations');
        assert(sleep.delays[0] === 500 && sleep.delays[1] === 1000,
            `exponential backoff 500,1000 (got ${sleep.delays.join(',')})`);
        assert(retries[0].classifier === 'timeout' && retries[1].classifier === 'reset',
            'classifiers recorded per attempt');
    } finally { cap.restore(); }
}

// ── 5. all retries exhausted → final error surfaces with attempts=3 ───────
{
    const cap = captureStderr();
    const sleep = mkSleepRecorder();
    try {
        await _acquireWithRetry({
            auth: {}, poolKey: 'k', cacheKey: 'k',
            _acquire: mkFakeAcquire([
                { ok: false, err: mkTimeoutErr() },
                { ok: false, err: mkTimeoutErr() },
                { ok: false, err: mkTimeoutErr() },
            ]),
            _sleepFn: sleep.fn,
        });
        assert(false, 'exhausted retries should throw');
    } catch (err) {
        assert(/handshake has timed out/i.test(err.message),
            `final error preserves original message (got ${err.message})`);
        assert(err.attempts === 3, `final error.attempts === 3 (got ${err.attempts})`);
        assert(err.retryClassifier === 'timeout',
            `final error.retryClassifier === 'timeout' (got ${err.retryClassifier})`);
        assert(sleep.delays.length === 2, 'slept between attempts 1→2 and 2→3 (2 sleeps total)');
        const progressLines = cap.lines.filter(l => l.includes('worker retry'));
        assert(progressLines.length === 2,
            `two progress lines emitted across 3 attempts (got ${progressLines.length})`);
    } finally { cap.restore(); }
}

// ── 6. permanent 401 → does NOT retry ─────────────────────────────────────
{
    const cap = captureStderr();
    const sleep = mkSleepRecorder();
    const retries = [];
    let calls = 0;
    try {
        await _acquireWithRetry({
            auth: {}, poolKey: 'k', cacheKey: 'k',
            onRetry: (info) => retries.push(info),
            _acquire: async () => { calls++; throw mkAuthErr(); },
            _sleepFn: sleep.fn,
        });
        assert(false, '401 should throw immediately');
    } catch (err) {
        assert(err.httpStatus === 401, '401 error preserved');
        assert(calls === 1, `401 attempted exactly once, not retried (got ${calls} calls)`);
        assert(retries.length === 0, 'no onRetry invocations for 401');
        assert(sleep.delays.length === 0, 'no backoff sleep for 401');
        assert(err.attempts === 1, `err.attempts === 1 for permanent (got ${err.attempts})`);
        assert(err.retryClassifier === null,
            `err.retryClassifier === null for permanent (got ${err.retryClassifier})`);
        const progressLines = cap.lines.filter(l => l.includes('worker retry'));
        assert(progressLines.length === 0,
            'no "worker retry" progress line for permanent 401');
    } finally { cap.restore(); }
}

// ── 7. permanent 429 (quota) → does NOT retry ─────────────────────────────
{
    const cap = captureStderr();
    const sleep = mkSleepRecorder();
    let calls = 0;
    try {
        await _acquireWithRetry({
            auth: {}, poolKey: 'k', cacheKey: 'k',
            _acquire: async () => { calls++; throw mkQuotaErr(); },
            _sleepFn: sleep.fn,
        });
        assert(false, '429 should throw immediately');
    } catch (err) {
        assert(err.httpStatus === 429, '429 error preserved');
        assert(calls === 1, `429 attempted exactly once (got ${calls})`);
    } finally { cap.restore(); }
}

// ── 8. 5xx transient → retries ────────────────────────────────────────────
{
    const cap = captureStderr();
    const sleep = mkSleepRecorder();
    try {
        const r = await _acquireWithRetry({
            auth: {}, poolKey: 'k', cacheKey: 'k',
            _acquire: mkFakeAcquire([
                { ok: false, err: mk5xxErr() },
                { ok: true, id: '5xx-recovered' },
            ]),
            _sleepFn: sleep.fn,
        });
        assert(r.entry.id === '5xx-recovered', '503 classified as transient and retried');
    } finally { cap.restore(); }
}

console.log(`\nPASS ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
