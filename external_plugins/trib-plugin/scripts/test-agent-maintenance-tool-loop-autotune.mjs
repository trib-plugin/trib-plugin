import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
const root = mkdtempSync(join(tmpdir(), 'trib-maint-guard-'));
process.env.CLAUDE_PLUGIN_DATA = root;

const { runAgentMaintenance } = await import('../src/agent/orchestrator/agent-maintenance.mjs');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

try {
  mkdirSync(join(root, 'history'), { recursive: true });
  const tracePath = join(root, 'history', 'bridge-trace.jsonl');
  const rows = [];
  for (let s = 0; s < 30; s++) {
    const sid = `sess_${s}`;
    for (let i = 0; i < 7; i++) rows.push({ ts: new Date(1_700_000_000_000 + rows.length).toISOString(), sessionId: sid, kind: 'tool', tool_name: 'read' });
    for (let i = 0; i < 5; i++) rows.push({ ts: new Date(1_700_000_000_000 + rows.length).toISOString(), sessionId: sid, kind: 'tool', tool_name: 'glob' });
  }
  writeFileSync(tracePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  writeFileSync(join(root, 'agent-config.json'), JSON.stringify({
    providers: { openai: { enabled: true } },
    bridge: {
      toolLoopGuardAutoTune: {
        enabled: true,
        mode: 'apply',
        window: 10000,
        minToolRows: 100,
        tracePath,
      },
    },
  }, null, 2));

  await runAgentMaintenance();

  const raw = JSON.parse(readFileSync(join(root, 'agent-config.json'), 'utf8'));
  assert(raw.bridge?.toolLoopGuardAutoTune?.enabled === true, `autotune config preserved (got ${JSON.stringify(raw.bridge)})`);
  assert(Object.keys(raw.bridge?.toolLoopGuard?.sameToolThresholds || {}).length > 0, `maintenance autotune writes sameToolThreshold overrides (got ${JSON.stringify(raw.bridge)})`);
  assert(Array.isArray(raw.bridge?.toolLoopGuard?.totalToolWarnThresholds), `maintenance autotune writes budget thresholds (got ${JSON.stringify(raw.bridge)})`);

  writeFileSync(join(root, 'agent-config.json'), JSON.stringify({
    providers: { openai: { enabled: true } },
    bridge: {
      toolLoopGuardAutoTune: {
        enabled: true,
        mode: 'recommend',
        window: 10000,
        minToolRows: 100,
        tracePath,
      },
    },
  }, null, 2));

  await runAgentMaintenance();

  const rawRecommend = JSON.parse(readFileSync(join(root, 'agent-config.json'), 'utf8'));
  const recommendationPath = join(root, 'tool-loop-guard-recommendation.json');
  const recommendation = JSON.parse(readFileSync(recommendationPath, 'utf8'));
  assert(rawRecommend.bridge?.toolLoopGuard === undefined, `recommend mode does not auto-apply overrides (got ${JSON.stringify(rawRecommend.bridge)})`);
  assert(recommendation.mode === 'recommend', `recommend mode writes recommendation file (got ${JSON.stringify(recommendation)})`);
  assert(Object.keys(recommendation.overrides || {}).length > 0, `recommendation file contains overrides (got ${JSON.stringify(recommendation)})`);
} finally {
  if (prevDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-agent-maintenance-tool-loop-autotune: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-agent-maintenance-tool-loop-autotune: ${passed} passed`);
