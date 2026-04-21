import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  executeBuiltinTool,
  invalidateBuiltinResultCache,
  resetBuiltinCacheStatsForTesting,
  getBuiltinCacheStatsForTesting,
} from '../src/agent/orchestrator/tools/builtin.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'trib-builtin-cache-'));
try {
  mkdirSync(join(root, 'one'), { recursive: true });
  mkdirSync(join(root, 'two'), { recursive: true });
  writeFileSync(join(root, 'one', 'a.txt'), 'short\n', 'utf8');
  writeFileSync(join(root, 'two', 'b.txt'), 'keep\n', 'utf8');

  invalidateBuiltinResultCache();
  resetBuiltinCacheStatsForTesting();

  await executeBuiltinTool('list', { path: join(root, 'one') }, root);
  await executeBuiltinTool('list', { path: join(root, 'two') }, root);
  await executeBuiltinTool('list', { path: join(root, 'one') }, root);
  await executeBuiltinTool('list', { path: join(root, 'two') }, root);
  const warmStats = getBuiltinCacheStatsForTesting();

  assert(warmStats.hits >= 2, `cache warms for both directories (got ${JSON.stringify(warmStats)})`);

  const writeResult = await executeBuiltinTool('write', {
    path: join(root, 'one', 'a.txt'),
    content: 'this content is definitely longer now\n',
  }, root);
  const afterWrite = getBuiltinCacheStatsForTesting();

  assert(/Written:/.test(writeResult), `write succeeds (got ${JSON.stringify(writeResult)})`);
  assert(afterWrite.pathInvalidations >= 1 && afterWrite.globalInvalidations === 0, `write uses path-scoped invalidation (got ${JSON.stringify(afterWrite)})`);

  const oneList = await executeBuiltinTool('list', { path: join(root, 'one') }, root);
  const afterOne = getBuiltinCacheStatsForTesting();
  const twoList = await executeBuiltinTool('list', { path: join(root, 'two') }, root);
  const afterTwo = getBuiltinCacheStatsForTesting();
  const oneSize = Number((oneList.split('\n')[0] || '').split('\t')[2] || 0);

  assert(afterOne.misses > afterWrite.misses, `changed directory cache is invalidated and rebuilt (got ${JSON.stringify({ afterWrite, afterOne })})`);
  assert(afterTwo.hits > afterOne.hits, `unrelated directory cache survives write and still hits (got ${JSON.stringify({ afterOne, afterTwo })})`);
  assert(oneList.includes('a.txt') && oneSize > 6, `changed directory shows updated size (got ${JSON.stringify(oneList)})`);
  assert(twoList.includes('b.txt'), `unrelated directory still lists cached file (got ${JSON.stringify(twoList)})`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-builtin-path-cache-invalidation: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-builtin-path-cache-invalidation: ${passed} passed`);
