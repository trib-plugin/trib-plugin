/**
 * Tests for tool-loop-guard.mjs — hash-based consecutive fail detection.
 *
 * Scenarios:
 *   1. Normal flow — 3 successful tool calls stay at action=continue
 *   2. 2x same failure — action=detected on second
 *   3. 3x same failure — action=abort on third
 *   4. Reset on different tool — count resets
 *   5. Reset on same tool different error — count resets
 *   6. Edit CRLF signature — edit-match-fail category
 *   7. Rate-limit signature — separate category from generic
 *   8. Args normalization — whitespace variance does not change signature
 */

import { createGuard, checkToolCall, ToolLoopAbortError, _internals } from '../src/agent/orchestrator/tool-loop-guard.mjs';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function feed(guard, toolName, args, result, iteration) {
  return checkToolCall(guard, { toolName, args, result, iteration });
}

// 1. Normal flow — all successes
{
  const g = createGuard();
  const r1 = feed(g, 'Read', { path: '/a' }, 'content here', 1);
  const r2 = feed(g, 'Grep', { pattern: 'x' }, 'match found', 2);
  const r3 = feed(g, 'Edit', { old_string: 'a', new_string: 'b' }, 'OK', 3);
  assert(r1.action === 'continue' && r2.action === 'continue' && r3.action === 'continue', '1. normal flow stays continue');
}

// 2. 2x same failure — detected
{
  const g = createGuard();
  const r1 = feed(g, 'Edit', { old_string: 'foo', new_string: 'bar' }, 'Error: old_string did not match', 1);
  const r2 = feed(g, 'Edit', { old_string: 'foo', new_string: 'bar' }, 'Error: old_string did not match', 2);
  assert(r1.action === 'continue', '2. first failure stays continue');
  assert(r2.action === 'detected', '2. second identical failure is detected');
  assert(r2.info.attemptCount === 2, '2. attemptCount=2');
}

// 3. 3x same failure — abort
{
  const g = createGuard();
  feed(g, 'Edit', { old_string: 'foo' }, 'Error: old_string did not match', 1);
  feed(g, 'Edit', { old_string: 'foo' }, 'Error: old_string did not match', 2);
  const r3 = feed(g, 'Edit', { old_string: 'foo' }, 'Error: old_string did not match', 3);
  assert(r3.action === 'abort', '3. third identical failure aborts');
  assert(r3.info.attemptCount === 3, '3. attemptCount=3 on abort');
  assert(r3.info.errorCategory === 'edit-match-fail', '3. category is edit-match-fail');
}

// 4. Reset on different tool
{
  const g = createGuard();
  feed(g, 'Edit', { old_string: 'foo' }, 'Error: old_string did not match', 1);
  feed(g, 'Edit', { old_string: 'foo' }, 'Error: old_string did not match', 2);
  const r3 = feed(g, 'Read', { path: '/x' }, 'Error: ENOENT no such file', 3);
  assert(r3.action === 'continue', '4. different tool resets count (ENOENT on Read is count=1)');
  assert(g.count === 1, '4. guard count=1 after reset');
}

// 5. Reset on same tool but different error category
{
  const g = createGuard();
  feed(g, 'Edit', { old_string: 'foo' }, 'Error: old_string did not match', 1);
  feed(g, 'Edit', { old_string: 'foo' }, 'Error: old_string did not match', 2);
  const r3 = feed(g, 'Edit', { old_string: 'foo' }, 'Error: EACCES permission denied', 3);
  assert(r3.action === 'continue', '5. same tool different error resets');
  assert(g.count === 1, '5. guard count=1 after category change');
}

// 6. Edit CRLF classification
{
  const cat = _internals.classifyError('Error: old_string did not match in file');
  assert(cat === 'edit-match-fail', '6. edit-match-fail classification');
}

// 7. Rate limit classification — separate from generic
{
  const rl = _internals.classifyError('Error: 429 rate limit exceeded');
  assert(rl === 'rate-limit', '7. rate-limit classification');
  const g = createGuard();
  feed(g, 'Bash', { cmd: 'curl' }, 'Error: 429 rate limit exceeded', 1);
  feed(g, 'Bash', { cmd: 'curl' }, 'Error: 429 rate limit exceeded', 2);
  const r3 = feed(g, 'Bash', { cmd: 'curl' }, 'Error: 429 rate limit exceeded', 3);
  assert(r3.action === 'abort' && r3.info.errorCategory === 'rate-limit', '7. rate-limit triple-abort');
}

// 8. Args normalization — whitespace variance
{
  const a = _internals.normalizeArgs({ old_string: 'hello  world', new_string: 'x' });
  const b = _internals.normalizeArgs({ old_string: 'hello world', new_string: 'x' });
  assert(a === b, '8. normalizeArgs collapses whitespace variance');
  const sig1 = _internals.signatureOf('Edit', { old_string: 'a\t b' }, 'edit-match-fail');
  const sig2 = _internals.signatureOf('Edit', { old_string: 'a b' }, 'edit-match-fail');
  assert(sig1 === sig2, '8. signatures match after whitespace normalization');
}

// 9. ToolLoopAbortError instance sanity
{
  const err = new ToolLoopAbortError({ signature: 'abc', toolName: 'Edit', errorCategory: 'edit-match-fail', attemptCount: 3, argsSample: '{}', errorSample: 'Error: x' });
  assert(err instanceof Error, '9. ToolLoopAbortError is an Error');
  assert(err.name === 'ToolLoopAbortError', '9. name is ToolLoopAbortError');
  assert(err.info.toolName === 'Edit', '9. info preserved');
}

console.log(`test-tool-loop-guard: ${passed} pass / ${failed} fail`);
process.exit(failed ? 1 : 0);
