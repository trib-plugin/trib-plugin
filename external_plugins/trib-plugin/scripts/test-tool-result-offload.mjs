import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { maybeOffloadToolResult } from '../src/agent/orchestrator/session/tool-result-offload.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'trib-offload-test-'));
process.env.CLAUDE_PLUGIN_DATA = root;

try {
  {
    const short = 'hello world';
    const out = maybeOffloadToolResult('sess_a', 'call_a', 'read', short);
    assert(out === short, 'short output should stay inline');
  }

  {
    const big = 'line\n'.repeat(5000);
    const out = maybeOffloadToolResult('sess_b', 'call_b', 'grep', big);
    const expectedPath = join(root, 'tool-results', 'sess_b', 'call_b.txt');
    assert(out.includes('[tool output offloaded:'), 'large output should be offloaded');
    assert(out.includes('preview truncated'), 'offloaded output should mention preview truncation');
    assert(existsSync(expectedPath), 'offloaded file should exist');
    assert(readFileSync(expectedPath, 'utf8') === big, 'offloaded file should contain full output');
  }

  {
    const bigError = `Error: ${'x'.repeat(20000)}`;
    const out = maybeOffloadToolResult('sess_c', 'call_c', 'bash', bigError);
    const expectedPath = join(root, 'tool-results', 'sess_c', 'call_c.txt');
    assert(out === bigError, 'error output should stay inline');
    assert(!existsSync(expectedPath), 'error output should not be offloaded');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-tool-result-offload: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-tool-result-offload: ${passed} passed`);
