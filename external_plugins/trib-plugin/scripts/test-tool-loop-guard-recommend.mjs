import { recommendToolLoopGuardFromTrace } from '../src/agent/orchestrator/tool-loop-guard-recommend.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'trib-guard-recommend-'));
try {
  mkdirSync(join(root, 'history'), { recursive: true });
  const tracePath = join(root, 'history', 'bridge-trace.jsonl');
  const rows = [];
  for (let s = 0; s < 20; s++) {
    const sid = `sess_${s}`;
    for (let i = 0; i < 6; i++) rows.push({ ts: new Date(1_700_000_000_000 + rows.length).toISOString(), sessionId: sid, kind: 'tool', tool_name: 'read' });
    for (let i = 0; i < 6; i++) rows.push({ ts: new Date(1_700_000_000_000 + rows.length).toISOString(), sessionId: sid, kind: 'tool', tool_name: 'grep' });
  }
  writeFileSync(tracePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

  const rec = recommendToolLoopGuardFromTrace({ tracePath, window: 10000 });
  assert(rec.sampledToolRows === rows.length, `recommendation scans expected number of tool rows (got ${rec.sampledToolRows})`);
  assert(rec.sampledSessions === 20, `recommendation groups sessions correctly (got ${rec.sampledSessions})`);
  assert(Object.keys(rec.overrides || {}).length > 0, `recommendation produces at least one override from non-trivial trace (got ${JSON.stringify(rec.overrides)})`);
  assert((rec.recommendation.totalToolWarnThresholds || [])[0] >= 12, `budget threshold recommendation stays sane (got ${JSON.stringify(rec.recommendation)})`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-tool-loop-guard-recommend: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-tool-loop-guard-recommend: ${passed} passed`);
