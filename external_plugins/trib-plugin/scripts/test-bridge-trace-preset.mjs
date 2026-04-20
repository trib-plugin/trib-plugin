/**
 * Test for bridge-trace.mjs — traceBridgePreset JSONL shape.
 *
 * Appends a synthetic preset_assign record to the live bridge-trace.jsonl
 * under the plugin data directory and verifies the last line matches the
 * documented shape:
 *   { ts, sessionId, kind: 'preset_assign', role, preset_name, model, provider }
 *
 * Safe side-effect — the record has a unique sessionId so it cannot
 * collide with real telemetry, and we don't mutate or remove existing
 * lines.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { traceBridgePreset } from '../src/agent/orchestrator/bridge-trace.mjs';
import { getPluginData } from '../src/agent/orchestrator/config.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) passed++;
    else { failed++; console.error(`  FAIL: ${msg}`); }
}

const TRACE_PATH = join(getPluginData(), 'history', 'bridge-trace.jsonl');
const marker = `test-preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ── Call the tracer ────────────────────────────────────────────────────
traceBridgePreset({
    sessionId: marker,
    role: 'worker',
    presetName: 'OPUS XHIGH',
    model: 'claude-opus-4-7',
    provider: 'anthropic-oauth',
});

// Give the fs a moment (synchronous append anyway, but guard).
assert(existsSync(TRACE_PATH), 'bridge-trace.jsonl exists after first trace call');

const lines = readFileSync(TRACE_PATH, 'utf8').split('\n').filter(Boolean);
assert(lines.length > 0, 'trace file has at least one line');

// Find our record by the unique marker.
const ours = lines.slice(-5).map(l => {
    try { return JSON.parse(l); } catch { return null; }
}).find(r => r && r.sessionId === marker);

assert(!!ours, `our record with sessionId=${marker} is present in the tail`);
if (ours) {
    assert(ours.kind === 'preset_assign', `kind === 'preset_assign' (got ${ours.kind})`);
    assert(ours.role === 'worker', `role === 'worker' (got ${ours.role})`);
    assert(ours.preset_name === 'OPUS XHIGH', `preset_name === 'OPUS XHIGH' (got ${ours.preset_name})`);
    assert(ours.model === 'claude-opus-4-7', `model === 'claude-opus-4-7' (got ${ours.model})`);
    assert(ours.provider === 'anthropic-oauth', `provider === 'anthropic-oauth' (got ${ours.provider})`);
    assert(typeof ours.ts === 'string' && ours.ts.length > 0, `ts is non-empty string (got ${ours.ts})`);
}

// ── Null-safety: missing fields get serialized as null ─────────────────
const marker2 = `${marker}-nulls`;
traceBridgePreset({
    sessionId: marker2,
    // role / presetName / model / provider all missing on purpose
});
const linesAfter = readFileSync(TRACE_PATH, 'utf8').split('\n').filter(Boolean);
const nulls = linesAfter.slice(-5).map(l => {
    try { return JSON.parse(l); } catch { return null; }
}).find(r => r && r.sessionId === marker2);

assert(!!nulls, 'null-case record present');
if (nulls) {
    assert(nulls.role === null, 'missing role serialized as null');
    assert(nulls.preset_name === null, 'missing preset_name serialized as null');
    assert(nulls.model === null, 'missing model serialized as null');
    assert(nulls.provider === null, 'missing provider serialized as null');
}

console.log(`\nPASS ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
