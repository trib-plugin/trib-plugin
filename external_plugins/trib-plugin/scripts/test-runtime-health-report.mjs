import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'trib-runtime-health-'));
try {
  const traceDir = join(root, 'history');
  const jobsDir = join(root, 'shell-jobs');
  mkdirSync(traceDir, { recursive: true });
  mkdirSync(jobsDir, { recursive: true });
  const now = Date.now();
  const rows = [
    { ts: new Date(now - 1000).toISOString(), sessionId: 's1', kind: 'tool_loop_detected', tool_name: 'read' },
    { ts: new Date(now - 900).toISOString(), sessionId: 's1', kind: 'tool_loop_aborted', tool_name: 'grep' },
    { ts: new Date(now - 800).toISOString(), sessionId: 's1', kind: 'tool_loop_warn', warn_type: 'same_tool', tool_name: 'job_status', count: 3 },
    { ts: new Date(now - 700).toISOString(), sessionId: 's2', kind: 'tool_loop_warn', warn_type: 'family', family_key: 'structure_probe', count: 10 },
    { ts: new Date(now - 600).toISOString(), sessionId: 's2', kind: 'tool_loop_warn', warn_type: 'budget', count: 24 },
  ];
  writeFileSync(join(traceDir, 'bridge-trace.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

  writeFileSync(join(jobsDir, 'job_a.json'), JSON.stringify({
    jobId: 'job_a',
    status: 'completed',
    startedAt: new Date(now - 5000).toISOString(),
    finishedAt: new Date(now - 1000).toISOString(),
  }, null, 2));
  writeFileSync(join(jobsDir, 'job_b.json'), JSON.stringify({
    jobId: 'job_b',
    status: 'failed',
    startedAt: new Date(now - 4000).toISOString(),
    finishedAt: new Date(now - 2000).toISOString(),
  }, null, 2));

  const res = spawnSync(process.execPath, [
    '/mnt/c/Users/tempe/.claude/plugins/marketplaces/trib-plugin/external_plugins/trib-plugin/scripts/report-runtime-health.mjs',
    '--json',
    '--hours=24',
    `--trace=${join(traceDir, 'bridge-trace.jsonl')}`,
    `--jobs_dir=${jobsDir}`,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const out = JSON.parse(res.stdout || '{}');
  assert(out.loop.toolLoopDetected === 1, `report counts detected loops (got ${JSON.stringify(out)})`);
  assert(out.loop.toolLoopAborted === 1, `report counts aborted loops (got ${JSON.stringify(out)})`);
  assert(out.loop.warnCounts.same_tool === 1 && out.loop.warnCounts.family === 1 && out.loop.warnCounts.budget === 1, `report counts warn types (got ${JSON.stringify(out)})`);
  assert(out.jobs.total === 2, `report counts background jobs (got ${JSON.stringify(out)})`);
  assert(out.jobs.statuses.completed === 1 && out.jobs.statuses.failed === 1, `report counts job statuses (got ${JSON.stringify(out)})`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-runtime-health-report: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-runtime-health-report: ${passed} passed`);
