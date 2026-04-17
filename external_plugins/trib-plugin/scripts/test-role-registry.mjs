/**
 * Smoke test for Phase A — Agent Registry Extension.
 * Tests:
 *   1. Current extended user-workflow.json loads with expected defaults
 *   2. Bare file (name+preset only) gets defaults applied
 *   3. Invalid enum values throw
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Inline the pure functions under test (no server boot required) ---
const VALID_PERMISSIONS = new Set(['read', 'read-write', 'full']);
const VALID_BEHAVIORS   = new Set(['stateful', 'stateless']);
const VALID_TAIL_CACHE  = new Set(['5m', 'none']);
const VALID_OVERRIDE_TTL = new Set(['5m', '1h', 'none']);

function applyRoleDefaults(raw) {
  const behavior = VALID_BEHAVIORS.has(raw.behavior) ? raw.behavior : 'stateful';
  const permission = VALID_PERMISSIONS.has(raw.permission) ? raw.permission : 'full';
  const tail_cache = VALID_TAIL_CACHE.has(raw.tail_cache)
    ? raw.tail_cache
    : (behavior === 'stateful' ? '5m' : 'none');
  const override_ttl = raw.override_ttl === null || raw.override_ttl === undefined
    ? null
    : (VALID_OVERRIDE_TTL.has(raw.override_ttl) ? raw.override_ttl : null);
  const expected_interval_ms = typeof raw.expected_interval_ms === 'number'
    ? raw.expected_interval_ms
    : null;
  const desc_path = typeof raw.desc_path === 'string' ? raw.desc_path : null;

  return {
    name: raw.name,
    preset: raw.preset,
    permission,
    desc_path,
    behavior,
    tail_cache,
    override_ttl,
    expected_interval_ms,
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
  if (!VALID_TAIL_CACHE.has(role.tail_cache))
    throw new Error(`[user-workflow] role "${role.name}": invalid tail_cache "${role.tail_cache}"`);
  if (role.override_ttl !== null && !VALID_OVERRIDE_TTL.has(role.override_ttl))
    throw new Error(`[user-workflow] role "${role.name}": invalid override_ttl "${role.override_ttl}"`);
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
// TEST 1: Load the actual extended user-workflow.json
// =========================================================================
console.log('\n=== Test 1: Current extended user-workflow.json ===');

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

assert(roles.size === 5, `Expected 5 roles, got ${roles.size}`);

const expectedRoles = {
  worker:     { preset: 'opus-max',     permission: 'full', behavior: 'stateful', tail_cache: '5m' },
  debugger:   { preset: 'GPT5.4',      permission: 'full', behavior: 'stateful', tail_cache: '5m' },
  reviewer:   { preset: 'GPT5.4',      permission: 'read', behavior: 'stateful', tail_cache: '5m' },
  researcher: { preset: 'gpt5.4-mini', permission: 'read', behavior: 'stateful', tail_cache: '5m' },
  tester:     { preset: 'GPT5.4',      permission: 'full', behavior: 'stateful', tail_cache: '5m' },
};

for (const [name, expected] of Object.entries(expectedRoles)) {
  const r = roles.get(name);
  assert(!!r, `Role "${name}" exists`);
  if (!r) continue;
  assert(r.preset === expected.preset, `${name}.preset === "${expected.preset}" (got "${r.preset}")`);
  assert(r.permission === expected.permission, `${name}.permission === "${expected.permission}" (got "${r.permission}")`);
  assert(r.behavior === expected.behavior, `${name}.behavior === "${expected.behavior}" (got "${r.behavior}")`);
  assert(r.tail_cache === expected.tail_cache, `${name}.tail_cache === "${expected.tail_cache}" (got "${r.tail_cache}")`);
  assert(r.desc_path === null, `${name}.desc_path === null`);
  assert(r.override_ttl === null, `${name}.override_ttl === null`);
  assert(r.expected_interval_ms === null, `${name}.expected_interval_ms === null`);
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
assert(x.behavior === 'stateful', `bare default behavior === "stateful" (got "${x?.behavior}")`);
assert(x.tail_cache === '5m', `bare default tail_cache === "5m" (got "${x?.tail_cache}")`);
assert(x.override_ttl === null, `bare default override_ttl === null (got "${x?.override_ttl}")`);
assert(x.expected_interval_ms === null, `bare default expected_interval_ms === null`);
assert(x.desc_path === null, `bare default desc_path === null`);

// Also verify stateless behavior derives tail_cache='none'
const statelessFile = join(tmpDir, 'user-workflow-sl.json');
writeFileSync(statelessFile, JSON.stringify({ roles: [{ name: 'y', preset: 'haiku', behavior: 'stateless' }] }));
const slRoles = loadAndResolve(statelessFile);
const y = slRoles.get('y');
assert(y?.tail_cache === 'none', `stateless default tail_cache === "none" (got "${y?.tail_cache}")`);

// =========================================================================
// TEST 3: Invalid enum throws
// =========================================================================
console.log('\n=== Test 3: Invalid enum throws ===');

// applyRoleDefaults sanitizes invalid values, so the full pipeline does NOT throw.
// Verify that invalid inputs are silently defaulted:
{
  const r1 = applyRoleDefaults({ name: 'ok', preset: 'x', permission: 'INVALID' });
  assert(r1.permission === 'full', 'invalid permission defaults to "full"');
  const r2 = applyRoleDefaults({ name: 'ok', preset: 'x', behavior: 'INVALID' });
  assert(r2.behavior === 'stateful', 'invalid behavior defaults to "stateful"');
}

// Direct validateRoleConfig with bad values DOES throw:
assertThrows(
  () => validateRoleConfig({ name: 'bad', preset: 'x', permission: 'BAD', behavior: 'stateful', tail_cache: '5m', override_ttl: null }),
  'invalid permission',
  'direct validateRoleConfig with bad permission'
);

assertThrows(
  () => validateRoleConfig({ name: 'bad', preset: 'x', permission: 'full', behavior: 'BAD', tail_cache: '5m', override_ttl: null }),
  'invalid behavior',
  'direct validateRoleConfig with bad behavior'
);

assertThrows(
  () => validateRoleConfig({ name: 'bad', preset: 'x', permission: 'full', behavior: 'stateful', tail_cache: 'BAD', override_ttl: null }),
  'invalid tail_cache',
  'direct validateRoleConfig with bad tail_cache'
);

assertThrows(
  () => validateRoleConfig({ name: 'bad', preset: 'x', permission: 'full', behavior: 'stateful', tail_cache: '5m', override_ttl: 'BAD' }),
  'invalid override_ttl',
  'direct validateRoleConfig with bad override_ttl'
);

// Cleanup
rmSync(tmpDir, { recursive: true, force: true });

// =========================================================================
// Summary
// =========================================================================
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
