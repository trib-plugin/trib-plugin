import { getCachedReadOnlyStat, invalidateBuiltinResultCache } from '../src/agent/orchestrator/tools/builtin.mjs';

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
  let calls = 0;
  const loader = () => {
    calls++;
    return { mtimeMs: 123, size: 10 };
  };
  const a = getCachedReadOnlyStat('/tmp/a', loader, 1000);
  const b = getCachedReadOnlyStat('/tmp/a', loader, 1001);
  assert(a.mtimeMs === 123 && b.mtimeMs === 123, 'cached stat returns loader result');
  assert(calls === 1, 'cached stat only calls loader once within TTL');
}

{
  let calls = 0;
  const loader = () => {
    calls++;
    return { mtimeMs: 456, size: 20 };
  };
  getCachedReadOnlyStat('/tmp/b', loader, 1000);
  getCachedReadOnlyStat('/tmp/b', loader, 7001);
  assert(calls === 2, 'cached stat reloads after TTL expiry');
}

{
  let calls = 0;
  const loader = () => {
    calls++;
    return { mtimeMs: 789, size: 30 };
  };
  getCachedReadOnlyStat('/tmp/c', loader, 1000);
  invalidateBuiltinResultCache();
  getCachedReadOnlyStat('/tmp/c', loader, 1001);
  assert(calls === 2, 'global invalidate clears stat cache too');
}

if (failed > 0) {
  console.error(`test-stat-cache-helpers: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-stat-cache-helpers: ${passed} passed`);
