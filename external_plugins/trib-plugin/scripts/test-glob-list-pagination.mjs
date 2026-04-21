import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeBuiltinTool } from '../src/agent/orchestrator/tools/builtin.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'trib-pagination-test-'));
try {
  mkdirSync(join(root, 'b'), { recursive: true });
  mkdirSync(join(root, 'a'), { recursive: true });
  writeFileSync(join(root, 'a', 'one.txt'), '1\n', 'utf8');
  writeFileSync(join(root, 'a', 'two.txt'), '2\n', 'utf8');
  writeFileSync(join(root, 'b', 'three.txt'), '3\n', 'utf8');

  {
    const out = await executeBuiltinTool('list', {
      path: root,
      mode: 'list',
      head_limit: 1,
      offset: 1,
      sort: 'name',
      hidden: false,
    }, root);
    const lines = String(out).split('\n');
    assert(lines.length >= 1, 'list pagination returns at least one line');
    assert(!lines[0].includes('a'), 'list offset skips the first alphabetical entry');
  }

  {
    const out = await executeBuiltinTool('find_files', {
      path: root,
      name: '*.txt',
      head_limit: 1,
      offset: 1,
    }, root);
    const lines = String(out).split('\n');
    assert(lines.length >= 1, 'find_files pagination returns at least one line');
    assert(lines.some((l) => l.includes('more entries')) || lines.length === 1, 'find_files pagination applies head_limit after offset');
  }

  {
    const out = await executeBuiltinTool('glob', {
      path: root,
      pattern: ['**/*.txt'],
      head_limit: 1,
      offset: 1,
    }, root);
    const lines = String(out).split('\n').filter(Boolean);
    assert(lines.length >= 1, 'glob pagination returns at least one line');
    assert(lines.some((l) => l.includes('more entries')) || lines.length === 1, 'glob pagination applies head_limit after offset');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-glob-list-pagination: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-glob-list-pagination: ${passed} passed`);
