#!/usr/bin/env node
/**
 * Byte-identity verification for the 4-BP cache layout refactor.
 *
 * Calls composeSystemPrompt with different role names and asserts:
 *   - baseRules     : identical across roles (BP1)
 *   - roleCatalog   : identical across roles (BP2)  ← all role bodies concat
 *   - sessionMarker : MUST differ per role (BP3)
 *   - volatileTail  : may differ per call (BP4 adjacent)
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

// BP3 — sessionMarker MUST differ across roles.
assert(worker.sessionMarker !== reviewer.sessionMarker, 'sessionMarker differs: worker vs reviewer');
assert(worker.sessionMarker !== tester.sessionMarker,  'sessionMarker differs: worker vs tester');
assert(worker.sessionMarker.includes('worker'),       'worker sessionMarker mentions "worker"');
assert(reviewer.sessionMarker.includes('reviewer'),   'reviewer sessionMarker mentions "reviewer"');
assert(tester.sessionMarker.includes('tester'),       'tester sessionMarker mentions "tester"');
assert(worker.sessionMarker.includes('full'),           'worker sessionMarker mentions permission "full"');
assert(reviewer.sessionMarker.includes('read-only'),    'reviewer sessionMarker mentions read-only');

// sessionMarker should include project-context.
assert(worker.sessionMarker.includes('project-context'), 'sessionMarker includes project-context');

// BP4 adjacent — volatileTail identical across roles (same per-call opts).
assert(worker.volatileTail === reviewer.volatileTail, 'volatileTail identical: worker vs reviewer');
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
console.log(`  sessionMarker   : w=${worker.sessionMarker.length}  r=${reviewer.sessionMarker.length}  t=${tester.sessionMarker.length}  (per-role)`);
console.log(`  volatileTail    : ${worker.volatileTail.length} (shared per-call)`);

process.exit(failed > 0 ? 1 : 0);
