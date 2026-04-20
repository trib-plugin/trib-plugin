/**
 * Tests for bridge-stall-watchdog.mjs — per-session SSE stall notifier.
 *
 * Exercises:
 *   1. Pure inspectBridgeEntry() verdicts across the full stage matrix.
 *   2. End-to-end: start watchdog against a synthetic runtime that sleeps
 *      past the threshold, and verify the correct notifyFn message fires
 *      exactly once, with the right modelTag + iter number, and that the
 *      abort callback is invoked before stop().
 *   3. Fast-recovery: a runtime whose lastStreamDeltaAt keeps getting
 *      bumped never fires (no false alarms).
 *   4. tool_running stays skipped even past threshold (long tool calls OK).
 */

import { inspectBridgeEntry, startBridgeStallWatchdog } from '../src/agent/bridge-stall-watchdog.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

function mkEntry(staleSeconds, extra = {}) {
  return {
    stage: 'streaming',
    lastStreamDeltaAt: Date.now() - staleSeconds * 1000,
    closed: false,
    ...extra,
  };
}

// ── inspectBridgeEntry ─────────────────────────────────────────────────
{
  const v = inspectBridgeEntry(null, 90);
  assert(v.verdict === 'skip', 'null entry → skip');
}
{
  const v = inspectBridgeEntry(mkEntry(5), 90);
  assert(v.verdict === 'ok' && v.staleSeconds === 5, 'fresh entry → ok');
}
{
  const v = inspectBridgeEntry(mkEntry(120), 90);
  assert(v.verdict === 'stall' && v.staleSeconds >= 120, '120s stale @ 90s threshold → stall');
}
{
  const v = inspectBridgeEntry(mkEntry(120, { stage: 'tool_running' }), 90);
  assert(v.verdict === 'skip', 'tool_running ignored even if stale (long tool call OK)');
}
{
  // No lastStreamDeltaAt yet — should fall back to askStartedAt
  const entry = { stage: 'connecting', askStartedAt: Date.now() - 200 * 1000, closed: false };
  const v = inspectBridgeEntry(entry, 90);
  assert(v.verdict === 'stall', 'connecting phase with stale askStartedAt → stall');
}
{
  const v = inspectBridgeEntry(mkEntry(120, { stage: 'idle' }), 90);
  assert(v.verdict === 'skip', 'idle stage → skip (already done)');
}
{
  const v = inspectBridgeEntry(mkEntry(120, { closed: true }), 90);
  assert(v.verdict === 'skip', 'closed entry → skip');
}

// ── end-to-end: simulate stall scenario ───────────────────────────────
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

{
  const notifications = [];
  const aborts = [];
  // Freeze a synthetic runtime. lastStreamDeltaAt stays in the past; no
  // delta arrives, so the first tick (after ~50ms) will see the entry
  // as stalled past the 1s threshold.
  const runtime = {
    stage: 'streaming',
    lastStreamDeltaAt: Date.now() - 5_000, // 5s stale already
    closed: false,
  };
  const w = startBridgeStallWatchdog({
    sessionId: 'test-sess',
    getRuntime: () => runtime,
    getIteration: () => 21, // matches the iter-21 stall from the incident
    abort: (reason) => aborts.push(reason),
    notify: (msg) => notifications.push(msg),
    modelTag: '[3-5-sonnet] ',
    role: 'worker',
    thresholdSeconds: 1,
    tickMs: 50,
  });
  await sleep(200);
  w.stop();
  assert(notifications.length === 1, `exactly one notification fired (got ${notifications.length})`);
  assert(
    /^\[3-5-sonnet\] worker stalled — no SSE delta for \d+s at iter 21$/.test(notifications[0] || ''),
    `notification format matches spec (got: ${JSON.stringify(notifications[0])})`
  );
  assert(aborts.length === 1, 'abort called exactly once');
  assert(aborts[0]?.name === 'BridgeStallAbortError', 'abort reason carries BridgeStallAbortError name');
  assert(w.fired() === true, 'fired() flag set');
}

// ── no false alarms when stream keeps flowing ─────────────────────────
{
  const notifications = [];
  const aborts = [];
  const runtime = {
    stage: 'streaming',
    lastStreamDeltaAt: Date.now(),
    closed: false,
  };
  // Keep bumping the delta every 30ms — faster than the 50ms tick.
  const bumper = setInterval(() => { runtime.lastStreamDeltaAt = Date.now(); }, 30);
  const w = startBridgeStallWatchdog({
    sessionId: 'fresh-sess',
    getRuntime: () => runtime,
    getIteration: () => 5,
    abort: (r) => aborts.push(r),
    notify: (m) => notifications.push(m),
    thresholdSeconds: 1,
    tickMs: 50,
  });
  await sleep(300);
  clearInterval(bumper);
  w.stop();
  assert(notifications.length === 0, `no notification when stream is live (got ${notifications.length})`);
  assert(aborts.length === 0, 'no abort when stream is live');
  assert(w.fired() === false, 'fired() stays false');
}

// ── stop() before threshold prevents firing ───────────────────────────
{
  const notifications = [];
  const runtime = { stage: 'streaming', lastStreamDeltaAt: Date.now() - 5_000, closed: false };
  const w = startBridgeStallWatchdog({
    sessionId: 'early-stop',
    getRuntime: () => runtime,
    getIteration: () => 1,
    abort: () => {},
    notify: (m) => notifications.push(m),
    thresholdSeconds: 1,
    tickMs: 200,
  });
  w.stop(); // before first tick
  await sleep(250);
  assert(notifications.length === 0, 'stop() before first tick prevents firing');
}

// ── no iter suffix when lastIteration is 0 ────────────────────────────
{
  const notifications = [];
  const runtime = { stage: 'streaming', lastStreamDeltaAt: Date.now() - 5_000, closed: false };
  const w = startBridgeStallWatchdog({
    sessionId: 'no-iter',
    getRuntime: () => runtime,
    getIteration: () => 0,
    abort: () => {},
    notify: (m) => notifications.push(m),
    modelTag: '',
    role: 'debugger',
    thresholdSeconds: 1,
    tickMs: 50,
  });
  await sleep(150);
  w.stop();
  assert(notifications.length === 1, 'notification fires with no iter');
  assert(
    /^debugger stalled — no SSE delta for \d+s$/.test(notifications[0] || ''),
    `no-iter format omits suffix (got: ${JSON.stringify(notifications[0])})`
  );
}

console.log(`\nPASS ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
