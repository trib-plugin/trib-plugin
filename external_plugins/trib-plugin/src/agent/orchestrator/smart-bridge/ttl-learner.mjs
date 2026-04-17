/**
 * Smart Bridge — TTL Auto-Learner
 *
 * Tracks recent call timestamps per role and derives the optimal
 * cache_control TTL tier based on observed call frequency.
 *
 * Logic:
 *   - <3 calls: fallback '1h'
 *   - 3+ calls: compute median interval between consecutive calls
 *     - < 5min  → '5m'
 *     - < 1h    → '1h'
 *     - else    → 'none' (hard clamp — too infrequent to justify cache premium)
 *   - override_ttl from role config always wins when set
 */

// Lazy import to avoid circular dependency
let _getRoleConfig = null;
async function getRoleConfigLazy(role) {
    if (!_getRoleConfig) {
        try {
            const mod = await import('../../../agent/index.mjs');
            _getRoleConfig = mod.getRoleConfig || (() => null);
        } catch {
            _getRoleConfig = () => null;
        }
    }
    return _getRoleConfig(role);
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_HISTORY = 10;

/** @type {Map<string, number[]>} role → sorted timestamps (most recent last) */
const recentCalls = new Map();

/**
 * Record a call timestamp for a role.
 * @param {string} role
 * @param {number} tsMs — Date.now() at call time
 */
export function recordCall(role, tsMs) {
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

/**
 * Derive the optimal TTL tier for a role based on observed call frequency.
 * @param {string} role
 * @returns {'5m' | '1h' | 'none'} TTL tier
 */
export function learnTtl(role) {
    if (!role) return '1h';

    // override_ttl always wins — check synchronously from cached role config
    // (getRoleConfig reads from the in-memory Map, populated at startup)
    let overrideTtl = null;
    try {
        // Attempt sync path first (the Map is populated after init)
        if (_getRoleConfig) {
            const cfg = _getRoleConfig(role);
            if (cfg?.override_ttl) overrideTtl = cfg.override_ttl;
        }
    } catch {}
    if (overrideTtl) return overrideTtl;

    const arr = recentCalls.get(role);
    if (!arr || arr.length < 3) return '1h';

    // Compute intervals between consecutive calls
    const intervals = [];
    for (let i = 1; i < arr.length; i++) {
        intervals.push(arr[i] - arr[i - 1]);
    }

    // Median interval
    const sorted = [...intervals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];

    if (median < FIVE_MINUTES_MS) return '5m';
    if (median < ONE_HOUR_MS) return '1h';
    return 'none';
}

/**
 * Get the raw call history for a role (for testing/debugging).
 * @param {string} role
 * @returns {number[]}
 */
export function getCallHistory(role) {
    return recentCalls.get(role) || [];
}

/**
 * Reset all call history (for testing).
 */
export function resetAll() {
    recentCalls.clear();
}
