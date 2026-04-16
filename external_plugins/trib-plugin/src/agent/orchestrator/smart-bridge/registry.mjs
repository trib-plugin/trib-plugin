/**
 * Smart Bridge — Cache Registry
 *
 * Persists per-profile cache warm-state to disk so MCP server restarts
 * don't invalidate in-flight provider-side caches. Anthropic/OpenAI keep
 * cache entries alive by prefix hash for minutes to hours; our registry
 * just remembers which profiles are still within their TTL so we can
 * reuse the exact same prefix after a restart.
 *
 * Storage: <plugin-data>/cache-registry.json
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { getPluginData } from '../config.mjs';

const REGISTRY_VERSION = 1;

function registryPath() {
    return join(getPluginData(), 'cache-registry.json');
}

function emptyRegistry() {
    return {
        version: REGISTRY_VERSION,
        profiles: {},   // profileId → { provider, prefixHash, createdAt, expiresAt, hitCount, missCount, systemHash }
        openaiKeys: {}, // cacheKey → { retention, lastUsedAt }
        updatedAt: new Date().toISOString(),
    };
}

export class CacheRegistry {
    constructor() {
        this.data = emptyRegistry();
        this.loaded = false;
        this.dirty = false;
    }

    load() {
        const path = registryPath();
        if (!existsSync(path)) {
            this.data = emptyRegistry();
            this.loaded = true;
            return;
        }
        try {
            const raw = JSON.parse(readFileSync(path, 'utf8'));
            if (raw.version === REGISTRY_VERSION) {
                this.data = {
                    version: REGISTRY_VERSION,
                    profiles: raw.profiles || {},
                    openaiKeys: raw.openaiKeys || {},
                    updatedAt: raw.updatedAt || new Date().toISOString(),
                };
            } else {
                // Version mismatch — start fresh but keep a backup reference.
                process.stderr.write(`[cache-registry] version mismatch (${raw.version} vs ${REGISTRY_VERSION}), resetting\n`);
                this.data = emptyRegistry();
            }
        } catch (err) {
            process.stderr.write(`[cache-registry] load failed: ${err.message}\n`);
            this.data = emptyRegistry();
        }
        this.cleanupExpired();
        this.loaded = true;
    }

    save() {
        if (!this.loaded) return;
        const path = registryPath();
        try {
            mkdirSync(dirname(path), { recursive: true });
            this.data.updatedAt = new Date().toISOString();
            const tmp = path + '.tmp';
            writeFileSync(tmp, JSON.stringify(this.data, null, 2));
            renameSync(tmp, path);
            this.dirty = false;
        } catch (err) {
            process.stderr.write(`[cache-registry] save failed: ${err.message}\n`);
        }
    }

    // --- Profile cache warm state ---

    /**
     * Record that a profile was just written to provider cache.
     * prefixContent should be deterministic (system + tools + context chunks)
     * so re-hashing produces the same hash on next run.
     */
    markWarm(profileId, provider, prefixContent, ttlSeconds) {
        if (!this.loaded) this.load();
        const now = Date.now();
        const prefixHash = hashContent(prefixContent);
        const entry = this.data.profiles[profileId] || {};
        this.data.profiles[profileId] = {
            provider,
            prefixHash,
            createdAt: entry.prefixHash === prefixHash ? (entry.createdAt || now) : now,
            expiresAt: now + ttlSeconds * 1000,
            hitCount: entry.prefixHash === prefixHash ? (entry.hitCount || 0) : 0,
            missCount: entry.missCount || 0,
        };
        this.dirty = true;
    }

    /**
     * Check if a profile's cache is still warm for the given prefix content.
     * Returns { warm: bool, expiresIn: ms } — warm=true means caller can
     * reuse exact same prefix for guaranteed cache hit.
     */
    checkWarm(profileId, prefixContent) {
        if (!this.loaded) this.load();
        const entry = this.data.profiles[profileId];
        if (!entry) return { warm: false, expiresIn: 0, reason: 'no-entry' };
        const now = Date.now();
        if (entry.expiresAt < now) return { warm: false, expiresIn: 0, reason: 'expired' };
        const currentHash = hashContent(prefixContent);
        if (currentHash !== entry.prefixHash) {
            return { warm: false, expiresIn: 0, reason: 'hash-mismatch' };
        }
        return { warm: true, expiresIn: entry.expiresAt - now, reason: 'warm' };
    }

    recordHit(profileId) {
        const entry = this.data.profiles[profileId];
        if (entry) {
            entry.hitCount = (entry.hitCount || 0) + 1;
            this.dirty = true;
        }
    }

    recordMiss(profileId) {
        const entry = this.data.profiles[profileId];
        if (entry) {
            entry.missCount = (entry.missCount || 0) + 1;
            this.dirty = true;
        }
    }

    invalidate(profileId) {
        if (this.data.profiles[profileId]) {
            delete this.data.profiles[profileId];
            this.dirty = true;
        }
    }

    // --- OpenAI cache_key tracking ---

    trackOpenAIKey(cacheKey, retention) {
        if (!this.loaded) this.load();
        this.data.openaiKeys[cacheKey] = {
            retention,
            lastUsedAt: new Date().toISOString(),
        };
        this.dirty = true;
    }

    // --- Stats & maintenance ---

    cleanupExpired() {
        if (!this.loaded) return;
        const now = Date.now();
        let removed = 0;
        for (const [id, entry] of Object.entries(this.data.profiles)) {
            if (entry.expiresAt < now) {
                delete this.data.profiles[id];
                removed += 1;
            }
        }
        if (removed > 0) this.dirty = true;
    }

    getStats() {
        if (!this.loaded) this.load();
        const profiles = {};
        for (const [id, entry] of Object.entries(this.data.profiles)) {
            const total = (entry.hitCount || 0) + (entry.missCount || 0);
            profiles[id] = {
                provider: entry.provider,
                hitCount: entry.hitCount || 0,
                missCount: entry.missCount || 0,
                hitRate: total > 0 ? ((entry.hitCount || 0) / total) : 0,
                expiresIn: Math.max(0, entry.expiresAt - Date.now()),
            };
        }
        return {
            profileCount: Object.keys(this.data.profiles).length,
            profiles,
            openaiKeyCount: Object.keys(this.data.openaiKeys).length,
        };
    }

    // --- Singleton-style access (callers import a shared instance) ---

    static _shared = null;
    static shared() {
        if (!this._shared) {
            this._shared = new CacheRegistry();
            this._shared.load();
        }
        return this._shared;
    }
}

// --- Helpers ---

/**
 * Stable content hash — deterministic across runs as long as structure is identical.
 * Used to detect when a profile's prefix content has drifted.
 */
export function hashContent(content) {
    const canonical = typeof content === 'string'
        ? content
        : JSON.stringify(content, Object.keys(content || {}).sort());
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Default TTL (seconds) for each cache layer. Aligns with the provider
 * cache TTL. Caller can override via profile.cacheStrategy.
 */
export const DEFAULT_TTL_SECONDS = {
    '1h': 3600,
    '5m': 300,
    '24h': 86400,
    in_memory: 600, // optimistic estimate
    none: 0,
};
