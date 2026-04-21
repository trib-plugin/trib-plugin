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
    assert(/done/.test(job.stdoutPreview || ''), `job_status includes stdout preview (got ${JSON.stringify(job)})`);
    assert((job.stdoutBytes || 0) > 0, `job_status includes stdout byte count (got ${JSON.stringify(job)})`);
    assert(job.summary === 'done' && job.summarySource === 'stdout', `job_status includes concise completion summary (got ${JSON.stringify(job)})`);
    const out = await executeBuiltinTool('job_read', { job_id: jobId, stream: 'stdout', mode: 'tail', n: 20 }, process.cwd());
    assert(/done/.test(out), `job_read returns stdout content (got ${JSON.stringify(out)})`);

    const waitedRaw = await executeBuiltinTool('job_wait', { job_id: jobId, timeout_ms: 500 }, process.cwd());
    const waited = JSON.parse(waitedRaw);
    assert(waited.status === 'completed', `job_wait returns completed job without polling loop (got ${JSON.stringify(waited)})`);
    assert(waited.summary === 'done', `job_wait includes completion summary (got ${JSON.stringify(waited)})`);
  }

  {
    const listed = await executeBuiltinTool('jobs_list', {}, process.cwd());
    assert(/job_/.test(listed), 'jobs_list includes at least one background job');
    assert(/\tdone$/.test(listed) || /\tdone\n/.test(listed), `jobs_list includes summary tail for completed job (got ${JSON.stringify(listed)})`);
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
    assert(typeof status.stdoutBytes === 'number', `job_status includes preview metadata even for cancelled jobs (got ${JSON.stringify(status)})`);
    assert(status.summary === 'cancelled before completion' && status.summarySource === 'status', `cancelled job gets status summary (got ${JSON.stringify(status)})`);
  }

  {
    const res = await executeBuiltinTool('bash', {
      command: 'sleep 1; echo late',
      run_in_background: true,
    }, process.cwd());
    const jobId = extractJobId(res);
    assert(!!jobId, 'wait-timeout test returns job id');
    const waitedRaw = await executeBuiltinTool('job_wait', { job_id: jobId, timeout_ms: 50, poll_ms: 25 }, process.cwd());
    const waited = JSON.parse(waitedRaw);
    assert(waited.status === 'running' && waited.waitTimedOut === true, `job_wait returns running state when timeout expires (got ${JSON.stringify(waited)})`);
    const done = await waitForDone(jobId, 3000);
    assert(done.status === 'completed', `wait-timeout background job still completes later (got ${JSON.stringify(done)})`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-background-bash-jobs: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-background-bash-jobs: ${passed} passed`);
