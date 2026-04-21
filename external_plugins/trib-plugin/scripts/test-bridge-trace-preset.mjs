/**
 * Test for bridge-trace.mjs — traceBridgePreset JSONL shape.
 *
 * Writes preset_assign records to an isolated tmp data dir (not the live
 * production bridge-trace.jsonl) and verifies the documented shape:
 *   { ts, sessionId, kind: 'preset_assign', role, preset_name, model, provider }
 *
 * Isolation matters because run-all-tests.mjs sets TRIB_BRIDGE_TRACE_DISABLE=1
 * to keep test fixture sessionIds out of the production trace. This test
 * needs the writer enabled to verify the file shape, so it routes the
 * write to a fresh tmp dir via CLAUDE_PLUGIN_DATA before module load and
 * also clears the disable flag — neither production trace nor the
 * disable-flag invariant for other tests is affected.
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmpData = mkdtempSync(join(tmpdir(), 'trib-trace-test-'));
process.env.CLAUDE_PLUGIN_DATA = tmpData;
delete process.env.TRIB_BRIDGE_TRACE_DISABLE;

const { traceBridgePreset } = await import('../src/agent/orchestrator/bridge-trace.mjs');

const TRACE_PATH = join(tmpData, 'history', 'bridge-trace.jsonl');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) passed++;
    else { failed++; console.error(`  FAIL: ${msg}`); }
}

const marker = `test-preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ── Call the tracer ────────────────────────────────────────────────────
traceBridgePreset({
    sessionId: marker,
    role: 'worker',
    presetName: 'OPUS XHIGH',
    model: 'claude-opus-4-7',
    provider: 'anthropic-oauth',
});

assert(existsSync(TRACE_PATH), 'bridge-trace.jsonl exists after first trace call');

const lines = readFileSync(TRACE_PATH, 'utf8').split('\n').filter(Boolean);
assert(lines.length > 0, 'trace file has at least one line');

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

try { rmSync(tmpData, { recursive: true, force: true }); } catch {}

console.log(`\nPASS ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
