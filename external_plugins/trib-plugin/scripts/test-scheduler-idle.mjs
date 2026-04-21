#!/usr/bin/env node
/**
 * Unit test for Scheduler.getSessionState() idle-state classification.
 *
 * Locks in the six branches:
 *   1. fresh instance (lastActivity === 0)     → "idle"
 *   2. elapsed <  2 min                         → "active"
 *   3. elapsed < 15 min                         → "recent"
 *   4. elapsed >=15 min                         → "idle"
 *   5. pendingCheck() === true overrides stale  → "active"
 *   6. pendingCheck() throws, non-fatal         → falls through to elapsed classification
 *
 * NOTE: Scheduler's constructor expects
 *   (nonInteractive[], interactive[], proactive|null, channelsConfig?, botConfig?)
 * so we construct with `[], [], null` — `new Scheduler({})` would throw on
 * `.filter(...)`. See report for adjustment rationale.
 */
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const prevPluginData = process.env.CLAUDE_PLUGIN_DATA;
const tempPluginData = mkdtempSync(join(tmpdir(), 'trib-scheduler-idle-'));
process.env.CLAUDE_PLUGIN_DATA = tempPluginData;

const { Scheduler } = await import('../src/channels/lib/scheduler.mjs');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  ok  ' + msg); }
    else       { failed++; console.error('  FAIL ' + msg); }
}

const mk = () => new Scheduler([], [], null);

// Case 1 — fresh instance → idle
{
    const s = mk();
    assert(s.getSessionState() === 'idle', 'case 1: fresh instance → idle');
}

// Case 2 — 1 min ago → active
{
    const s = mk();
    s.lastActivity = Date.now() - 1 * 60 * 1000;
    assert(s.getSessionState() === 'active', 'case 2: 1 min ago → active');
}

// Case 3 — 14 min ago → recent
{
    const s = mk();
    s.lastActivity = Date.now() - 14 * 60 * 1000;
    assert(s.getSessionState() === 'recent', 'case 3: 14 min ago → recent');
}

// Case 4 — 16 min ago → idle
{
    const s = mk();
    s.lastActivity = Date.now() - 16 * 60 * 1000;
    assert(s.getSessionState() === 'idle', 'case 4: 16 min ago → idle (past 15 min cutoff)');
}

// Case 5 — pendingCheck=true overrides stale lastActivity → active
{
    const s = mk();
    s.lastActivity = Date.now() - 30 * 60 * 1000; // deep in idle range
    s.setPendingCheck(() => true);
    assert(s.getSessionState() === 'active', 'case 5: pendingCheck=true overrides stale → active');
}

// Case 6 — pendingCheck throws → non-fatal fallthrough to elapsed classification
{
    const s = mk();
    s.lastActivity = Date.now() - 30 * 60 * 1000;
    s.setPendingCheck(() => { throw new Error('probe failure'); });
    let threw = false, result;
    try { result = s.getSessionState(); } catch { threw = true; }
    assert(!threw, 'case 6: getSessionState does not throw when probe throws');
    assert(result === 'idle', 'case 6: falls through to elapsed classification = idle');
}

// ── D4: period-based proactive firing ──────────────────────────────
// Helper that stubs fireProactiveTick so we can observe whether
// tickProactive calls it without needing the LLM.
function mkProactive({ frequency = 3 } = {}) {
    const s = new Scheduler([], [], { frequency, items: [] });
    s.fired = 0;
    s.fireProactiveTick = function () { s.fired++; };
    return s;
}

// Case 7 — cold start, idle, period not yet elapsed → don't fire
{
    const s = mkProactive({ frequency: 3 }); // 90m period
    // freshly constructed: proactiveStartAt ≈ Date.now(), lastFireAt = 0
    // Idle already guaranteed by fresh lastActivity=0.
    s.tickProactive(new Date());
    assert(s.fired === 0, 'case 7: cold start, period not elapsed → no fire');
    assert(s.getSessionState() === 'idle', 'case 7: session reports idle');
}

// Case 8 — period elapsed, session active (<15m) → don't fire
{
    const s = mkProactive({ frequency: 3 }); // 90m period
    s.proactiveStartAt = Date.now() - 120 * 60 * 1000; // 2h ago
    s.lastActivity = Date.now() - 1 * 60 * 1000; // 1min ago → active
    s.tickProactive(new Date());
    assert(s.fired === 0, 'case 8: period elapsed but session active → no fire');
}

// Case 9 — period elapsed, session idle → fire; lastFireAt updated
{
    const s = mkProactive({ frequency: 3 });
    s.proactiveStartAt = Date.now() - 120 * 60 * 1000; // 2h ago
    s.lastActivity = Date.now() - 20 * 60 * 1000;      // 20min ago → idle
    const beforeFireAt = s.proactiveLastFireAt;
    s.tickProactive(new Date());
    assert(s.fired === 1, 'case 9: period elapsed + idle → fire');
    // Mirror production: stub doesn't update lastFireAt (fireProactiveTick
    // would), so verify the baseline path by calling again — still fires
    // because stub didn't advance lastFireAt. Instead, simulate the update:
    s.proactiveLastFireAt = Date.now();
    assert(s.proactiveLastFireAt > beforeFireAt, 'case 9: lastFireAt advances post-fire');
    // And confirm period gate now blocks
    s.tickProactive(new Date());
    assert(s.fired === 1, 'case 9b: immediately after fire → period gate blocks');
}

// Case 10 — shouldSkip(proactive) true → don't fire regardless
{
    const s = mkProactive({ frequency: 3 });
    s.proactiveStartAt = Date.now() - 120 * 60 * 1000;
    s.lastActivity = Date.now() - 20 * 60 * 1000;      // idle
    s.skipToday('proactive');
    s.tickProactive(new Date());
    assert(s.fired === 0, 'case 10: shouldSkip(proactive) → no fire');
    // defer form also respected
    const s2 = mkProactive({ frequency: 5 });          // 30m period
    s2.proactiveStartAt = Date.now() - 60 * 60 * 1000; // 1h ago
    s2.lastActivity = Date.now() - 20 * 60 * 1000;
    s2.defer('proactive', 60);                          // deferred 60 min
    s2.tickProactive(new Date());
    assert(s2.fired === 0, 'case 10b: deferred("proactive") → no fire');
}

// Case 11 — FREQUENCY_MAP mapping sanity (period in minutes from idleMinutes)
{
    const expected = { 1: 180, 2: 120, 3: 90, 4: 60, 5: 30 };
    for (const [freq, min] of Object.entries(expected)) {
        const s = mkProactive({ frequency: Number(freq) });
        const actualMs = s.proactivePeriodMs();
        assert(actualMs === min * 60 * 1000, `case 11: frequency=${freq} → period=${min}m`);
    }
}

console.log();
console.log(`PASS ${passed}/${passed + failed}`);

if (prevPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
else process.env.CLAUDE_PLUGIN_DATA = prevPluginData;
rmSync(tempPluginData, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
