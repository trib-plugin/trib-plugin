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

console.log();
console.log(`PASS ${passed}/${passed + failed}`);

if (prevPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
else process.env.CLAUDE_PLUGIN_DATA = prevPluginData;
rmSync(tempPluginData, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
