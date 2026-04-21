import { buildGrepCacheKey, buildGrepRgArgs } from '../src/agent/orchestrator/tools/builtin.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const common = {
  patterns: ['foo', 'bar'],
  searchPath: '.',
  globPatterns: ['*.ts'],
  outputMode: 'content',
  headLimit: 250,
  offset: 0,
  caseInsensitive: false,
  showLineNumbers: true,
  beforeN: null,
  afterN: null,
  contextN: null,
  multilineMode: false,
  fileType: '',
};

{
  const a = buildGrepCacheKey(common);
  const b = buildGrepCacheKey({ ...common, caseInsensitive: true });
  const c = buildGrepCacheKey({ ...common, fileType: 'ts' });
  const d = buildGrepCacheKey({ ...common, multilineMode: true });
  assert(a !== b, 'cache key changes when -i changes');
  assert(a !== c, 'cache key changes when type filter changes');
  assert(a !== d, 'cache key changes when multiline changes');
}

{
  const args = buildGrepRgArgs({
    ...common,
    caseInsensitive: true,
    beforeN: 2,
    afterN: 3,
    contextN: 4,
    multilineMode: true,
    fileType: 'ts',
  });
  assert(args.includes('-i'), 'rg args include -i');
  assert(args.includes('-B') && args.includes('2'), 'rg args include -B');
  assert(args.includes('-A') && args.includes('3'), 'rg args include -A');
  assert(args.includes('-C') && args.includes('4'), 'rg args include -C');
  assert(args.includes('-U') && args.includes('--multiline-dotall'), 'rg args include multiline flags');
  const typeIdx = args.indexOf('--type');
  assert(typeIdx !== -1 && args[typeIdx + 1] === 'ts', 'rg args include --type ts');
}

if (failed > 0) {
  console.error(`test-grep-helpers: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-grep-helpers: ${passed} passed`);
