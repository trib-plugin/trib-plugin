#!/usr/bin/env node
/**
 * Byte-identity verification for the 4-BP cache layout.
 *
 * Calls composeSystemPrompt with different role names and asserts:
 *   - baseRules     : identical across roles (BP1)
 *   - roleCatalog   : identical across roles (BP2)  ← all role bodies + static tool-routing
 *   - sessionMarker : identical across roles when the project is the same (BP3)
 *                     — role/permission moved to volatileTail
 *   - volatileTail  : DIFFERS per role (BP4 carries role + permission + task/memory)
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
});

const reviewer = composeSystemPrompt({
    ...baseOpts,
    role: 'reviewer',
    permission: 'read',
});

const tester = composeSystemPrompt({
    ...baseOpts,
    role: 'tester',
    permission: 'read-write',
});

// BP1 — baseRules identical cross-role.
assert(worker.baseRules === reviewer.baseRules, 'baseRules identical: worker vs reviewer');
assert(worker.baseRules === tester.baseRules,  'baseRules identical: worker vs tester');

// BP2 — roleCatalog identical cross-role (may be '' if no CLAUDE_PLUGIN_ROOT).
assert(worker.roleCatalog === reviewer.roleCatalog, 'roleCatalog identical: worker vs reviewer');
assert(worker.roleCatalog === tester.roleCatalog,  'roleCatalog identical: worker vs tester');

// BP3 — sessionMarker identical cross-role (project-context only, no role/permission/tool-routing).
assert(worker.sessionMarker === reviewer.sessionMarker, 'sessionMarker identical: worker vs reviewer');
assert(worker.sessionMarker === tester.sessionMarker,  'sessionMarker identical: worker vs tester');
assert(worker.sessionMarker.includes('project-context'), 'sessionMarker includes project-context');
assert(!worker.sessionMarker.includes('# role'),        'sessionMarker does NOT carry # role');
assert(!worker.sessionMarker.includes('# permission'),  'sessionMarker does NOT carry # permission');
assert(!worker.sessionMarker.includes('# tool-routing'),'sessionMarker does NOT carry # tool-routing');

// BP4 — volatileTail DIFFERS per role (carries role + permission).
assert(worker.volatileTail !== reviewer.volatileTail, 'volatileTail differs: worker vs reviewer');
assert(worker.volatileTail !== tester.volatileTail,  'volatileTail differs: worker vs tester');
assert(worker.volatileTail.includes('worker'),       'volatileTail names "worker"');
assert(reviewer.volatileTail.includes('reviewer'),   'volatileTail names "reviewer"');
assert(tester.volatileTail.includes('tester'),       'volatileTail names "tester"');
assert(worker.volatileTail.includes('full'),           'worker volatileTail mentions permission "full"');
assert(reviewer.volatileTail.includes('read-only'),    'reviewer volatileTail mentions read-only');
assert(worker.volatileTail.includes('task-brief'),    'volatileTail contains task-brief');
assert(worker.volatileTail.includes('memory-context'), 'volatileTail contains memory-context');

// Sanity — baseRules must NOT contain role-specific text.
assert(!worker.baseRules.includes('worker'), 'baseRules does NOT contain role id');
assert(!worker.baseRules.includes('permission'), 'baseRules does NOT contain permission line');

console.log();
console.log(`PASS ${passed}/${passed + failed}`);
console.log();
console.log('# Sizes (bytes)');
console.log(`  baseRules       : ${worker.baseRules.length} (shared)`);
console.log(`  roleCatalog     : ${worker.roleCatalog.length} (shared)  ${worker.roleCatalog.length === 0 ? '[no CLAUDE_PLUGIN_ROOT → empty]' : ''}`);
console.log(`  sessionMarker   : ${worker.sessionMarker.length} (shared — project-context only)`);
console.log(`  volatileTail    : w=${worker.volatileTail.length}  r=${reviewer.volatileTail.length}  t=${tester.volatileTail.length}  (per-call, carries role+permission+task+memory)`);

process.exit(failed > 0 ? 1 : 0);
