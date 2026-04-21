import { buildBridgeBashSessionArgs } from '../src/agent/orchestrator/session/loop.mjs';

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
  const res = buildBridgeBashSessionArgs({ command: 'pwd' }, { owner: 'bridge', implicitBashSessionId: null });
  assert(res === null, 'plain bridge bash stays one-shot without persistent/session_id');
}

{
  const res = buildBridgeBashSessionArgs({ command: 'pwd', persistent: true }, { owner: 'bridge', implicitBashSessionId: null });
  assert(res && res.command === 'pwd' && !('persistent' in res), 'persistent:true routes through bash_session and strips flag');
  assert(!res.session_id, 'first persistent bash call mints a fresh bash_session');
}

{
  const res = buildBridgeBashSessionArgs(
    { command: 'echo hi', persistent: true },
    { owner: 'bridge', implicitBashSessionId: 'sess_abc' },
  );
  assert(res && res.session_id === 'sess_abc', 'persistent:true reuses implicit bash session id when present');
}

{
  const res = buildBridgeBashSessionArgs(
    { command: 'echo hi', session_id: 'sess_explicit' },
    { owner: 'bridge', implicitBashSessionId: 'sess_implicit' },
  );
  assert(res && res.session_id === 'sess_explicit', 'explicit session_id wins over implicit bridge shell id');
}

{
  const res = buildBridgeBashSessionArgs({ command: 'pwd', persistent: true }, { owner: 'user', implicitBashSessionId: 'sess_abc' });
  assert(res === null, 'non-bridge sessions never auto-route bash to bash_session');
}

console.log(`test-bridge-bash-routing: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
