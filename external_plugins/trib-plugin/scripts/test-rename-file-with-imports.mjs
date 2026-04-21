import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

const root = mkdtempSync(join(tmpdir(), 'trib-rename-file-'));
try {
  mkdirSync(join(root, 'src', 'lib'), { recursive: true });
  mkdirSync(join(root, 'src', 'feature'), { recursive: true });
  mkdirSync(join(root, 'pyproj', 'pkg'), { recursive: true });
  mkdirSync(join(root, 'cpp'), { recursive: true });
  writeFileSync(join(root, 'src', 'lib', 'dep.ts'), 'export const dep = 1;\n', 'utf8');
  writeFileSync(
    join(root, 'src', 'lib', 'old.ts'),
    "import { dep } from './dep';\nexport const value = dep;\n",
    'utf8',
  );
  writeFileSync(
    join(root, 'src', 'feature', 'use.ts'),
    "import { value } from '../lib/old';\nconsole.log(value);\n",
    'utf8',
  );

  const preview = await executeCodeGraphTool('rename_file_refs', {
    file: join(root, 'src', 'lib', 'old.ts'),
    new_path: join(root, 'src', 'feature', 'renamed.ts'),
  }, root);

  assert(/rename_file_refs preview/.test(preview), 'preview header returned');
  assert(preview.includes('move src/lib/old.ts -> src/feature/renamed.ts'), `move summary present (got ${JSON.stringify(preview)})`);
  assert(preview.includes('update importer src/feature/use.ts'), `importer update summary present (got ${JSON.stringify(preview)})`);
  assert(preview.includes('src/lib/old.ts') && preview.includes('src/feature/renamed.ts'), 'patch preview references old and new paths');

  writeFileSync(join(root, 'pyproj', 'pkg', '__init__.py'), '', 'utf8');
  writeFileSync(join(root, 'pyproj', 'pkg', 'dep.py'), 'VALUE = 1\n', 'utf8');
  writeFileSync(join(root, 'pyproj', 'pkg', 'old.py'), 'from .dep import VALUE\n', 'utf8');
  writeFileSync(join(root, 'pyproj', 'main.py'), 'from pyproj.pkg.old import VALUE\n', 'utf8');
  const pyPreview = await executeCodeGraphTool('rename_file_refs', {
    file: join(root, 'pyproj', 'pkg', 'old.py'),
    new_path: join(root, 'pyproj', 'pkg', 'renamed.py'),
  }, root);
  assert(pyPreview.includes('move pyproj/pkg/old.py -> pyproj/pkg/renamed.py'), `python move summary present (got ${JSON.stringify(pyPreview)})`);
  assert(pyPreview.includes('update importer pyproj/main.py'), `python importer update present (got ${JSON.stringify(pyPreview)})`);

  writeFileSync(join(root, 'cpp', 'dep.h'), '#pragma once\n', 'utf8');
  writeFileSync(join(root, 'cpp', 'old.h'), '#include "dep.h"\n', 'utf8');
  writeFileSync(join(root, 'cpp', 'use.cpp'), '#include "old.h"\nint main() {}\n', 'utf8');
  const cppPreview = await executeCodeGraphTool('rename_file_refs', {
    file: join(root, 'cpp', 'old.h'),
    new_path: join(root, 'cpp', 'renamed.h'),
  }, root);
  assert(cppPreview.includes('move cpp/old.h -> cpp/renamed.h'), `cpp move summary present (got ${JSON.stringify(cppPreview)})`);
  assert(cppPreview.includes('update importer cpp/use.cpp'), `cpp importer update present (got ${JSON.stringify(cppPreview)})`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-rename-file-with-imports: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-rename-file-with-imports: ${passed} passed`);
