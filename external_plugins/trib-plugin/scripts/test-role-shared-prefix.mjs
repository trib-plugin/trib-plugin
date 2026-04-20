#!/usr/bin/env node
/**
 * Byte-identity verification for the cross-role shared-prefix refactor.
 *
 * Calls composeSystemPrompt with two different role names and asserts that
 * systemBase and tier3Reminder are bit-identical. roleMarker MUST differ
 * (that's the whole point of the split).
 */
import { composeSystemPrompt } from '../src/agent/orchestrator/context/collect.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  ok  ' + msg); }
    else       { failed++; console.error('  FAIL ' + msg); }
}

const baseOpts = {
    userPrompt: '# Shared base\nYou are an assistant in a test harness.',
    bridgeRules: '# Rules\nFollow user instructions.',
    hasSkills: false,
    taskBrief: 'Test task brief — same for all roles.',
    projectContext: '# Project\nStable project context.',
    memoryContext: '# Memory\nStable memory snippet.',
};

const worker = composeSystemPrompt({
    ...baseOpts,
    role: 'worker',
    permission: 'full',
    roleTemplate: { description: 'Code implementation agent.', body: 'Execute tasks with full access. Worker-specific body text.' },
});

const reviewer = composeSystemPrompt({
    ...baseOpts,
    role: 'reviewer',
    permission: 'read',
    roleTemplate: { description: 'Read-only PR review.', body: 'Analyze against standards. Reviewer-specific body text.' },
});

const tester = composeSystemPrompt({
    ...baseOpts,
    role: 'tester',
    permission: 'read-write',
    roleTemplate: { description: 'Runtime testing.', body: 'Execute and observe. Tester-specific body text.' },
});

// The core invariant: BP1 (systemBase) + BP3 (tier3Reminder) must be
// byte-identical across roles. Only roleMarker is allowed to vary.
assert(worker.systemBase === reviewer.systemBase, 'systemBase identical: worker vs reviewer');
assert(worker.systemBase === tester.systemBase,  'systemBase identical: worker vs tester');
assert(worker.tier3Reminder === reviewer.tier3Reminder, 'tier3Reminder identical: worker vs reviewer');
assert(worker.tier3Reminder === tester.tier3Reminder,  'tier3Reminder identical: worker vs tester');

// roleMarker MUST differ (role signature lives here now).
assert(worker.roleMarker !== reviewer.roleMarker, 'roleMarker differs: worker vs reviewer');
assert(worker.roleMarker !== tester.roleMarker,  'roleMarker differs: worker vs tester');
assert(worker.roleMarker.includes('worker'),   'worker roleMarker contains "worker"');
assert(reviewer.roleMarker.includes('reviewer'), 'reviewer roleMarker contains "reviewer"');
assert(tester.roleMarker.includes('tester'),   'tester roleMarker contains "tester"');

// Sanity: tier3 should contain task-brief / project-context, NOT role body.
assert(worker.tier3Reminder.includes('task-brief'), 'tier3 contains task-brief');
assert(!worker.tier3Reminder.includes('Worker-specific body text'), 'tier3 does NOT contain role body (worker)');
assert(!reviewer.tier3Reminder.includes('Reviewer-specific body text'), 'tier3 does NOT contain role body (reviewer)');

// Sanity: roleMarker should contain the role body and permission.
assert(worker.roleMarker.includes('Worker-specific body text'), 'worker roleMarker contains body');
assert(worker.roleMarker.includes('full'), 'worker roleMarker contains permission "full"');
assert(reviewer.roleMarker.includes('read-only'), 'reviewer roleMarker mentions read-only');

console.log();
console.log(`PASS ${passed}/${passed + failed}`);
console.log();
console.log(`# Sizes (bytes)`);
console.log(`  systemBase    : ${worker.systemBase.length} (shared)`);
console.log(`  tier3Reminder : ${worker.tier3Reminder.length} (shared)`);
console.log(`  roleMarker:`);
console.log(`    worker   ${worker.roleMarker.length}`);
console.log(`    reviewer ${reviewer.roleMarker.length}`);
console.log(`    tester   ${tester.roleMarker.length}`);

process.exit(failed > 0 ? 1 : 0);
