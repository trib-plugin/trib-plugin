import { buildGlobCacheKey, buildListCacheKey } from '../src/agent/orchestrator/tools/builtin.mjs';

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
  const a = buildGlobCacheKey({ patterns: ['*.ts'], basePath: '.' });
  const b = buildGlobCacheKey({ patterns: ['*.js'], basePath: '.' });
  const c = buildGlobCacheKey({ patterns: ['*.ts'], basePath: './src' });
  assert(a !== b, 'glob cache key changes when pattern changes');
  assert(a !== c, 'glob cache key changes when base path changes');
}

{
  const base = {
    mode: 'list',
    inputPath: '.',
    depth: 1,
    hidden: false,
    sort: 'name',
    typeFilter: 'any',
    headLimit: 200,
  };
  const a = buildListCacheKey(base);
  const b = buildListCacheKey({ ...base, hidden: true });
  const c = buildListCacheKey({ ...base, sort: 'mtime' });
  const d = buildListCacheKey({ ...base, mode: 'find', namePattern: '*.ts' });
  assert(a !== b, 'list cache key changes when hidden changes');
  assert(a !== c, 'list cache key changes when sort changes');
  assert(a !== d, 'list cache key changes when mode/namePattern changes');
}

if (failed > 0) {
  console.error(`test-list-glob-cache-helpers: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-list-glob-cache-helpers: ${passed} passed`);
