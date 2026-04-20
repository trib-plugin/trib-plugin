/**
 * Test for Phase F — TTL Auto-Learner
 *
 * Tests:
 *   1. Cold start (< 3 calls) → default '1h'
 *   2. 1-minute intervals → '5m'
 *   3. 10-minute intervals → '1h'
 *   4. 2-hour intervals → 'none'
 *   5. Manual override wins over learned TTL
 *   6. History capped at 10 entries
 */

// Inline the pure functions (no server boot required)
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_HISTORY = 10;

const recentCalls = new Map();

function recordCall(role, tsMs) {
    if (!role) return;
    let arr = recentCalls.get(role);
    if (!arr) {
        arr = [];
        recentCalls.set(role, arr);
    }
    arr.push(tsMs);
    if (arr.length > MAX_HISTORY) {
        arr.splice(0, arr.length - MAX_HISTORY);
    }
}

function learnTtl(role, overrideTtl = null) {
    if (!role) return '1h';
    if (overrideTtl) return overrideTtl;

    const arr = recentCalls.get(role);
    if (!arr || arr.length < 3) return '1h';

    const intervals = [];
    for (let i = 1; i < arr.length; i++) {
        intervals.push(arr[i] - arr[i - 1]);
    }

    const sorted = [...intervals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];

    if (median < FIVE_MINUTES_MS) return '5m';
    if (median < ONE_HOUR_MS) return '1h';
    return 'none';
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

function reset() {
    recentCalls.clear();
}

// =========================================================================
// TEST 1: Cold start (< 3 calls) → default '1h'
// =========================================================================
console.log('\n=== Test 1: Cold start ===');
reset();
assert(learnTtl('worker') === '1h', 'No calls → 1h');

recordCall('worker', 1000);
assert(learnTtl('worker') === '1h', '1 call → 1h');

recordCall('worker', 2000);
assert(learnTtl('worker') === '1h', '2 calls �� 1h');

// =========================================================================
// TEST 2: 1-minute intervals → '5m'
// =========================================================================
console.log('\n=== Test 2: 1-minute intervals ===');
reset();
const base = Date.now();
for (let i = 0; i < 5; i++) {
    recordCall('fast-role', base + i * 60_000); // 1min apart
}
assert(learnTtl('fast-role') === '5m', '1min intervals → 5m');

// =========================================================================
// TEST 3: 10-minute intervals → '1h'
// =========================================================================
console.log('\n=== Test 3: 10-minute intervals ===');
reset();
for (let i = 0; i < 5; i++) {
    recordCall('medium-role', base + i * 600_000); // 10min apart
}
assert(learnTtl('medium-role') === '1h', '10min intervals → 1h');

// =========================================================================
// TEST 4: 2-hour intervals → 'none'
// =========================================================================
console.log('\n=== Test 4: 2-hour intervals ===');
reset();
for (let i = 0; i < 5; i++) {
    recordCall('slow-role', base + i * 7_200_000); // 2h apart
}
assert(learnTtl('slow-role') === 'none', '2h intervals → none');

// =========================================================================
// TEST 5: Manual override wins
// =========================================================================
console.log('\n=== Test 5: Manual override ===');
reset();
for (let i = 0; i < 5; i++) {
    recordCall('override-role', base + i * 60_000); // 1min → would be '5m'
}
assert(learnTtl('override-role', '1h') === '1h', 'override_ttl=1h wins over learned 5m');
assert(learnTtl('override-role', 'none') === 'none', 'override_ttl=none wins over learned 5m');

// =========================================================================
// TEST 6: History capped at 10
// =========================================================================
console.log('\n=== Test 6: History cap ===');
reset();
for (let i = 0; i < 20; i++) {
    recordCall('capped', base + i * 60_000);
}
const arr = recentCalls.get('capped');
assert(arr.length === 10, `History length should be 10, got ${arr?.length}`);
assert(arr[0] === base + 10 * 60_000, 'Oldest entry should be index 10');

// =========================================================================
// Summary
// =========================================================================
console.log(`\nPASS ${passed}/${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
