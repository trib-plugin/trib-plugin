import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const root = mkdtempSync(join(tmpdir(), 'trib-aiwrapped-cache-'));
process.env.CLAUDE_PLUGIN_DATA = root;
mkdirSync(root, { recursive: true });
const { _internals } = await import('../src/agent/orchestrator/ai-wrapped-dispatch.mjs');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

_internals.resetQueryCachesForTesting();

{
  const key = _internals.buildQueryCacheKey('explore', 'find router', '/tmp/project', true);
  assert(key.includes('explore') && key.includes('/tmp/project'), 'cache key includes tool and cwd');
}

{
  const a = _internals.normalizeQueryForCache(' find   router ');
  const b = _internals.normalizeQueryForCache('find router');
  assert(a === b, 'query normalization collapses whitespace variance');
  const c = _internals.normalizeQueryForCache('“find router”？');
  const d = _internals.normalizeQueryForCache('"find router"?');
  assert(c === d, 'query normalization normalizes common punctuation variants');
}

{
  let calls = 0;
  const key = _internals.buildQueryCacheKey('recall', 'what did we decide', null, true);
  const first = await _internals.runCachedQuery('recall', key, async () => {
    calls++;
    return 'answer-1';
  });
  const second = await _internals.runCachedQuery('recall', key, async () => {
    calls++;
    return 'answer-2';
  });
  assert(first === 'answer-1' && second === 'answer-1', 'cached query returns first result');
  assert(calls === 1, 'cached query runs underlying call once');
}

{
  _internals.resetQueryCachesForTesting();
  let calls = 0;
  const key = _internals.buildQueryCacheKey('search', 'latest docs', null, true);
  const p1 = _internals.runCachedQuery('search', key, async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return 'search-result';
  });
  const p2 = _internals.runCachedQuery('search', key, async () => {
    calls++;
    return 'other';
  });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert(r1 === 'search-result' && r2 === 'search-result', 'inflight dedupe shares same promise result');
  assert(calls === 1, 'inflight dedupe runs underlying call once');
}

{
  _internals.resetQueryCachesForTesting();
  const key = _internals.buildQueryCacheKey('search', 'latest docs', null, true);
  _internals._queryResultCache.set(key, { ts: Date.now() - 31_000, content: 'stale' });
  const cached = _internals.getCachedQueryResult('search', key, Date.now());
  assert(cached === null, 'expired search cache entry is dropped after TTL');
}

{
  _internals.resetQueryCachesForTesting();
  const key = _internals.buildQueryCacheKey('explore', 'disk cache test', '/tmp/project', true);
  const path = join(root, 'aiwrapped-query-cache.json');
  writeFileSync(path, JSON.stringify({
    [key]: {
      ts: Date.now(),
      content: 'disk-hit',
    },
  }), 'utf8');
  _internals.ensureDiskCacheLoaded(Date.now());
  const cached = _internals.getCachedQueryResult('explore', key, Date.now());
  assert(cached === 'disk-hit', 'disk cache is loaded into memory cache');
}

if (failed > 0) {
  console.error(`test-aiwrapped-cache: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-aiwrapped-cache: ${passed} passed`);
rmSync(root, { recursive: true, force: true });
