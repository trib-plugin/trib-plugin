import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _internals } from '../scripts/run-all-tests.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'trib-run-tests-'));
try {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'leaf.mjs'), 'export const leaf = 1\n', 'utf8');
  writeFileSync(join(root, 'src', 'middle.mjs'), "import './leaf.mjs'\nexport const middle = 1\n", 'utf8');
  writeFileSync(join(root, 'src', 'other.mjs'), 'export const other = 1\n', 'utf8');
  writeFileSync(join(root, 'scripts', 'test-alpha.mjs'), "import '../src/middle.mjs'\nconsole.log('alpha')\n", 'utf8');
  writeFileSync(join(root, 'scripts', 'test-beta.mjs'), "import '../src/other.mjs'\nconsole.log('beta')\n", 'utf8');

  const graph = _internals.buildReverseImportGraph(root);
  const fromLeaf = _internals.selectChangedTestsFromGraph(root, ['src/leaf.mjs'], graph);
  const fromOther = _internals.selectChangedTestsFromGraph(root, ['src/other.mjs'], graph);
  const fromTest = _internals.selectChangedTestsFromGraph(root, ['scripts/test-beta.mjs'], graph);

  assert(fromLeaf.length === 1 && fromLeaf[0] === 'test-alpha.mjs', `changed leaf selects only dependent test via reverse import graph (got ${JSON.stringify(fromLeaf)})`);
  assert(fromOther.length === 1 && fromOther[0] === 'test-beta.mjs', `changed direct import selects matching test (got ${JSON.stringify(fromOther)})`);
  assert(fromTest.length === 1 && fromTest[0] === 'test-beta.mjs', `changed test script selects itself (got ${JSON.stringify(fromTest)})`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-run-all-tests-changed: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-run-all-tests-changed: ${passed} passed`);
