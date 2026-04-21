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
    buildSameToolWarn,
    buildToolFamilyWarn,
    buildToolBudgetWarn,
    setGuardConfigForTesting,
    resetGuardConfigForTesting,
    _internals,
} from '../src/agent/orchestrator/tool-loop-guard.mjs';

// Pin defaults so tests don't pick up whatever override the running
// workspace has in agent-config.json → bridge.toolLoopGuard.
setGuardConfigForTesting();

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

// 14. Same-tool repetition — whitelisted tool fires soft-warn at threshold
{
    const g = createGuard();
    let lastResult;
    // First 11 calls return continue, 12th flips to same_tool_warn.
    for (let i = 1; i <= 12; i++) {
        lastResult = feed(g, 'search', { query: `q${i}` }, `result ${i}`, i);
    }
    assert(lastResult.action === 'same_tool_warn', '14. 12th whitelisted-tool call flips to same_tool_warn');
    assert(lastResult.info?.toolName === 'search', '14. warn info.toolName === "search"');
    assert(lastResult.info?.count === 12, '14. warn info.count === 12');
    assert(typeof lastResult.warnText === 'string' && lastResult.warnText.includes('search'), '14. warnText mentions tool');
}

// 15. Same-tool repetition — warn fires once per tool per session
{
    const g = createGuard();
    for (let i = 1; i <= 12; i++) feed(g, 'recall', { query: `r${i}` }, 'ok', i);
    const r13 = feed(g, 'recall', { query: 'r13' }, 'ok', 13);
    assert(r13.action === 'continue', '15. 13th call returns continue (already warned)');
    const r14 = feed(g, 'recall', { query: 'r14' }, 'ok', 14);
    assert(r14.action === 'continue', '15. 14th call still continue');
}

// 16. Different tool breaks the streak — counter resets
{
    const g = createGuard();
    for (let i = 1; i <= 11; i++) feed(g, 'explore', { query: `e${i}` }, 'ok', i);
    // Intermix with a non-whitelisted tool — streak resets.
    feed(g, 'Read', { path: '/a' }, 'content', 12);
    // Resume explore — count starts from 1 again.
    let last;
    for (let i = 13; i <= 23; i++) last = feed(g, 'explore', { query: `e${i}` }, 'ok', i);
    assert(last.action === 'continue', '16. intermix breaks streak; 11 more explore calls stay continue');
    // 24th is the 12th-in-a-row since reset → fires warn.
    const r24 = feed(g, 'explore', { query: 'e24' }, 'ok', 24);
    assert(r24.action === 'same_tool_warn', '16. fresh 12-streak after reset fires warn');
}

// 17. Read becomes same-tool warn at the tighter read threshold (8)
{
    const g = createGuard();
    let last;
    for (let i = 1; i <= 8; i++) last = feed(g, 'Read', { path: `/p${i}` }, 'content', i);
    assert(last.action === 'same_tool_warn', '17. 8th Read call fires same_tool_warn');
}

// 18. Bash becomes same-tool warn at the shell threshold (10)
{
    const g = createGuard();
    let last;
    for (let i = 1; i <= 10; i++) last = feed(g, 'bash', { command: `echo ${i}` }, 'ok', i);
    assert(last.action === 'same_tool_warn', '18. 10th bash call fires same_tool_warn');
}

// 19. Non-whitelisted tools never fire same-tool warn
{
    const g = createGuard();
    let last;
    for (let i = 1; i <= 30; i++) last = feed(g, 'Write', { path: `/p${i}` }, 'ok', i);
    assert(last.action === 'continue', '19. 30 Write calls never fire same_tool_warn (not whitelisted)');
}

// 20. Same-tool warn text phrasing
{
    const text = buildSameToolWarn({ toolName: 'search', count: 12, abortThreshold: 24 });
    assert(text.includes('`search`'), '20. warn back-ticks tool name');
    assert(text.includes('12 times'), '20. warn mentions call count');
    assert(text.includes('24 repeated'), '20. warn mentions hard stop threshold');
    assert(text.includes('Advisory only'), '20. warn marks itself advisory (non-blocking)');
    const bashText = buildSameToolWarn({ toolName: 'bash', count: 10, abortThreshold: 20 });
    assert(bashText.includes('bash_session'), '20. bash warn points to bash_session');
    const readText = buildSameToolWarn({ toolName: 'read', count: 8 });
    assert(readText.includes('offset') && readText.includes('limit'), '20. read warn points to offset/limit reads');
}

// 21. Mixed structure probes fire a family advisory toward code_graph
{
    const g = createGuard();
    let last;
    const seq = [
        ['read', { path: '/a' }],
        ['grep', { pattern: 'X' }],
        ['glob', { pattern: '*.js' }],
        ['list', { path: '/src' }],
        ['read', { path: '/b' }],
        ['grep', { pattern: 'Y' }],
        ['glob', { pattern: '*.ts' }],
        ['list', { path: '/pkg' }],
        ['read', { path: '/c' }],
        ['grep', { pattern: 'Z' }],
    ];
    for (let i = 0; i < seq.length; i++) last = feed(g, seq[i][0], seq[i][1], 'ok', i + 1);
    assert(last.action === 'family_warn', '21. mixed structure tools trigger family_warn');
    assert(last.warnText.includes('`code_graph`'), '21. structure family warn points to code_graph');
}

// 22. Repeated edit roundtrips fire a family advisory toward apply_patch
{
    const g = createGuard();
    let last;
    const seq = [
        ['edit', { path: '/a', old_string: 'x', new_string: 'y' }],
        ['multi_edit', { path: '/a', edits: [] }],
        ['edit_lines', { path: '/a', start_line: 1, end_line: 1, new_content: 'x' }],
        ['edit', { path: '/b', old_string: 'x', new_string: 'y' }],
        ['batch_edit', { edits: [] }],
    ];
    for (let i = 0; i < seq.length; i++) last = feed(g, seq[i][0], seq[i][1], 'ok', i + 1);
    assert(last.action === 'family_warn', '22. edit roundtrip tools trigger family_warn');
    assert(last.warnText.includes('`apply_patch`'), '22. edit family warn points to apply_patch');
}

// 23. Family warn text phrasing
{
    const text = buildToolFamilyWarn({ familyKey: 'structure_probe', count: 10, tools: ['read', 'grep'] });
    assert(text.includes('10 consecutive'), '23. family warn mentions streak count');
    assert(text.includes('`code_graph`'), '23. structure family warn names code_graph');
    const editText = buildToolFamilyWarn({ familyKey: 'edit_roundtrip', count: 5, tools: ['edit', 'multi_edit'] });
    assert(editText.includes('`apply_patch`'), '23. edit family warn names apply_patch');
    assert(editText.includes('Advisory only'), '23. family warn marks itself advisory');
}

// 24. Total tool budget warns at 24 and 48 calls
{
    const g = createGuard();
    let r24 = null;
    for (let i = 1; i <= 24; i++) r24 = feed(g, 'write', { path: `/tmp/${i}` }, 'ok', i);
    assert(r24.action === 'budget_warn', '24. 24th overall tool call fires budget_warn');
    assert(r24.warnText.includes('24 tool calls'), '24. budget warn mentions the current call count');
    let r25 = feed(g, 'write', { path: '/tmp/25' }, 'ok', 25);
    assert(r25.action === 'continue', '24. 25th call continues (24-threshold warned once)');
    let r48 = null;
    for (let i = 26; i <= 48; i++) r48 = feed(g, 'write', { path: `/tmp/${i}` }, 'ok', i);
    assert(r48.action === 'budget_warn', '24. 48th overall tool call fires second budget_warn');
}

// 25. Budget warn text phrasing
{
    const text = buildToolBudgetWarn({ count: 24, threshold: 24, abortThreshold: 60 });
    assert(text.includes('24 tool calls'), '25. budget warn mentions tool-call count');
    assert(text.includes('`code_graph`') && text.includes('`apply_patch`') && text.includes('`bash_session`'), '25. budget warn points to up-level tools');
    assert(text.includes('60 total tool calls'), '25. budget warn mentions hard stop threshold');
    assert(text.includes('Advisory only'), '25. budget warn marks itself advisory');
}

// 26. job_status becomes same-tool warn quickly to steer polling toward job_wait
{
    const g = createGuard();
    let last;
    for (let i = 1; i <= 3; i++) last = feed(g, 'job_status', { job_id: 'job_1' }, 'ok', i);
    assert(last.action === 'same_tool_warn', '26. 3rd job_status call fires same_tool_warn');
    assert(last.warnText.includes('`job_wait`'), '26. job_status warn points to job_wait');
}

// 27. Config overrides retune thresholds for testing / future auto-tuning
{
    setGuardConfigForTesting({
        detectThreshold: 3,
        abortThreshold: 4,
        sameToolThresholds: { read: 2 },
        sameToolAbortThresholds: { read: 4 },
        totalToolWarnThresholds: [5],
        totalToolAbortThresholds: [7],
    });
    try {
        const g1 = createGuard();
        const d3 = feed(g1, 'edit', { old_string: 'x' }, EDIT_ERR, 1);
        const d4 = feed(g1, 'edit', { old_string: 'x' }, EDIT_ERR, 2);
        const d5 = feed(g1, 'edit', { old_string: 'x' }, EDIT_ERR, 3);
        const d6 = feed(g1, 'edit', { old_string: 'x' }, EDIT_ERR, 4);
        assert(d3.action === 'continue' && d4.action === 'continue', '27. custom detect threshold still allows early calls');
        assert(d5.action === 'detected', '27. custom detect threshold applies');
        assert(d6.action === 'abort', '27. custom abort threshold applies');

        const g2 = createGuard();
        const r1 = feed(g2, 'read', { path: '/a' }, 'ok', 1);
        const r2 = feed(g2, 'read', { path: '/b' }, 'ok', 2);
        const r3 = feed(g2, 'read', { path: '/c' }, 'ok', 3);
        const r4 = feed(g2, 'read', { path: '/d' }, 'ok', 4);
        assert(r1.action === 'continue' && r2.action === 'same_tool_warn', '27. custom same-tool threshold applies');
        assert(r3.action === 'continue' && r4.action === 'abort', '27. custom same-tool abort threshold applies');

        const g3 = createGuard();
        let budget = null;
        for (let i = 1; i <= 5; i++) budget = feed(g3, 'write', { path: `/tmp/${i}` }, 'ok', i);
        assert(budget.action === 'budget_warn', '27. custom total-tool threshold applies');
        let budgetAbort = null;
        for (let i = 6; i <= 7; i++) budgetAbort = feed(g3, 'write', { path: `/tmp/${i}` }, 'ok', i);
        assert(budgetAbort.action === 'abort', '27. custom total-tool abort threshold applies');
    } finally {
        resetGuardConfigForTesting();
    }
}

// 28. Default same-tool success repetition hard-aborts at 2x warn threshold
{
    const g = createGuard();
    let last;
    for (let i = 1; i <= 20; i++) last = feed(g, 'bash_session', { command: `echo ${i}` }, 'ok', i);
    assert(last.action === 'abort', '28. 20th bash_session call hard-aborts');
    assert(last.info?.toolName === 'bash_session', '28. same-tool abort retains tool name');
    assert(String(last.info?.errorCategory || '').includes('same-tool-repeat@20'), '28. same-tool abort category carries threshold');
}

// 29. Default total budget hard-aborts at 60 calls
{
    const g = createGuard();
    let last = null;
    for (let i = 1; i <= 60; i++) last = feed(g, 'write', { path: `/tmp/${i}` }, 'ok', i);
    assert(last.action === 'abort', '29. 60th tool call hard-aborts on total budget');
    assert(String(last.info?.errorCategory || '').includes('tool-budget@60'), '29. budget abort category carries threshold');
    assert(last.info?.attemptCount === 60, '29. budget abort reports total call count');
}

console.log(`test-tool-loop-guard: ${passed} pass / ${failed} fail`);
if (failed === 0) console.log(`PASS ${passed}/${passed}`);
process.exit(failed ? 1 : 0);
