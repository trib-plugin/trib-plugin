import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, saveConfig } from '../src/agent/orchestrator/config.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'trib-config-save-'));
const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;

try {
  process.env.CLAUDE_PLUGIN_DATA = root;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'agent-config.json'), JSON.stringify({
    providers: {
      openai: { enabled: true },
    },
    cycle3: {
      enabled: true,
      interval: '1h',
    },
    statePacket: {
      enabled: true,
      threshold: 20,
      ttlMinutes: 30,
    },
  }, null, 2));

  const cfg = loadConfig();
  cfg.bridge = { toolLoopGuard: { totalToolWarnThresholds: [20, 40] } };
  saveConfig(cfg);

  const raw = JSON.parse(readFileSync(join(root, 'agent-config.json'), 'utf8'));
  assert(raw.cycle3?.enabled === true && raw.cycle3?.interval === '1h', `saveConfig preserves unknown cycle3 block (got ${JSON.stringify(raw.cycle3)})`);
  assert(raw.statePacket?.enabled === true && raw.statePacket?.threshold === 20, `saveConfig preserves unknown statePacket block (got ${JSON.stringify(raw.statePacket)})`);
  assert(raw.bridge?.toolLoopGuard?.totalToolWarnThresholds?.join(',') === '20,40', `saveConfig writes known bridge block alongside preserved keys (got ${JSON.stringify(raw.bridge)})`);
} finally {
  if (prevDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`test-config-save-preserves-extra-keys: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-config-save-preserves-extra-keys: ${passed} passed`);
