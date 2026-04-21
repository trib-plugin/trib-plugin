import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeCodeGraphTool, _internals } from '../src/agent/orchestrator/tools/code-graph.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'trib-code-graph-'));
try {
  mkdirSync(join(root, 'pkg'), { recursive: true });
  mkdirSync(join(root, 'javaapp', 'pkg'), { recursive: true });
  mkdirSync(join(root, 'javaapp', 'app'), { recursive: true });
  mkdirSync(join(root, 'csapp', 'Core'), { recursive: true });
  mkdirSync(join(root, 'csapp', 'App'), { recursive: true });
  mkdirSync(join(root, 'goapp', 'pkg'), { recursive: true });
  _internals.resetCodeGraphCachesForTesting();
  writeFileSync(join(root, 'pkg', '__init__.py'), '', 'utf8');
  writeFileSync(join(root, 'pkg', 'mod.py'), 'class Worker:\n    pass\n\ndef run():\n    return 1\n', 'utf8');
  writeFileSync(join(root, 'main.py'), 'from pkg.mod import Worker\nnote = "Worker"\nprint(Worker)\n# Worker comment\n', 'utf8');
  writeFileSync(join(root, 'a.js'), "import x from './b.js'\nexport function alpha() {}\n", 'utf8');
  writeFileSync(join(root, 'b.js'), 'export const x = 1\n', 'utf8');
  writeFileSync(join(root, 'javaapp', 'pkg', 'Worker.java'), 'package javaapp.pkg;\npublic class Worker {}\n', 'utf8');
  writeFileSync(join(root, 'javaapp', 'app', 'Main.java'), 'package javaapp.app;\nimport javaapp.pkg.Worker;\npublic class Main { Worker w; }\n', 'utf8');
  writeFileSync(join(root, 'csapp', 'Core', 'Worker.cs'), 'namespace Example.Core;\npublic class Worker {}\n', 'utf8');
  writeFileSync(join(root, 'csapp', 'App', 'Program.cs'), 'using Example.Core;\nnamespace Example.App;\npublic class Program { private Worker worker = new(); }\n', 'utf8');
  writeFileSync(join(root, 'goapp', 'go.mod'), 'module example.com/demo\n', 'utf8');
  writeFileSync(join(root, 'goapp', 'pkg', 'worker.go'), 'package worker\n\ntype Worker struct{}\n', 'utf8');
  writeFileSync(join(root, 'goapp', 'main.go'), 'package main\n\nimport "example.com/demo/pkg"\n\nfunc main() { _ = pkg.Worker{} }\n', 'utf8');

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'overview' }, root);
    assert(/files\t\d+/.test(out), 'overview returns file count');
    assert(/python\t2/.test(out) || /python\t3/.test(out), `overview counts python files (got ${JSON.stringify(out)})`);
    assert(/javascript\t2/.test(out), `overview counts js files (got ${JSON.stringify(out)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'a.js') }, root);
    assert(out.includes('b.js'), `imports resolves local js import (got ${JSON.stringify(out)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'dependents', file: join(root, 'pkg', 'mod.py') }, root);
    assert(out.includes('main.py'), `dependents finds python importer (got ${JSON.stringify(out)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'related', file: join(root, 'pkg', 'mod.py') }, root);
    assert(out.includes('# dependents') && out.includes('main.py'), `related includes dependent files (got ${JSON.stringify(out)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'impact', file: join(root, 'pkg', 'mod.py') }, root);
    assert(out.includes('dependents\t1') && out.includes('related\t1'), `impact includes counts (got ${JSON.stringify(out)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'symbols', file: join(root, 'pkg', 'mod.py') }, root);
    assert(out.includes('class Worker') && out.includes('function run'), `python cheap symbols extracted (got ${JSON.stringify(out)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'references', file: join(root, 'pkg', 'mod.py'), symbol: 'Worker' }, root);
    const stats = _internals.getCodeGraphCacheStatsForTesting();
    assert(out.includes('main.py:1') && out.includes('main.py:3'), `non-TS references use masked cheap search on code hits (got ${JSON.stringify(out)})`);
    assert(!out.includes('main.py:2') && !out.includes('main.py:4'), `references ignore strings/comments (got ${JSON.stringify(out)})`);
    assert(stats.referenceQueryMisses >= 1, `first reference query records a cache miss (got ${JSON.stringify(stats)})`);
    assert(stats.sourceTextCacheHits >= 1, `first reference query reuses source text gathered during graph build (got ${JSON.stringify(stats)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'references', file: join(root, 'pkg', 'mod.py'), symbol: 'Worker' }, root);
    const stats = _internals.getCodeGraphCacheStatsForTesting();
    assert(out.includes('main.py:1') && out.includes('main.py:3'), `cached references still return expected hits (got ${JSON.stringify(out)})`);
    assert(stats.referenceQueryHits >= 1, `repeated reference query reuses in-graph cache (got ${JSON.stringify(stats)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'callers', file: join(root, 'pkg', 'mod.py'), symbol: 'Worker' }, root);
    assert(out.includes('main.py'), `non-TS callers collapse references to caller files (got ${JSON.stringify(out)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'callers', file: join(root, 'b.js'), symbol: 'x' }, root);
    assert(out.includes('a.js'), `TS/JS callers uses references and collapses to caller files (got ${JSON.stringify(out)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'javaapp', 'app', 'Main.java') }, root);
    assert(out.includes('javaapp/pkg/Worker.java'), `java imports resolve fqcn to file (got ${JSON.stringify(out)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'dependents', file: join(root, 'javaapp', 'pkg', 'Worker.java') }, root);
    assert(out.includes('javaapp/app/Main.java'), `java dependents find importer (got ${JSON.stringify(out)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'csapp', 'App', 'Program.cs') }, root);
    assert(out.includes('csapp/Core/Worker.cs'), `csharp using resolves namespace members (got ${JSON.stringify(out)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'dependents', file: join(root, 'csapp', 'Core', 'Worker.cs') }, root);
    assert(out.includes('csapp/App/Program.cs'), `csharp dependents find namespace importer (got ${JSON.stringify(out)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'goapp', 'main.go') }, root);
    assert(out.includes('goapp/pkg/worker.go'), `go imports resolve module-local package dir (got ${JSON.stringify(out)})`);
  }

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'dependents', file: join(root, 'goapp', 'pkg', 'worker.go') }, root);
    assert(out.includes('goapp/main.go'), `go dependents find importer (got ${JSON.stringify(out)})`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-code-graph: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-code-graph: ${passed} passed`);
