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

{
  const { sessionMarker } = composeSystemPrompt({
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
  assert(sessionMarker.includes('# tool-routing'), 'full toolset emits tool-routing section');
  assert(sessionMarker.includes('prefer `apply_patch`'), 'tool-routing mentions apply_patch preference');
  assert(sessionMarker.includes('same shell state'), 'tool-routing mentions persistent bash reuse');
  assert(sessionMarker.includes('code_graph'), 'tool-routing mentions code_graph preference');
}

{
  const { sessionMarker } = composeSystemPrompt({
    role: 'reviewer',
    permission: 'read',
    tools: [
      { name: 'read' },
      { name: 'grep' },
      { name: 'apply_patch' },
      { name: 'bash' },
    ],
    bashIsPersistent: true,
  });
  assert(sessionMarker.includes('# tool-routing'), 'read-only toolset still emits routing section');
  assert(!sessionMarker.includes('prefer `apply_patch`'), 'read-only toolset omits apply_patch preference');
  assert(!sessionMarker.includes('same shell state'), 'read-only toolset omits bash persistence hint');
  assert(sessionMarker.includes('known file -> `read`'), 'read-only toolset keeps read/grep hint');
}

if (failed > 0) {
  console.error(`test-compose-system-prompt: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-compose-system-prompt: ${passed} passed`);
