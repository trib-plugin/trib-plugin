/**
 * Smoke test for the current role registry schema (5 fields).
 * Tests:
 *   1. Current user-workflow.json loads with expected defaults
 *   2. Bare file (name+preset only) gets defaults applied
 *   3. Invalid enum values throw / default correctly
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Inline the pure functions under test (no server boot required) ---
const VALID_PERMISSIONS = new Set(['read', 'read-write', 'full']);
const VALID_BEHAVIORS = new Set(['stateful', 'stateless']);
const DEFAULT_BEHAVIOR = {
  worker: 'stateful',
  debugger: 'stateful',
  reviewer: 'stateful',
  researcher: 'stateful',
  tester: 'stateful',
  maintenance: 'stateless',
  'webhook-handler': 'stateless',
  'scheduler-task': 'stateless',
  'proactive-decision': 'stateless',
};

function applyRoleDefaults(raw) {
  const permission = VALID_PERMISSIONS.has(raw.permission) ? raw.permission : 'full';
  const desc_path = typeof raw.desc_path === 'string' ? raw.desc_path : null;
  const rawBehavior = typeof raw.behavior === 'string' ? raw.behavior : null;
  const behavior = VALID_BEHAVIORS.has(rawBehavior)
    ? rawBehavior
    : (DEFAULT_BEHAVIOR[raw.name] || 'stateful');

  return {
    name: raw.name,
    preset: raw.preset,
    permission,
    desc_path,
    behavior,
  };
}

function validateRoleConfig(role) {
  if (!role.name || typeof role.name !== 'string')
    throw new Error(`[user-workflow] role entry missing "name"`);
  if (!role.preset || typeof role.preset !== 'string')
    throw new Error(`[user-workflow] role "${role.name}" missing "preset"`);
  if (!VALID_PERMISSIONS.has(role.permission))
    throw new Error(`[user-workflow] role "${role.name}": invalid permission "${role.permission}"`);
  if (!VALID_BEHAVIORS.has(role.behavior))
    throw new Error(`[user-workflow] role "${role.name}": invalid behavior "${role.behavior}"`);
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
// TEST 1: Load the actual user-workflow.json (current schema)
// =========================================================================
console.log('\n=== Test 1: Current user-workflow.json (current schema) ===');

const dataDir = process.env.CLAUDE_PLUGIN_DATA
  || join(process.env.USERPROFILE || process.env.HOME, '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin');
let wfPath = join(dataDir, 'user-workflow.json');
let fallbackDir = null;

let roles;
try {
  if (!existsSync(wfPath)) {
    fallbackDir = mkdtempSync(join(tmpdir(), 'role-current-'));
    wfPath = join(fallbackDir, 'user-workflow.json');
    writeFileSync(wfPath, JSON.stringify({
      roles: [
        { name: 'worker', preset: 'haiku' },
        { name: 'maintenance', preset: 'haiku', permission: 'read', desc_path: 'agents/maintenance.md' },
      ],
    }));
  }
  roles = loadAndResolve(wfPath);
} catch (e) {
  console.error(`  FAIL: Could not load ${wfPath}: ${e.message}`);
  process.exit(1);
}

// Schema-agnostic check: user-customizable role names/presets change over
// time, so we assert the loaded shape rather than pinning specific values.
// At least one role must load, and each must satisfy the current schema.
assert(roles.size >= 1, `At least 1 role loaded (got ${roles.size})`);

for (const [name, role] of roles) {
  assert(typeof role.name === 'string' && role.name.length > 0, `Role "${name}": name is non-empty string`);
  assert(typeof role.preset === 'string' && role.preset.length > 0, `Role "${name}": preset is non-empty string`);
  assert(['read', 'read-write', 'full'].includes(role.permission), `Role "${name}": permission is valid enum (got "${role.permission}")`);
  assert(['stateful', 'stateless'].includes(role.behavior), `Role "${name}": behavior is valid enum (got "${role.behavior}")`);
  assert(role.desc_path === null || typeof role.desc_path === 'string', `Role "${name}": desc_path is string or null`);
  // Current schema — no extra fields leaked in.
  const keys = Object.keys(role).sort();
  const expectedKeys = ['behavior', 'desc_path', 'name', 'permission', 'preset'];
  assert(JSON.stringify(keys) === JSON.stringify(expectedKeys), `Role "${name}": exactly 5 fields (got ${JSON.stringify(keys)})`);
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

assert(x.behavior === 'stateful', `bare default behavior === "stateful" (got "${x?.behavior}")`);

// Verify extra legacy fields are NOT present in the resolved output.
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
  assert(r1.behavior === 'stateful', 'missing behavior defaults to "stateful"');
}

// Direct validateRoleConfig with bad values DOES throw:
assertThrows(
  () => validateRoleConfig({ name: 'bad', preset: 'x', permission: 'BAD' }),
  'invalid permission',
  'direct validateRoleConfig with bad permission'
);

assertThrows(
  () => validateRoleConfig({ name: 'bad-behavior', preset: 'x', permission: 'full', behavior: 'BAD' }),
  'invalid behavior',
  'direct validateRoleConfig with bad behavior'
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
assert(legacy.behavior === 'stateless', 'Legacy behavior preserved');
assert(legacy.desc_path === 'agents/legacy.md', 'Legacy desc_path preserved');
assert(!('tail_cache' in legacy), 'tail_cache not in 5-field output');

// Cleanup
rmSync(tmpDir, { recursive: true, force: true });
if (fallbackDir) rmSync(fallbackDir, { recursive: true, force: true });

// =========================================================================
// Summary
// =========================================================================
console.log(`\nPASS ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
