/**
 * Tests for stream-watchdog.mjs — staleSeconds-based abort.
 *
 * Uses inspectEntry() (exported for tests) against synthetic runtime shapes
 * so we don't need a running session or real AbortController.
 */

import { inspectEntry, stopWatchdog, startWatchdog, StreamStalledAbortError, _thresholds } from '../src/agent/orchestrator/session/stream-watchdog.mjs';

let passed = 0;
let failed = 0;
function assert(condition, msg) {
  if (condition) passed++;
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

function fakeController() {
  let aborted = false;
  let reason = null;
  return {
    signal: { get aborted() { return aborted; } },
    abort(r) { aborted = true; reason = r; },
    wasAborted: () => aborted,
    abortReason: () => reason,
  };
}

function entryAt(staleSeconds, extra = {}) {
  const ctrl = fakeController();
  return {
    lastStreamDeltaAt: Date.now() - staleSeconds * 1000,
    lastToolCall: 'grep',
    stage: 'streaming',
    controller: ctrl,
    closed: false,
    ...extra,
  };
}

// Always reset watchdog state between tests — shared module-level _softWarned.
function reset() {
  stopWatchdog();
}

// ── 1. Fresh entry without lastStreamDeltaAt ─────────────────────────
{
  reset();
  const entry = { lastStreamDeltaAt: null, controller: fakeController(), closed: false };
  const result = inspectEntry('s1', entry);
  assert(result === 'skip', '1. no lastStreamDeltaAt -> skip');
}

// ── 2. 60s stale — continue (below soft threshold) ───────────────────
{
  reset();
  const e = entryAt(60);
  const result = inspectEntry('s2', e);
  assert(result === 'continue', '2. 60s stale -> continue');
  assert(!e.controller.wasAborted(), '2. controller not aborted');
}

// ── 3. 120s stale — soft warning once ────────────────────────────────
{
  reset();
  const e = entryAt(125);
  let softFired = 0;
  const r1 = inspectEntry('s3', e, { onSoft: () => softFired++ });
  assert(r1 === 'soft', '3. 125s -> soft');
  assert(softFired === 1, '3. onSoft fired once');
  // Second tick at same stale should NOT re-warn
  const r2 = inspectEntry('s3', e, { onSoft: () => softFired++ });
  assert(r2 === 'soft', '3. still soft on second tick');
  assert(softFired === 1, '3. onSoft fires only once per session');
  assert(!e.controller.wasAborted(), '3. controller not aborted at soft');
}

// ── 4. 180s stale — hard abort ───────────────────────────────────────
{
  reset();
  const e = entryAt(185);
  let hardFired = 0;
  const result = inspectEntry('s4', e, { onHard: () => hardFired++ });
  assert(result === 'hard', '4. 185s -> hard');
  assert(hardFired === 1, '4. onHard fired');
  assert(e.controller.wasAborted(), '4. controller aborted');
  assert(e.controller.abortReason() instanceof StreamStalledAbortError, '4. abort reason is StreamStalledAbortError');
  assert(e.controller.abortReason().info.staleSeconds >= 180, '4. error info.staleSeconds >= 180');
}

// ── 5. Delta reset clears soft warning ───────────────────────────────
{
  reset();
  const e = entryAt(125);
  let soft = 0;
  inspectEntry('s5', e, { onSoft: () => soft++ });
  assert(soft === 1, '5. first soft fired');
  // Simulate a delta update — move lastStreamDeltaAt fresh
  e.lastStreamDeltaAt = Date.now() - 10_000;
  const r2 = inspectEntry('s5', e, { onSoft: () => soft++ });
  assert(r2 === 'continue', '5. after delta reset -> continue');
  // Now stall again → should re-warn
  e.lastStreamDeltaAt = Date.now() - 125_000;
  inspectEntry('s5', e, { onSoft: () => soft++ });
  assert(soft === 2, '5. re-warns after fresh stall cycle');
}

// ── 6. Closed or already-aborted entries are skipped ─────────────────
{
  reset();
  const e = entryAt(185, { closed: true });
  const result = inspectEntry('s6', e);
  assert(result === 'skip', '6. closed entry -> skip');
  assert(!e.controller.wasAborted(), '6. closed entry not aborted');

  const e2 = entryAt(185);
  e2.controller.abort('prior');  // already aborted
  const r2 = inspectEntry('s7', e2);
  assert(r2 === 'skip', '6. already-aborted controller -> skip');
}

// ── 7. Multi-session independence ────────────────────────────────────
{
  reset();
  const a = entryAt(60);
  const b = entryAt(125);
  const c = entryAt(185);
  assert(inspectEntry('m1', a) === 'continue', '7. session A continue');
  assert(inspectEntry('m2', b) === 'soft', '7. session B soft');
  assert(inspectEntry('m3', c) === 'hard', '7. session C hard');
  assert(!a.controller.wasAborted(), '7. A not aborted');
  assert(!b.controller.wasAborted(), '7. B not aborted (only soft)');
  assert(c.controller.wasAborted(), '7. C aborted');
}

// ── 8. StreamStalledAbortError shape ─────────────────────────────────
{
  const err = new StreamStalledAbortError({ sessionId: 'x', staleSeconds: 200, lastToolCall: 'bash', stage: 'streaming' });
  assert(err instanceof Error, '8. StreamStalledAbortError is an Error');
  assert(err.name === 'StreamStalledAbortError', '8. name set correctly');
  assert(err.info.staleSeconds === 200, '8. info preserved');
  assert(err.message.includes('200'), '8. message mentions stale seconds');
}

// ── 9. Thresholds sanity ─────────────────────────────────────────────
{
  assert(_thresholds.SOFT_STALL_MS === 120_000, '9. SOFT_STALL_MS = 120s');
  assert(_thresholds.HARD_STALL_MS === 180_000, '9. HARD_STALL_MS = 180s');
  assert(_thresholds.TICK_MS === 15_000, '9. TICK_MS = 15s');
}

// ── 10. startWatchdog is idempotent and unrefs ───────────────────────
{
  reset();
  let iterations = 0;
  const iter = () => { iterations++; return []; };
  startWatchdog(iter);
  startWatchdog(iter); // should be a no-op
  stopWatchdog();
  assert(iterations === 0, '10. idempotent start; tick has not fired yet (timers are stopped too fast to fire)');
}

console.log(`test-stream-watchdog: ${passed} pass / ${failed} fail`);
process.exit(failed ? 1 : 0);
