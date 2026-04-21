import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

  writeFileSync(join(root, 'c.js'), 'export const y = 2\n', 'utf8');
  writeFileSync(join(root, 'a.js'), "import y from './c.js'\n", 'utf8');

  {
    const out = await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(root, 'a.js') }, root);
    const stats = _internals.getCodeGraphCacheStatsForTesting();
    assert(out.includes('c.js') && !out.includes('b.js'), `stale memory/disk cache is bypassed after file change (got ${JSON.stringify(out)})`);
    assert(stats.memoryMisses >= 2 && stats.diskMisses >= 1, `file change forces rebuild instead of stale hit (got ${JSON.stringify(stats)})`);
    assert(stats.reusedNodes >= 1 && stats.rebuiltNodes >= 2, `unchanged nodes are reused while changed nodes rebuild (got ${JSON.stringify(stats)})`);
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
