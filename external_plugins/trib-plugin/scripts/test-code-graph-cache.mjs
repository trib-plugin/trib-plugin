import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeCodeGraphTool, _internals } from '../src/agent/orchestrator/tools/code-graph.mjs';
import { executeBuiltinTool } from '../src/agent/orchestrator/tools/builtin.mjs';
import { executePatchTool } from '../src/agent/orchestrator/tools/patch.mjs';
import { executeBashSessionTool } from '../src/agent/orchestrator/tools/bash-session.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'trib-code-graph-cache-'));
const dataDir = join(root, 'plugin-data');
const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;

try {
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(root, 'a.js'), "import x from './b.js'\n", 'utf8');
  writeFileSync(join(root, 'b.js'), 'export const x = 1\n', 'utf8');

  _internals.resetCodeGraphCachesForTesting();

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'a.js') }, root);
    const stats = _internals.getCodeGraphCacheStatsForTesting();
    assert(out.includes('b.js'), `initial graph build resolves import (got ${JSON.stringify(out)})`);
    assert(stats.memoryMisses >= 1 && stats.diskMisses >= 1 && stats.rebuiltNodes >= 2, `initial build records misses and cold rebuilds (got ${JSON.stringify(stats)})`);
  }

  _internals.persistCodeGraphDiskCacheNow();
  _internals.resetCodeGraphCachesForTesting();

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'a.js') }, root);
    const stats = _internals.getCodeGraphCacheStatsForTesting();
    assert(out.includes('b.js'), `disk-restored graph resolves import (got ${JSON.stringify(out)})`);
    assert(stats.diskHits >= 1, `second build reuses disk cache (got ${JSON.stringify(stats)})`);
  }

  {
    const refs = await executeCodeGraphTool('code_graph', { mode: 'references', file: join(root, 'b.js'), symbol: 'x' }, root);
    const stats = _internals.getCodeGraphCacheStatsForTesting();
    assert(refs.includes('a.js:1'), `reference query works before incremental rebuild (got ${JSON.stringify(refs)})`);
    assert(stats.symbolIndexFullBuilds >= 1, `reference query lazily builds symbol index before rebuild (got ${JSON.stringify(stats)})`);
  }

  writeFileSync(join(root, 'c.js'), 'export const y = 2\n', 'utf8');
  writeFileSync(join(root, 'a.js'), "import y from './c.js'\n", 'utf8');

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'a.js') }, root);
    const stats = _internals.getCodeGraphCacheStatsForTesting();
    assert(out.includes('c.js') && !out.includes('b.js'), `stale memory/disk cache is bypassed after file change (got ${JSON.stringify(out)})`);
    assert(stats.memoryMisses >= 2 && stats.diskMisses >= 1, `file change forces rebuild instead of stale hit (got ${JSON.stringify(stats)})`);
    assert(stats.reusedNodes >= 1 && stats.rebuiltNodes >= 2, `unchanged nodes are reused while changed nodes rebuild (got ${JSON.stringify(stats)})`);
    assert(stats.symbolIndexIncrementalBuilds === 0, `imports-only rebuild does not pay symbol index maintenance cost eagerly (got ${JSON.stringify(stats)})`);
  }

  {
    const refs = await executeCodeGraphTool('code_graph', { mode: 'references', file: join(root, 'c.js'), symbol: 'y' }, root);
    const stats = _internals.getCodeGraphCacheStatsForTesting();
    assert(refs.includes('a.js:1'), `reference query after rebuild still resolves new symbol hits (got ${JSON.stringify(refs)})`);
    assert(stats.symbolIndexFullBuilds >= 2, `symbol index rebuild is deferred until the next symbol query (got ${JSON.stringify(stats)})`);
  }

  writeFileSync(join(root, 'd.js'), 'export const z = 3\n', 'utf8');
  _internals.resetCodeGraphCachesForTesting();
  await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'a.js') }, `${root}/.`);
  {
    const body = "import z from './d.js'\n";
    const res = await executeBuiltinTool('write', { path: join(root, 'a.js'), content: body }, root);
    const out = await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'a.js') }, root);
    const stats = _internals.getCodeGraphCacheStatsForTesting();
    assert(/Written:/.test(res), `tool write succeeds before dirty-path rebuild (got ${JSON.stringify(res)})`);
    assert(out.includes('d.js'), `dirty-path rebuild through builtin write sees changed import graph (got ${JSON.stringify(out)})`);
    assert(stats.dirtyPathRebuilds >= 1, `code_graph uses dirty-path fast path after builtin write even across equivalent cwd spellings (got ${JSON.stringify(stats)})`);
  }

  writeFileSync(join(root, 'e.js'), 'export const p = 4\n', 'utf8');
  await executeBuiltinTool('write', { path: join(root, 'a.js'), content: "import z from './d.js'\n" }, root);
  _internals.resetCodeGraphCachesForTesting();
  await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'a.js') }, root);
  {
    const patch = [
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1 +1 @@',
      "-import z from './d.js'",
      "+import p from './e.js'",
      '',
    ].join('\n');
    const res = await executePatchTool('apply_patch', { patch, base_path: root }, root);
    const out = await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'a.js') }, root);
    const stats = _internals.getCodeGraphCacheStatsForTesting();
    assert(/applied: 1 file/.test(res), `apply_patch succeeds before dirty-path rebuild (got ${JSON.stringify(res)})`);
    assert(out.includes('e.js'), `dirty-path rebuild through apply_patch sees changed import graph (got ${JSON.stringify(out)})`);
    assert(stats.dirtyPathRebuilds >= 1, `code_graph uses dirty-path fast path after apply_patch (got ${JSON.stringify(stats)})`);
  }

  writeFileSync(join(root, 'f.js'), 'export const q = 5\n', 'utf8');
  await executeBuiltinTool('write', { path: join(root, 'a.js'), content: "import p from './e.js'\n" }, root);
  _internals.resetCodeGraphCachesForTesting();
  await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'a.js') }, root);
  {
    const res = await executeBashSessionTool('bash_session', {
      command: `cd ${root} && touch a.js && printf "import q from './f.js'\\n" > a.js`,
      close: true,
    });
    const out = await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'a.js') }, root);
    const stats = _internals.getCodeGraphCacheStatsForTesting();
    assert(/\[closed\]/.test(res), `bash_session closes cleanly after write (got ${JSON.stringify(res)})`);
    assert(out.includes('f.js'), `dirty-path rebuild through bash_session sees changed import graph (got ${JSON.stringify(out)})`);
    assert(stats.dirtyPathRebuilds >= 1, `code_graph uses dirty-path fast path after bash_session mutation (got ${JSON.stringify(stats)})`);
  }
} finally {
  if (prevDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-code-graph-cache: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-code-graph-cache: ${passed} passed`);
