import { initProviders } from '../src/agent/orchestrator/providers/registry.mjs';
import { createSession, closeSession, getSession } from '../src/agent/orchestrator/session/manager.mjs';
import { closeBashSession, executeBashSessionTool } from '../src/agent/orchestrator/tools/bash-session.mjs';
import { saveSession } from '../src/agent/orchestrator/session/store.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

function extractId(response) {
  const m = /\[session: ([^\]\r\n]+)\]/.exec(response || '');
  return m ? m[1] : null;
}

await initProviders({
  local: { enabled: true, baseURL: 'http://localhost:8080/v1' },
});

const bridgeSession = createSession({
  provider: 'local',
  model: 'default',
  owner: 'bridge',
  cwd: '/mnt/c/Project',
  tools: 'full',
});

try {
  const shellRes = await executeBashSessionTool('bash_session', { command: 'export CLEANUP_TAG=live && echo ok' }, '/mnt/c/Project');
  const shellId = extractId(shellRes);
  assert(!!shellId, 'bash_session minted shell id');
  bridgeSession.implicitBashSessionId = shellId;
  saveSession(bridgeSession, { expectedGeneration: bridgeSession.generation });
  assert(getSession(bridgeSession.id)?.implicitBashSessionId === shellId, 'bridge session persists implicit shell id');
  closeSession(bridgeSession.id);
  const reused = await executeBashSessionTool('bash_session', { session_id: shellId, command: 'echo "${CLEANUP_TAG:-missing}"', close: true }, '/mnt/c/Project');
  assert(/missing/.test(reused), 'closed bridge session also closed implicit bash session');
} finally {
  if (bridgeSession?.implicitBashSessionId) {
    try { closeBashSession(bridgeSession.implicitBashSessionId, 'test-finally'); } catch {}
  }
}

if (failed > 0) {
  console.error(`test-bridge-bash-cleanup: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-bridge-bash-cleanup: ${passed} passed`);
