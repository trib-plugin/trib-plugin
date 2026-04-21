import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createGuard,
  checkToolCall,
  resetGuardConfigForTesting,
  _internals,
} from '../src/agent/orchestrator/tool-loop-guard.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

function feed(guard, toolName, args, result, iteration) {
  return checkToolCall(guard, { toolName, args, result, iteration });
}

const root = mkdtempSync(join(tmpdir(), 'trib-guard-config-'));
const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;

try {
  process.env.CLAUDE_PLUGIN_DATA = root;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'agent-config.json'), JSON.stringify({
    bridge: {
      toolLoopGuard: {
        detectThreshold: 3,
        abortThreshold: 4,
        sameToolThresholds: {
          read: 2,
        },
        totalToolWarnThresholds: [5],
      },
    },
  }, null, 2));

  resetGuardConfigForTesting();
  _internals.clearLoadedRuntimeConfigCache();

  {
    const g = createGuard();
    const r1 = feed(g, 'read', { path: '/a' }, 'ok', 1);
    const r2 = feed(g, 'read', { path: '/b' }, 'ok', 2);
    assert(r1.action === 'continue', 'config: first read call stays continue');
    assert(r2.action === 'same_tool_warn', 'config: sameToolThreshold from config applies');
  }

  {
    const g = createGuard();
    feed(g, 'edit', { old_string: 'x' }, 'Error: old_string did not match', 1);
    feed(g, 'edit', { old_string: 'x' }, 'Error: old_string did not match', 2);
    const r3 = feed(g, 'edit', { old_string: 'x' }, 'Error: old_string did not match', 3);
    const r4 = feed(g, 'edit', { old_string: 'x' }, 'Error: old_string did not match', 4);
    assert(r3.action === 'detected', 'config: detectThreshold from config applies');
    assert(r4.action === 'abort', 'config: abortThreshold from config applies');
  }

  {
    const g = createGuard();
    let last = null;
    for (let i = 1; i <= 5; i++) last = feed(g, 'write', { path: `/tmp/${i}` }, 'ok', i);
    assert(last.action === 'budget_warn', 'config: totalToolWarnThresholds from config apply');
  }
} finally {
  resetGuardConfigForTesting();
  _internals.clearLoadedRuntimeConfigCache();
  if (prevDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-tool-loop-guard-config: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-tool-loop-guard-config: ${passed} passed`);
