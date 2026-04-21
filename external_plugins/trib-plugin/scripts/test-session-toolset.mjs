import { initProviders } from '../src/agent/orchestrator/providers/registry.mjs';
import { createSession, closeSession } from '../src/agent/orchestrator/session/manager.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

await initProviders({
  local: { enabled: true, baseURL: 'http://localhost:8080/v1' },
});

const session = createSession({
  provider: 'local',
  model: 'default',
  owner: 'bridge',
  cwd: '/mnt/c/Project',
  tools: 'full',
});

try {
  assert(session.tools.some((t) => t.name === 'bash'), 'bridge full toolset includes bash');
  assert(session.tools.some((t) => t.name === 'bash_session'), 'bridge full toolset includes bash_session');
  assert(session.tools.some((t) => t.name === 'apply_patch'), 'bridge full toolset includes apply_patch');
  assert(session.tools.some((t) => t.name === 'code_graph'), 'bridge full toolset includes code_graph');
  assert(session.tools.some((t) => t.name === 'rename_symbol_refs'), 'bridge full toolset includes rename_symbol_refs');
  assert(session.tools.some((t) => t.name === 'rename_file_refs'), 'bridge full toolset includes rename_file_refs');
  assert(session.tools.some((t) => t.name === 'read'), 'bridge full toolset still includes read');
} finally {
  closeSession(session.id);
}

if (failed > 0) {
  console.error(`test-session-toolset: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-session-toolset: ${passed} passed`);
