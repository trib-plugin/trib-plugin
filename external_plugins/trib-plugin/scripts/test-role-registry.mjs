/**
 * Smoke test for Phase A — Agent Registry Extension (4-field schema).
 * Tests:
 *   1. Current user-workflow.json loads with expected 4-field defaults
 *   2. Bare file (name+preset only) gets defaults applied
 *   3. Invalid enum values throw / default correctly
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Inline the pure functions under test (no server boot required) ---
const VALID_PERMISSIONS = new Set(['read', 'read-write', 'full']);

function applyRoleDefaults(raw) {
  const permission = VALID_PERMISSIONS.has(raw.permission) ? raw.permission : 'full';
  const desc_path = typeof raw.desc_path === 'string' ? raw.desc_path : null;

  return {
    name: raw.name,
    preset: raw.preset,
    permission,
    desc_path,
  };
}

function validateRoleConfig(role) {
  if (!role.name || typeof role.name !== 'string')
    throw new Error(`[user-workflow] role entry missing "name"`);
  if (!role.preset || typeof role.preset !== 'string')
    throw new Error(`[user-workflow] role "${role.name}" missing "preset"`);
  if (!VALID_PERMISSIONS.has(role.permission))
    throw new Error(`[user-workflow] role "${role.name}": invalid permission "${role.permission}"`);
}

function loadAndResolve(filePath) {
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const map = new Map();
  if (Array.isArray(data?.roles)) {
    for (const raw of data.roles) {
      if (!raw?.name || !raw?.preset) continue;
      const resolved = applyRoleDefaults(raw);
      validateRoleConfig(resolved);
      map.set(resolved.name, resolved);
    }
  }
  return map;
}

// --- Test helpers ---
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function assertThrows(fn, msgContains, label) {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${label} — expected throw but none occurred`);
  } catch (e) {
    if (msgContains && !e.message.includes(msgContains)) {
      failed++;
      console.error(`  FAIL: ${label} — wrong error: ${e.message}`);
    } else {
      passed++;
    }
  }
}

// =========================================================================
// TEST 1: Load the actual user-workflow.json (4-field schema)
// =========================================================================
console.log('\n=== Test 1: Current user-workflow.json (4-field schema) ===');

const dataDir = process.env.CLAUDE_PLUGIN_DATA
  || join(process.env.USERPROFILE || process.env.HOME, '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin');
const wfPath = join(dataDir, 'user-workflow.json');

let roles;
try {
  roles = loadAndResolve(wfPath);
} catch (e) {
  console.error(`  FAIL: Could not load ${wfPath}: ${e.message}`);
  process.exit(1);
}

assert(roles.size === 9, `Expected 9 roles, got ${roles.size}`);

const expectedRoles = {
  worker:              { preset: 'opus-max',     permission: 'full',       desc_path: 'agents/worker.md' },
  debugger:            { preset: 'GPT5.4',      permission: 'full',       desc_path: 'agents/debugger.md' },
  reviewer:            { preset: 'GPT5.4',      permission: 'read',       desc_path: 'agents/reviewer.md' },
  researcher:          { preset: 'gpt5.4-mini', permission: 'read',       desc_path: 'agents/researcher.md' },
  tester:              { preset: 'GPT5.4',      permission: 'full',       desc_path: 'agents/tester.md' },
  maintenance:         { preset: 'haiku',        permission: 'read-write', desc_path: 'agents/maintenance.md' },
  'scheduler-task':    { preset: 'sonnet-mid',   permission: 'read-write', desc_path: 'agents/scheduler-task.md' },
  'webhook-handler':   { preset: 'sonnet-mid',   permission: 'read-write', desc_path: 'agents/webhook-handler.md' },
  'proactive-decision':{ preset: 'sonnet-mid',   permission: 'read-write', desc_path: 'agents/proactive-decision.md' },
};

for (const [name, expected] of Object.entries(expectedRoles)) {
  const r = roles.get(name);
  assert(!!r, `Role "${name}" exists`);
  if (!r) continue;
  assert(r.preset === expected.preset, `${name}.preset === "${expected.preset}" (got "${r.preset}")`);
  assert(r.permission === expected.permission, `${name}.permission === "${expected.permission}" (got "${r.permission}")`);
  assert(r.desc_path === expected.desc_path, `${name}.desc_path === "${expected.desc_path}" (got "${r.desc_path}")`);
}

// =========================================================================
// TEST 2: Bare file — defaults applied
// =========================================================================
console.log('\n=== Test 2: Bare file defaults ===');

const tmpDir = mkdtempSync(join(tmpdir(), 'role-test-'));
const bareFile = join(tmpDir, 'user-workflow.json');
writeFileSync(bareFile, JSON.stringify({ roles: [{ name: 'x', preset: 'haiku' }] }));

const bareRoles = loadAndResolve(bareFile);
const x = bareRoles.get('x');
assert(!!x, 'Bare role "x" loaded');
assert(x.permission === 'full', `bare default permission === "full" (got "${x?.permission}")`);
assert(x.desc_path === null, `bare default desc_path === null`);

// Verify extra fields are NOT present (4-field only)
assert(!('behavior' in x), 'No behavior field in 4-field schema');
assert(!('tail_cache' in x), 'No tail_cache field in 4-field schema');
assert(!('override_ttl' in x), 'No override_ttl field in 4-field schema');
assert(!('expected_interval_ms' in x), 'No expected_interval_ms field in 4-field schema');

// =========================================================================
// TEST 3: Invalid enum throws / defaults
// =========================================================================
console.log('\n=== Test 3: Invalid enum throws / defaults ===');

// applyRoleDefaults sanitizes invalid values, so the full pipeline does NOT throw.
{
  const r1 = applyRoleDefaults({ name: 'ok', preset: 'x', permission: 'INVALID' });
  assert(r1.permission === 'full', 'invalid permission defaults to "full"');
}

// Direct validateRoleConfig with bad values DOES throw:
assertThrows(
  () => validateRoleConfig({ name: 'bad', preset: 'x', permission: 'BAD' }),
  'invalid permission',
  'direct validateRoleConfig with bad permission'
);

// Old 8-field entries still load (extra fields silently ignored)
const compatFile = join(tmpDir, 'user-workflow-compat.json');
writeFileSync(compatFile, JSON.stringify({ roles: [{
  name: 'legacy', preset: 'haiku', permission: 'read',
  behavior: 'stateless', tail_cache: 'none', override_ttl: '5m',
  expected_interval_ms: 60000, desc_path: 'agents/legacy.md'
}] }));
const compatRoles = loadAndResolve(compatFile);
const legacy = compatRoles.get('legacy');
assert(!!legacy, 'Legacy 8-field entry loads');
assert(legacy.permission === 'read', 'Legacy permission preserved');
assert(legacy.desc_path === 'agents/legacy.md', 'Legacy desc_path preserved');
assert(!('behavior' in legacy), 'behavior not in 4-field output');

// Cleanup
rmSync(tmpDir, { recursive: true, force: true });

// =========================================================================
// Summary
// =========================================================================
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
