import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
  mkdirSync(join(root, 'javaapp', 'pkg'), { recursive: true });
  mkdirSync(join(root, 'javaapp', 'domain'), { recursive: true });
  mkdirSync(join(root, 'javaapp', 'app'), { recursive: true });
  mkdirSync(join(root, 'ktapp', 'pkg'), { recursive: true });
  mkdirSync(join(root, 'ktapp', 'domain'), { recursive: true });
  mkdirSync(join(root, 'ktapp', 'app'), { recursive: true });
  mkdirSync(join(root, 'csapp', 'Core'), { recursive: true });
  mkdirSync(join(root, 'csapp', 'Domain'), { recursive: true });
  mkdirSync(join(root, 'csapp', 'App'), { recursive: true });
  mkdirSync(join(root, 'goapp', 'pkg'), { recursive: true });
  mkdirSync(join(root, 'goapp', 'domain'), { recursive: true });
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

  writeFileSync(join(root, 'javaapp', 'pkg', 'Worker.java'), 'package javaapp.pkg;\npublic class Worker {}\n', 'utf8');
  writeFileSync(join(root, 'javaapp', 'app', 'Main.java'), 'package javaapp.app;\nimport javaapp.pkg.Worker;\npublic class Main { Worker w; }\n', 'utf8');
  const javaPreview = await executeCodeGraphTool('rename_file_refs', {
    file: join(root, 'javaapp', 'pkg', 'Worker.java'),
    new_path: join(root, 'javaapp', 'domain', 'Worker.java'),
    apply: true,
  }, root);
  const javaMoved = readFileSync(join(root, 'javaapp', 'domain', 'Worker.java'), 'utf8');
  const javaImporter = readFileSync(join(root, 'javaapp', 'app', 'Main.java'), 'utf8');
  assert(javaPreview.includes('move javaapp/pkg/Worker.java -> javaapp/domain/Worker.java'), `java move summary present (got ${JSON.stringify(javaPreview)})`);
  assert(javaPreview.includes('update importer javaapp/app/Main.java'), `java importer update present (got ${JSON.stringify(javaPreview)})`);
  assert(!existsSync(join(root, 'javaapp', 'pkg', 'Worker.java')), 'java source file moved away from old path');
  assert(javaMoved.includes('package javaapp.domain;'), `java moved file package updated (got ${JSON.stringify(javaMoved)})`);
  assert(javaImporter.includes('import javaapp.domain.Worker;'), `java importer updated to new package (got ${JSON.stringify(javaImporter)})`);

  writeFileSync(join(root, 'ktapp', 'pkg', 'Worker.kt'), 'package ktapp.pkg\nclass Worker\n', 'utf8');
  writeFileSync(join(root, 'ktapp', 'app', 'Main.kt'), 'package ktapp.app\nimport ktapp.pkg.Worker\nclass Main { val w = Worker() }\n', 'utf8');
  const ktPreview = await executeCodeGraphTool('rename_file_refs', {
    file: join(root, 'ktapp', 'pkg', 'Worker.kt'),
    new_path: join(root, 'ktapp', 'domain', 'Worker.kt'),
    apply: true,
  }, root);
  const ktMoved = readFileSync(join(root, 'ktapp', 'domain', 'Worker.kt'), 'utf8');
  const ktImporter = readFileSync(join(root, 'ktapp', 'app', 'Main.kt'), 'utf8');
  assert(ktPreview.includes('move ktapp/pkg/Worker.kt -> ktapp/domain/Worker.kt'), `kotlin move summary present (got ${JSON.stringify(ktPreview)})`);
  assert(ktPreview.includes('update importer ktapp/app/Main.kt'), `kotlin importer update present (got ${JSON.stringify(ktPreview)})`);
  assert(!existsSync(join(root, 'ktapp', 'pkg', 'Worker.kt')), 'kotlin source file moved away from old path');
  assert(ktMoved.includes('package ktapp.domain'), `kotlin moved file package updated (got ${JSON.stringify(ktMoved)})`);
  assert(ktImporter.includes('import ktapp.domain.Worker'), `kotlin importer updated to new package (got ${JSON.stringify(ktImporter)})`);

  writeFileSync(join(root, 'csapp', 'Core', 'Worker.cs'), 'namespace Example.Core;\npublic class Worker {}\n', 'utf8');
  writeFileSync(join(root, 'csapp', 'App', 'Program.cs'), 'using Example.Core;\nnamespace Example.App;\npublic class Program { private Worker worker = new(); }\n', 'utf8');
  const csPreview = await executeCodeGraphTool('rename_file_refs', {
    file: join(root, 'csapp', 'Core', 'Worker.cs'),
    new_path: join(root, 'csapp', 'Domain', 'Worker.cs'),
    apply: true,
  }, root);
  const csMoved = readFileSync(join(root, 'csapp', 'Domain', 'Worker.cs'), 'utf8');
  const csImporter = readFileSync(join(root, 'csapp', 'App', 'Program.cs'), 'utf8');
  assert(csPreview.includes('move csapp/Core/Worker.cs -> csapp/Domain/Worker.cs'), `csharp move summary present (got ${JSON.stringify(csPreview)})`);
  assert(csPreview.includes('update importer csapp/App/Program.cs'), `csharp importer update present (got ${JSON.stringify(csPreview)})`);
  assert(!existsSync(join(root, 'csapp', 'Core', 'Worker.cs')), 'csharp source file moved away from old path');
  assert(csMoved.includes('namespace Example.Domain;'), `csharp moved file namespace updated (got ${JSON.stringify(csMoved)})`);
  assert(csImporter.includes('using Example.Domain;'), `csharp importer updated to new namespace (got ${JSON.stringify(csImporter)})`);

  writeFileSync(join(root, 'goapp', 'go.mod'), 'module example.com/demo\n', 'utf8');
  writeFileSync(join(root, 'goapp', 'pkg', 'worker.go'), 'package worker\n\ntype Worker struct{}\n', 'utf8');
  writeFileSync(join(root, 'goapp', 'main.go'), 'package main\n\nimport "example.com/demo/pkg"\n\nfunc main() { _ = worker.Worker{} }\n', 'utf8');
  const goPreview = await executeCodeGraphTool('rename_file_refs', {
    file: join(root, 'goapp', 'pkg', 'worker.go'),
    new_path: join(root, 'goapp', 'domain', 'worker.go'),
    apply: true,
  }, root);
  const goMoved = readFileSync(join(root, 'goapp', 'domain', 'worker.go'), 'utf8');
  const goImporter = readFileSync(join(root, 'goapp', 'main.go'), 'utf8');
  assert(goPreview.includes('move goapp/pkg/worker.go -> goapp/domain/worker.go'), `go move summary present (got ${JSON.stringify(goPreview)})`);
  assert(goPreview.includes('update importer goapp/main.go'), `go importer update present (got ${JSON.stringify(goPreview)})`);
  assert(!existsSync(join(root, 'goapp', 'pkg', 'worker.go')), 'go source file moved away from old path');
  assert(goMoved.includes('package worker'), `go moved file keeps package name unchanged (got ${JSON.stringify(goMoved)})`);
  assert(goImporter.includes('import "example.com/demo/domain"'), `go importer updated to new import path (got ${JSON.stringify(goImporter)})`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-rename-file-with-imports: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-rename-file-with-imports: ${passed} passed`);
