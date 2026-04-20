/**
 * Tests for tool-loop-guard.mjs — hash-based consecutive fail detection.
 *
 * Thresholds (post-relaxation):
 *   - 1st/2nd/3rd identical failure: free (continue).
 *   - 4th identical failure: action=detected + soft-warn text.
 *   - 5th identical failure: action=abort.
 *
 * Scenarios:
 *   1. Normal flow — 3 successful tool calls stay at action=continue
 *   2. 4x same failure — detected on the 4th with warn text
 *   3. 5x same failure — abort on the 5th
 *   4. Reset on different tool — count resets
 *   5. Reset on same tool different error — count resets
 *   6. Edit CRLF signature — edit-match-fail category
 *   7. Rate-limit signature — separate category from generic
 *   8. Args normalization — whitespace variance does not change signature
 *   9. ToolLoopAbortError instance sanity
 *  10. 3rd identical call stays continue (no warn, no abort)
 *  11. Args change between 4 and 5 resets counter; warn not re-emitted
 *      until the next 4-streak
 *  12. Success between failures resets counter
 *  13. Warn text includes the 4/fifth phrasing
 */

import {
    createGuard,
    checkToolCall,
    ToolLoopAbortError,
    buildSoftWarn,
    _internals,
} from '../src/agent/orchestrator/tool-loop-guard.mjs';

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

const EDIT_ERR = 'Error: old_string did not match';

// 1. Normal flow — all successes
{
    const g = createGuard();
    const r1 = feed(g, 'Read', { path: '/a' }, 'content here', 1);
    const r2 = feed(g, 'Grep', { pattern: 'x' }, 'match found', 2);
    const r3 = feed(g, 'Edit', { old_string: 'a', new_string: 'b' }, 'OK', 3);
    assert(
        r1.action === 'continue' && r2.action === 'continue' && r3.action === 'continue',
        '1. normal flow stays continue'
    );
}

// 2. 4x same failure — detected on the 4th
{
    const g = createGuard();
    const r1 = feed(g, 'Edit', { old_string: 'foo', new_string: 'bar' }, EDIT_ERR, 1);
    const r2 = feed(g, 'Edit', { old_string: 'foo', new_string: 'bar' }, EDIT_ERR, 2);
    const r3 = feed(g, 'Edit', { old_string: 'foo', new_string: 'bar' }, EDIT_ERR, 3);
    const r4 = feed(g, 'Edit', { old_string: 'foo', new_string: 'bar' }, EDIT_ERR, 4);
    assert(r1.action === 'continue', '2. 1st failure stays continue');
    assert(r2.action === 'continue', '2. 2nd failure stays continue');
    assert(r3.action === 'continue', '2. 3rd failure stays continue');
    assert(r4.action === 'detected', '2. 4th identical failure is detected');
    assert(r4.info.attemptCount === 4, '2. attemptCount=4 on detect');
    assert(typeof r4.warnText === 'string' && r4.warnText.length > 0, '2. warnText emitted on 4th');
}

// 3. 5x same failure — abort on the 5th
{
    const g = createGuard();
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 1);
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 2);
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 3);
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 4);
    const r5 = feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 5);
    assert(r5.action === 'abort', '3. 5th identical failure aborts');
    assert(r5.info.attemptCount === 5, '3. attemptCount=5 on abort');
    assert(r5.info.errorCategory === 'edit-match-fail', '3. category is edit-match-fail');
}

// 4. Reset on different tool — streak broken before detect
{
    const g = createGuard();
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 1);
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 2);
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 3);
    const r4 = feed(g, 'Read', { path: '/x' }, 'Error: ENOENT no such file', 4);
    assert(r4.action === 'continue', '4. different tool resets count');
    assert(g.count === 1, '4. guard count=1 after reset');
}

// 5. Reset on same tool but different error category
{
    const g = createGuard();
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 1);
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 2);
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 3);
    const r4 = feed(g, 'Edit', { old_string: 'foo' }, 'Error: EACCES permission denied', 4);
    assert(r4.action === 'continue', '5. same tool different error resets');
    assert(g.count === 1, '5. guard count=1 after category change');
}

// 6. Edit CRLF / match-fail classification
{
    const cat = _internals.classifyError('Error: old_string did not match in file');
    assert(cat === 'edit-match-fail', '6. edit-match-fail classification');
}

// 7. Rate-limit classification & abort on 5th
{
    const rl = _internals.classifyError('Error: 429 rate limit exceeded');
    assert(rl === 'rate-limit', '7. rate-limit classification');
    const g = createGuard();
    feed(g, 'Bash', { cmd: 'curl' }, 'Error: 429 rate limit exceeded', 1);
    feed(g, 'Bash', { cmd: 'curl' }, 'Error: 429 rate limit exceeded', 2);
    feed(g, 'Bash', { cmd: 'curl' }, 'Error: 429 rate limit exceeded', 3);
    const r4 = feed(g, 'Bash', { cmd: 'curl' }, 'Error: 429 rate limit exceeded', 4);
    const r5 = feed(g, 'Bash', { cmd: 'curl' }, 'Error: 429 rate limit exceeded', 5);
    assert(r4.action === 'detected', '7. rate-limit detect on 4th');
    assert(r5.action === 'abort' && r5.info.errorCategory === 'rate-limit', '7. rate-limit abort on 5th');
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
    const err = new ToolLoopAbortError({
        signature: 'abc',
        toolName: 'Edit',
        errorCategory: 'edit-match-fail',
        attemptCount: 5,
        argsSample: '{}',
        errorSample: 'Error: x',
    });
    assert(err instanceof Error, '9. ToolLoopAbortError is an Error');
    assert(err.name === 'ToolLoopAbortError', '9. name is ToolLoopAbortError');
    assert(err.info.toolName === 'Edit', '9. info preserved');
}

// 10. 3rd identical call: counter=3, no warn, no abort
{
    const g = createGuard();
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 1);
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 2);
    const r3 = feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 3);
    assert(r3.action === 'continue', '10. 3rd identical stays continue under new spec');
    assert(g.count === 3, '10. counter=3 after 3rd identical');
    assert(!r3.warnText, '10. no warnText at count=3');
}

// 11. Args change between 4 and 5 resets counter; warn not re-emitted until next 4-streak
{
    const g = createGuard();
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 1);
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 2);
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 3);
    const r4 = feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 4);
    assert(r4.action === 'detected', '11. detect fires at 4 before args change');
    // Args change → counter must reset, no new warn/abort
    const r5 = feed(g, 'Edit', { old_string: 'BAZ' }, EDIT_ERR, 5);
    assert(r5.action === 'continue', '11. args change resets to continue');
    assert(g.count === 1, '11. counter=1 after args-change reset');
    // Three more same-args failures with the new args — still no warn
    const r6 = feed(g, 'Edit', { old_string: 'BAZ' }, EDIT_ERR, 6);
    const r7 = feed(g, 'Edit', { old_string: 'BAZ' }, EDIT_ERR, 7);
    assert(r6.action === 'continue' && r7.action === 'continue', '11. count 2-3 on new sig stays continue');
    assert(g.count === 3, '11. counter=3 before the new-streak detect');
    // 4th of the NEW streak → detect re-fires (different signature, warnedSig was reset)
    const r8 = feed(g, 'Edit', { old_string: 'BAZ' }, EDIT_ERR, 8);
    assert(r8.action === 'detected', '11. new 4-streak triggers detect again');
    assert(typeof r8.warnText === 'string' && r8.warnText.length > 0, '11. warn re-emitted on new streak');
}

// 12. Success between failures resets counter
{
    const g = createGuard();
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 1);
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 2);
    feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 3);
    const rOk = feed(g, 'Edit', { old_string: 'foo' }, 'OK', 4);
    assert(rOk.action === 'continue', '12. success returns continue');
    assert(g.count === 0, '12. counter reset to 0 on success');
    const r5 = feed(g, 'Edit', { old_string: 'foo' }, EDIT_ERR, 5);
    assert(r5.action === 'continue' && g.count === 1, '12. post-success failure starts fresh');
}

// 13. Warn text phrasing — mentions 4 times & fifth-time abort
{
    const warn = buildSoftWarn({
        toolName: 'Edit',
        signature: 'deadbeefcafebabe',
        errorCategory: 'edit-match-fail',
    });
    assert(warn.includes('4 times in a row'), '13. warn mentions "4 times in a row"');
    assert(warn.includes('a fifth time WILL abort'), '13. warn mentions "a fifth time WILL abort"');
    assert(warn.includes('`Edit`'), '13. warn back-ticks the tool name');
}

console.log(`test-tool-loop-guard: ${passed} pass / ${failed} fail`);
if (failed === 0) console.log(`PASS ${passed}/${passed}`);
process.exit(failed ? 1 : 0);
