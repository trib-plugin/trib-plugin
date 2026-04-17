/**
 * Smart Bridge — public API
 *
 * Resolution flow (v0.6.72, BUILTIN_PROFILES + router removed):
 *   request.role   →  getRoleConfig(role)         (user-workflow.json)
 *   request.preset →  presets[preset]             (agent-config.json presets)
 *   behavior       →  roleConfig.behavior         (stateful|stateless)
 *   cacheType      →  behavior                    (1:1 mapping)
 *
 * No profile DB, no rule layer, no BUILTIN_PROFILES. Missing role → preset
 * comes from `request.preset` → userRoles[request.role] → default preset.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { buildVirtualProfile } from './profiles.mjs';
import { CacheRegistry, hashContent, DEFAULT_TTL_SECONDS } from './registry.mjs';
import { buildProviderCacheOpts, computePrefixContent, ttlSecondsForCacheType } from './cache-strategy.mjs';
import { getPluginData } from '../config.mjs';

let _sharedInstance = null;

// Role resolver injected by agent/index.mjs at boot. Avoids lazy-import
// circular dependency between the two modules.
let _getRoleConfig = null;

/**
 * Install the role-config lookup. Called once by agent/index.mjs after
 * the user-workflow.json cache is populated.
 */
export function setRoleResolver(fn) {
    _getRoleConfig = typeof fn === 'function' ? fn : null;
}

async function _lazyGetRoleConfig(role) {
    if (_getRoleConfig) return _getRoleConfig(role);
    // Fallback: try a dynamic import. This path only executes when a
    // caller reaches resolve() before agent/init() ran — unusual, but
    // kept so tests and scripts can use SmartBridge standalone.
    try {
        const mod = await import('../../index.mjs');
        if (typeof mod.getRoleConfig === 'function') {
            _getRoleConfig = mod.getRoleConfig;
            return _getRoleConfig(role);
        }
    } catch { /* ignore */ }
    return null;
}

function _syncGetRoleConfig(role) {
    if (_getRoleConfig) return _getRoleConfig(role);
    return null;
}

export class SmartBridge {
    constructor(opts = {}) {
        this.userRoles = opts.userRoles || {};
        this.presets = Array.isArray(opts.presets) ? opts.presets : [];
        this.llmCall = opts.llmCall || null;
        this.registry = opts.registry || CacheRegistry.shared();
    }

    /**
     * Async resolution — used by bridge-llm and any caller that can await.
     * Returns the same shape as resolveSync but falls back to the default
     * preset when no role config is found.
     */
    async resolve(request) {
        const role = request?.role || request?.taskType || null;
        const roleConfig = role ? await _lazyGetRoleConfig(role) : null;
        return this._finalize(roleConfig, request || {});
    }

    /**
     * Sync variant — used by createSession and the bridge tool entry point.
     * Returns null only when called before agent init has populated the
     * role-config cache. Callers fall back to classic preset behaviour.
     */
    resolveSync(request) {
        if (!request) return null;
        const role = request.role || request.taskType || null;
        const roleConfig = role ? _syncGetRoleConfig(role) : null;
        return this._finalize(roleConfig, request);
    }

    _finalize(roleConfig, request) {
        const profile = buildVirtualProfile(roleConfig);

        let presetName = request.preset
            || (request.role ? this.userRoles[request.role] : null)
            || (roleConfig?.preset || null)
            || null;

        let preset = this._findPreset(presetName);
        if (preset) preset = this._translateNativePreset(preset);

        const provider = request.provider || preset?.provider || null;
        const model = request.model || preset?.model || null;
        const effort = preset?.effort || null;
        const fast = preset?.fast === true;

        // cacheType derived from role behaviour — single source of truth.
        const cacheType = roleConfig?.behavior === 'stateless' ? 'stateless' : 'stateful';
        const cacheOpts = buildProviderCacheOpts(cacheType, provider, request.sessionId);

        return {
            profile,
            preset: preset || (presetName ? { name: presetName, id: presetName } : null),
            presetName,
            provider,
            model,
            effort,
            fast,
            source: roleConfig ? 'role-config' : 'default',
            reasoning: null,
            providerCacheOpts: cacheOpts,
        };
    }

    _findPreset(name) {
        if (!name || !this.presets.length) return null;
        return this.presets.find(p => p.id === name || p.name === name) || null;
    }

    _translateNativePreset(preset) {
        return translateNativePreset(preset);
    }

    /**
     * Called after a successful send to update the cache registry. Records
     * hit/miss from usage.cachedTokens when available. The registry keys on
     * the profile id (which is the role name post-refactor).
     */
    recordCall(profile, provider, { systemPrompt, tools, usage }) {
        if (!profile) return;
        const prefixContent = computePrefixContent(systemPrompt, tools);
        const ttlSeconds = ttlSecondsForCacheType(profile?.cacheType);
        if (ttlSeconds > 0) {
            this.registry.markWarm(profile.id, provider, prefixContent, ttlSeconds);
        }
        const cachedTokens = usage?.cachedTokens ?? 0;
        if (cachedTokens > 0) {
            this.registry.recordHit(profile.id, provider);
        } else if (usage?.inputTokens > 0) {
            this.registry.recordMiss(profile.id, provider);
        }
        if (this.registry.dirty) this.registry.save();
    }

    /**
     * Called when user changes preset mapping for a role.
     */
    updateUserRoles(userRoles) {
        this.userRoles = userRoles || {};
    }

    /**
     * Update preset catalog — call when agent-config.json's presets change.
     */
    updatePresets(presets) {
        this.presets = Array.isArray(presets) ? presets : [];
    }

    /**
     * Returns a virtual profile for a role id. Used by session manager to
     * rehydrate the profile object after session reload.
     */
    getProfile(id) {
        if (!id) return null;
        const roleConfig = _syncGetRoleConfig(id);
        return buildVirtualProfile(roleConfig);
    }

    getStats() {
        return this.registry.getStats();
    }
}

/**
 * Singleton accessor.
 */
export function initSmartBridge(opts = {}) {
    _sharedInstance = new SmartBridge(opts);
    return _sharedInstance;
}

export function getSmartBridge() {
    if (!_sharedInstance) {
        _sharedInstance = new SmartBridge();
    }
    return _sharedInstance;
}

// --- Model family resolution --------------------------------------------
// Unchanged from v0.6.71.
const FAMILY_FALLBACK = {
    opus:   ['claude-opus-4-7',          'claude-opus-4-6'],
    sonnet: ['claude-sonnet-4-6'],
    haiku:  ['claude-haiku-4-5-20251001'],
};
const FAMILY_ENV = {
    opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

export function resolveAnthropicModelForFamily(family, overrides = {}) {
    const key = String(family || '').toLowerCase();
    if (overrides[key]) return overrides[key];
    const envVar = FAMILY_ENV[key];
    if (envVar && process.env[envVar]) return process.env[envVar];
    const fromCache = _resolveFromCatalog(key);
    if (fromCache) return fromCache;
    const chain = FAMILY_FALLBACK[key];
    return Array.isArray(chain) ? chain[0] : (chain || null);
}

export function nextFallbackModel(currentModel) {
    for (const chain of Object.values(FAMILY_FALLBACK)) {
        const idx = chain.indexOf(currentModel);
        if (idx >= 0 && idx < chain.length - 1) {
            process.stderr.write(`[smart-bridge] model ${currentModel} unavailable, falling back to ${chain[idx + 1]}\n`);
            return chain[idx + 1];
        }
    }
    return null;
}

function _resolveFromCatalog(family) {
    try {
        const cachePath = join(getPluginData(), 'anthropic-oauth-models.json');
        if (!existsSync(cachePath)) return null;
        const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
        const models = Array.isArray(data?.models) ? data.models : [];

        const sameFamily = models.filter(m => m.family === family);
        if (sameFamily.length === 0) return null;

        const versioned = sameFamily.filter(m => m.tier === 'version');
        if (versioned.length > 0) {
            const latest = versioned.find(m => m.latest)
                        || [...versioned].sort((a, b) => b.id.localeCompare(a.id))[0];
            if (latest?.id) return latest.id;
        }

        const dated = sameFamily.filter(m => m.tier === 'dated');
        if (dated.length > 0) {
            const latestDated = [...dated].sort((a, b) => b.id.localeCompare(a.id))[0];
            if (latestDated?.id) return latestDated.id;
        }

        return null;
    } catch { return null; }
}

export function translateNativePreset(preset) {
    if (preset?.type !== 'native') return preset;
    const model = resolveAnthropicModelForFamily(preset.model);
    if (!model) return preset;
    return {
        ...preset,
        provider: 'anthropic-oauth',
        model,
    };
}

// Re-exports for convenience.
export { CacheRegistry, hashContent, DEFAULT_TTL_SECONDS };
export { buildProviderCacheOpts, computePrefixContent, ttlSecondsForCacheType };
export { buildVirtualProfile };
