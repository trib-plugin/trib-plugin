import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'trib-bg-jobs-'));
process.env.CLAUDE_PLUGIN_DATA = root;

const { executeBuiltinTool } = await import('../src/agent/orchestrator/tools/builtin.mjs');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

function extractJobId(text) {
  const m = /\[job: ([^\]\r\n]+)\]/.exec(String(text || ''));
  return m ? m[1] : null;
}

async function waitForDone(jobId, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const raw = await executeBuiltinTool('job_status', { job_id: jobId }, process.cwd());
    const parsed = JSON.parse(raw);
    if (parsed.status !== 'running') return parsed;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${jobId} did not finish in time`);
}

try {
  {
    const res = await executeBuiltinTool('bash', {
      command: 'sleep 0.1; echo done',
      run_in_background: true,
    }, process.cwd());
    const jobId = extractJobId(res);
    assert(!!jobId, 'background bash returns job id');
    const job = await waitForDone(jobId);
    assert(job.status === 'completed', `background bash completes (got ${job.status})`);
    const out = await executeBuiltinTool('job_read', { job_id: jobId, stream: 'stdout', mode: 'tail', n: 20 }, process.cwd());
    assert(/done/.test(out), `job_read returns stdout content (got ${JSON.stringify(out)})`);
  }

  {
    const listed = await executeBuiltinTool('jobs_list', {}, process.cwd());
    assert(/job_/.test(listed), 'jobs_list includes at least one background job');
  }

  {
    const res = await executeBuiltinTool('bash', {
      command: 'sleep 5',
      run_in_background: true,
    }, process.cwd());
    const jobId = extractJobId(res);
    assert(!!jobId, 'cancel-test background bash returns job id');
    const cancel = await executeBuiltinTool('job_cancel', { job_id: jobId }, process.cwd());
    assert(/Cancelled job/.test(cancel), `job_cancel acknowledges cancellation (got ${JSON.stringify(cancel)})`);
    const statusRaw = await executeBuiltinTool('job_status', { job_id: jobId }, process.cwd());
    const status = JSON.parse(statusRaw);
    assert(status.status === 'cancelled', `job_status reflects cancelled state (got ${status.status})`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-background-bash-jobs: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-background-bash-jobs: ${passed} passed`);
