/**
 * Tests for the bridge request-abort wiring (v0.6.242).
 *
 * Symptom motivating the fix:
 *   When a user rejects or interrupts a `bridge` tool call in Claude Code,
 *   the MCP request cancels but the bridge handler's detached async IIFE
 *   kept running askSession against the provider — surfacing as a phantom
 *   session (matching the rejected call's timestamp) that showed up in
 *   list_sessions and kept making edits.
 *
 * Architectural note:
 *   Bridge workers are NOT child PROCESSES — they are in-process sessions
 *   running askSession inside a detached IIFE. So "killing the worker" in
 *   this codebase means:
 *     1. Call closeSession(id) — tombstones on disk + aborts the controller
 *     2. Provider unwinds on its AbortSignal, askSession throws
 *        SessionClosedError, the IIFE's finally block runs trajectory
 *        record + notifyFn.
 *   There is no PID to SIGTERM. The brief's SIGTERM/SIGKILL framing was
 *   written against a mental model where bridge forked; the actual fix
 *   is the signal → closeSession() chain below.
 *
 * Test groups (20 assertions across 10 scenarios):
 *   1. attachBridgeAbort requires closeSession — throws when absent.
 *   2. attachBridgeAbort requires sessionId — throws when absent.
 *   3. No signal → no-op handle (fired stays false, closeSession not called,
 *      detach is safe).
 *   4. Already-aborted signal → closeSession fires asynchronously (deferred,
 *      correct id, fired() flips).
 *   5. Post-attach abort calls closeSession exactly once, fired() flips.
 *   6. Firing a second abort on the same signal does NOT double-close.
 *   7. detach() before fire removes the listener (closeSession never called).
 *   8. emit() receives a silent-to-agent `aborted by user` status ping with
 *      the right modelTag prefix.
 *   9. stderr log line `worker aborted by user: session=…` is emitted.
 *  10. closeSession throwing is swallowed (abort path does not crash) and
 *      the failure is traced to stderr.
 */

import { attachBridgeAbort } from '../src/agent/bridge-abort.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) passed++;
    else { failed++; console.error(`  FAIL: ${msg}`); }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function mkFakeCloseSession() {
    const calls = [];
    const fn = (id) => { calls.push(id); };
    return { fn, calls };
}

function mkFakeEmit() {
    const calls = [];
    const fn = (msg, meta) => { calls.push({ msg, meta }); };
    return { fn, calls };
}

function mkFakeLog() {
    const lines = [];
    const fn = (msg) => { lines.push(msg); };
    return { fn, lines };
}

// ── 1. closeSession required ─────────────────────────────────────────
{
    let threw = false;
    try {
        attachBridgeAbort({
            signal: new AbortController().signal,
            sessionId: 'sess_x',
        });
    } catch (e) { threw = /closeSession is required/.test(e.message); }
    assert(threw, 'attachBridgeAbort throws when closeSession is missing');
}

// ── 2. sessionId required ────────────────────────────────────────────
{
    let threw = false;
    try {
        attachBridgeAbort({
            signal: new AbortController().signal,
            closeSession: () => {},
        });
    } catch (e) { threw = /sessionId is required/.test(e.message); }
    assert(threw, 'attachBridgeAbort throws when sessionId is missing');
}

// ── 3. No signal → no-op ─────────────────────────────────────────────
{
    const cs = mkFakeCloseSession();
    const handle = attachBridgeAbort({
        signal: null,
        sessionId: 'sess_noop',
        closeSession: cs.fn,
    });
    assert(handle.fired() === false, 'no-signal path: fired() is false');
    assert(cs.calls.length === 0, 'no-signal path: closeSession never called');
    // detach should not throw even with no-op handle
    let threw = false;
    try { handle.detach(); } catch { threw = true; }
    assert(threw === false, 'no-signal path: detach() is a no-op');
}

// ── 4. Already-aborted signal → closeSession fires async ─────────────
{
    const cs = mkFakeCloseSession();
    const log = mkFakeLog();
    const ac = new AbortController();
    ac.abort(new Error('client cancelled before attach'));
    const handle = attachBridgeAbort({
        signal: ac.signal,
        sessionId: 'sess_preaborted',
        role: 'worker',
        jobId: 'job_pre',
        closeSession: cs.fn,
        log: log.fn,
    });
    // Microtask hasn't run yet
    assert(cs.calls.length === 0, 'pre-aborted: closeSession deferred to microtask');
    await sleep(10);
    assert(cs.calls.length === 1 && cs.calls[0] === 'sess_preaborted',
        'pre-aborted: closeSession fires with correct session id');
    assert(handle.fired() === true, 'pre-aborted: fired() returns true after microtask');
}

// ── 5. Post-attach abort fires closeSession once ─────────────────────
{
    const cs = mkFakeCloseSession();
    const ac = new AbortController();
    const handle = attachBridgeAbort({
        signal: ac.signal,
        sessionId: 'sess_live',
        role: 'debugger',
        jobId: 'job_live',
        closeSession: cs.fn,
    });
    assert(cs.calls.length === 0, 'live-attach: closeSession not called before abort');
    ac.abort();
    await sleep(5);
    assert(cs.calls.length === 1 && cs.calls[0] === 'sess_live',
        'live-attach: abort fires closeSession exactly once');
    assert(handle.fired() === true, 'live-attach: fired() flag set');
}

// ── 6. Double-abort is idempotent ────────────────────────────────────
// AbortSignal already guards this ({ once: true }), but the internal
// `fired` flag is belt-and-braces for the pre-aborted microtask path.
{
    const cs = mkFakeCloseSession();
    const ac = new AbortController();
    attachBridgeAbort({
        signal: ac.signal,
        sessionId: 'sess_dup',
        closeSession: cs.fn,
    });
    ac.abort();
    ac.abort(); // AbortController coalesces; listener only fires once anyway
    await sleep(5);
    assert(cs.calls.length === 1, 'double-abort: closeSession still called once');
}

// ── 7. detach() before fire prevents closeSession ────────────────────
{
    const cs = mkFakeCloseSession();
    const ac = new AbortController();
    const handle = attachBridgeAbort({
        signal: ac.signal,
        sessionId: 'sess_detached',
        closeSession: cs.fn,
    });
    handle.detach();
    ac.abort();
    await sleep(5);
    assert(cs.calls.length === 0, 'detach-before-abort: closeSession never called');
    assert(handle.fired() === false, 'detach-before-abort: fired() stays false');
}

// ── 8. emit() receives silent-to-agent status ping ───────────────────
{
    const cs = mkFakeCloseSession();
    const emit = mkFakeEmit();
    const ac = new AbortController();
    attachBridgeAbort({
        signal: ac.signal,
        sessionId: 'sess_emit',
        role: 'tester',
        jobId: 'job_emit',
        modelTag: '[haiku-4] ',
        closeSession: cs.fn,
        emit: emit.fn,
    });
    ac.abort();
    await sleep(5);
    assert(emit.calls.length === 1, 'emit: exactly one notification fired');
    const first = emit.calls[0] || { msg: '', meta: null };
    assert(
        first.msg === '[haiku-4] tester aborted by user',
        `emit: message format matches spec (got: ${JSON.stringify(first.msg)})`
    );
    assert(
        first.meta && first.meta.silent_to_agent === true,
        `emit: silent_to_agent flag set (got: ${JSON.stringify(first.meta)})`
    );
}

// ── 9. stderr event log line is emitted ──────────────────────────────
{
    const cs = mkFakeCloseSession();
    const log = mkFakeLog();
    const ac = new AbortController();
    attachBridgeAbort({
        signal: ac.signal,
        sessionId: 'sess_log',
        role: 'worker',
        jobId: 'bridge_123_abcd',
        closeSession: cs.fn,
        log: log.fn,
    });
    ac.abort();
    await sleep(5);
    const joined = log.lines.join('');
    assert(
        /\[bridge\] worker aborted by user: session=sess_log role=worker job=bridge_123_abcd/.test(joined),
        `stderr log line present (got: ${JSON.stringify(joined)})`
    );
}

// ── 10. closeSession errors are swallowed ────────────────────────────
{
    const log = mkFakeLog();
    const ac = new AbortController();
    attachBridgeAbort({
        signal: ac.signal,
        sessionId: 'sess_throw',
        role: 'worker',
        jobId: 'job_throw',
        closeSession: () => { throw new Error('simulated close failure'); },
        log: log.fn,
    });
    let unexpectedThrow = false;
    try {
        ac.abort();
        await sleep(5);
    } catch { unexpectedThrow = true; }
    assert(unexpectedThrow === false, 'closeSession throw does not propagate');
    const joined = log.lines.join('');
    assert(
        /closeSession failed during abort: simulated close failure/.test(joined),
        `closeSession failure is logged (got: ${JSON.stringify(joined)})`
    );
}

console.log(`\nPASS ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
