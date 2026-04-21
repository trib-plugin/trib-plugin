import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeCodeGraphTool } from '../src/agent/orchestrator/tools/code-graph.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'trib-rename-symbol-'));
try {
  mkdirSync(join(root, 'pkg'), { recursive: true });
  writeFileSync(join(root, 'pkg', 'mod.py'), 'class Worker:\n    pass\n', 'utf8');
  writeFileSync(
    join(root, 'main.py'),
    'from pkg.mod import Worker\nprint(Worker)  # Worker comment\nlabel = "Worker literal"\n',
    'utf8',
  );

  const preview = await executeCodeGraphTool('rename_symbol_refs', {
    file: join(root, 'pkg', 'mod.py'),
    symbol: 'Worker',
    new_name: 'AgentWorker',
  }, root);

  assert(/rename_symbol_refs preview/.test(preview), 'preview header returned');
  assert(/confidence=high|confidence=medium/.test(preview), `preview includes confidence (got ${JSON.stringify(preview)})`);
  assert(/declarations=\d+/.test(preview), `preview includes declaration count (got ${JSON.stringify(preview)})`);
  assert(preview.includes('pkg/mod.py') && preview.includes('main.py'), `preview mentions affected files (got ${JSON.stringify(preview)})`);
  assert(!preview.includes('AgentWorker comment'), `preview does not rewrite inline comments (got ${JSON.stringify(preview)})`);
  assert(!preview.includes('AgentWorker literal'), `preview does not rewrite string literals (got ${JSON.stringify(preview)})`);

  const applied = await executeCodeGraphTool('rename_symbol_refs', {
    file: join(root, 'pkg', 'mod.py'),
    symbol: 'Worker',
    new_name: 'AgentWorker',
    apply: true,
  }, root);
  const mainText = readFileSync(join(root, 'main.py'), 'utf8');
  const modText = readFileSync(join(root, 'pkg', 'mod.py'), 'utf8');

  assert(/rename_symbol_refs applied/.test(applied), `apply header returned (got ${JSON.stringify(applied)})`);
  assert(modText.includes('class AgentWorker'), `declaration renamed in source file (got ${JSON.stringify(modText)})`);
  assert(mainText.includes('from pkg.mod import AgentWorker'), `import renamed in consumer file (got ${JSON.stringify(mainText)})`);
  assert(mainText.includes('print(AgentWorker)  # Worker comment'), `code rename preserves inline comment text (got ${JSON.stringify(mainText)})`);
  assert(mainText.includes('label = "Worker literal"'), `string literal preserved during apply (got ${JSON.stringify(mainText)})`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-rename-symbol-refs: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-rename-symbol-refs: ${passed} passed`);
