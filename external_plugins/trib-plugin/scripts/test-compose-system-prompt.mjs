/**
 * Slot assignment check for composeSystemPrompt.
 *
 * role / permission must now live in volatileTail (BP4), not sessionMarker (BP3).
 * Tool-routing must NOT be generated per-call — it's a static snippet loaded
 * into roleCatalog (BP2) via rules/bridge/02-tool-routing.md.
 */
import { composeSystemPrompt } from '../src/agent/orchestrator/context/collect.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

// full permission — role + permission in volatileTail, nothing tool-routing in sessionMarker.
{
  const { sessionMarker, volatileTail } = composeSystemPrompt({
    role: 'worker',
    permission: 'full',
    tools: [
      { name: 'read' },
      { name: 'grep' },
      { name: 'apply_patch' },
      { name: 'bash' },
      { name: 'code_graph' },
    ],
    bashIsPersistent: true,
  });
  assert(!sessionMarker.includes('# tool-routing'), 'sessionMarker has no tool-routing (moved to BP2)');
  assert(!sessionMarker.includes('# role'),         'sessionMarker has no # role (moved to BP4)');
  assert(!sessionMarker.includes('# permission'),   'sessionMarker has no # permission (moved to BP4)');
  assert(volatileTail.includes('# role\nworker'),    'volatileTail carries # role worker');
  assert(volatileTail.includes('# permission\nfull'),'volatileTail carries # permission full');
}

// read-only — permission label is "read-only ..." in volatileTail.
{
  const { sessionMarker, volatileTail } = composeSystemPrompt({
    role: 'reviewer',
    permission: 'read',
  });
  assert(!sessionMarker.includes('# tool-routing'), 'read-only sessionMarker has no tool-routing');
  assert(!sessionMarker.includes('# role'),         'read-only sessionMarker has no # role');
  assert(volatileTail.includes('# role\nreviewer'),  'volatileTail carries # role reviewer');
  assert(volatileTail.includes('read-only'),         'volatileTail carries read-only permission label');
}

// skipRoleReminder (Pool C) — no # role line.
{
  const { volatileTail } = composeSystemPrompt({
    role: 'cycle1-agent',
    permission: 'read',
    skipRoleReminder: true,
  });
  assert(!volatileTail.includes('# role'), 'Pool C skipRoleReminder suppresses # role in volatileTail');
  assert(volatileTail.includes('read-only'), 'Pool C still carries permission in volatileTail');
}

// projectContext → sessionMarker (only thing in BP3 now).
{
  const { sessionMarker } = composeSystemPrompt({
    role: 'worker',
    permission: 'full',
    projectContext: '# Project\nTest project details.',
  });
  assert(sessionMarker.includes('# project-context'), 'projectContext lands in sessionMarker');
  assert(sessionMarker.includes('Test project details'), 'projectContext body preserved');
}

// No projectContext → sessionMarker empty.
{
  const { sessionMarker } = composeSystemPrompt({
    role: 'worker',
    permission: 'full',
  });
  assert(sessionMarker === '', 'sessionMarker empty when no projectContext');
}

if (failed > 0) {
  console.error(`test-compose-system-prompt: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-compose-system-prompt: ${passed} passed`);
