/**
 * Smart Bridge — public API
 *
 * Single entry point for the unified router + cache strategy + profile system.
 * Callers (session manager, memory cycle, bridge agents) route through here
 * instead of wiring to each sub-module directly.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadProfiles, getProfile } from './profiles.mjs';
import { SmartRouter } from './router.mjs';
import { CacheRegistry, hashContent, DEFAULT_TTL_SECONDS } from './registry.mjs';
import { buildProviderCacheOpts, computePrefixContent, ttlSecondsForProfile } from './cache-strategy.mjs';
import { getPluginData } from '../config.mjs';

let _sharedInstance = null;

export class SmartBridge {
    constructor(opts = {}) {
        this.profiles = loadProfiles(opts.userProfiles);
        this.userRoles = opts.userRoles || {};
        this.presets = Array.isArray(opts.presets) ? opts.presets : [];
        this.llmCall = opts.llmCall || null;
        this.registry = opts.registry || CacheRegistry.shared();
        this.router = new SmartRouter({
            profiles: this.profiles,
            userRoles: this.userRoles,
            llmCall: this.llmCall,
        });
    }

    /**
     * Primary routing entry. Resolves profile + preset → provider, model,
     * effort, fast, cacheOpts.
     *
     * Resolution order for preset:
     *   1. request.preset (explicit)
     *   2. userRoles[request.role] (user-workflow.json mapping)
     *   3. userRoles[profile.taskType] (fallback: taskType treated as role)
     *   4. profile.fallbackPreset (builtin default)
     */
    async resolve(request) {
        const { profile, source, reasoning } = await this.router.resolve(request);
        return this._finalize(profile, source, reasoning, request);
    }

    /**
     * Sync variant — rule-based only, no LLM fallback. Used by sync call sites
     * (createSession) that can't await.
     */
    resolveSync(request) {
        const routed = this.router.resolveSync(request);
        if (!routed) return null;
        return this._finalize(routed.profile, routed.source, null, request);
    }

    _finalize(profile, source, reasoning, request) {
        // Determine preset name
        let presetName = request.preset
            || (request.role ? this.userRoles[request.role] : null)
            || this.userRoles[profile.taskType]
            || profile.fallbackPreset
            || null;

        // Resolve preset details from config.presets catalog
        let preset = this._findPreset(presetName);

        // Translate native presets to bridge equivalents. Native presets
        // (type="native", model="opus"/"sonnet"/"haiku") are Claude Code's
        // internal runtime tokens — Smart Bridge runs outside that runtime
        // so it routes through anthropic-oauth using the subscription.
        // This is the "native → OAuth unification" that avoids duplicate
        // traffic paths.
        if (preset) preset = this._translateNativePreset(preset);

        const provider = request.provider || preset?.provider || null;
        const model = request.model || preset?.model || null;
        const effort = preset?.effort || null;
        const fast = preset?.fast === true;

        const cacheOpts = buildProviderCacheOpts(profile, provider, request.sessionId);

        return {
            profile,
            preset: preset || (presetName ? { name: presetName, id: presetName } : null),
            presetName,
            provider,
            model,
            effort,
            fast,
            source,
            reasoning: reasoning || null,
            providerCacheOpts: cacheOpts,
        };
    }

    _findPreset(name) {
        if (!name || !this.presets.length) return null;
        return this.presets.find(p => p.id === name || p.name === name) || null;
    }

    _translateNativePreset(preset) {
        // Delegate to the exported module function so callers outside this
        // class (e.g. bridge tool entry point) share the same translation.
        return translateNativePreset(preset);
    }

    /**
     * Called after a successful send to update the cache registry.
     * Records hit/miss from usage.cachedTokens when available.
     */
    recordCall(profile, provider, { systemPrompt, tools, usage }) {
        if (!profile) return;
        const prefixContent = computePrefixContent(profile, systemPrompt, tools);
        const ttlSeconds = ttlSecondsForProfile(profile);
        if (ttlSeconds > 0) {
            this.registry.markWarm(profile.id, provider, prefixContent, ttlSeconds);
        }
        const cachedTokens = usage?.cachedTokens ?? 0;
        if (cachedTokens > 0) {
            this.registry.recordHit(profile.id);
        } else if (usage?.inputTokens > 0) {
            this.registry.recordMiss(profile.id);
        }
        if (this.registry.dirty) this.registry.save();
    }

    /**
     * Called when user changes preset mapping for a role.
     * Invalidates decision cache so subsequent routes re-resolve.
     */
    updateUserRoles(userRoles) {
        this.userRoles = userRoles || {};
        this.router.updateUserRoles(this.userRoles);
    }

    /**
     * Update preset catalog — call when agent-config.json's presets change.
     */
    updatePresets(presets) {
        this.presets = Array.isArray(presets) ? presets : [];
    }

    /**
     * Full profile reload — used when profile config changes.
     */
    reload(opts = {}) {
        this.profiles = loadProfiles(opts.userProfiles);
        if (Array.isArray(opts.presets)) this.presets = opts.presets;
        this.router = new SmartRouter({
            profiles: this.profiles,
            userRoles: opts.userRoles || this.userRoles,
            llmCall: opts.llmCall || this.llmCall,
        });
    }

    getProfile(id) {
        return getProfile(this.profiles, id);
    }

    getStats() {
        return this.registry.getStats();
    }
}

/**
 * Singleton accessor. Most callers should use this.
 * Configure via init() on startup, then resolve() / recordCall() from anywhere.
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
// Map Claude Code's native preset family tokens to concrete Anthropic model
// ids. Priority order:
//   1. Claude Code runtime env var (ANTHROPIC_DEFAULT_*_MODEL) — set by the
//      harness, updated each Claude Code release when Anthropic ships a new
//      default model.
//   2. Plugin config override (config.bridge.modelFamilies).
//   3. Hardcoded current-generation fallback.
//
// This means we auto-pick up new Anthropic releases (e.g., Sonnet 4.7) the
// moment Claude Code updates its env defaults — no plugin code change needed.
const FAMILY_FALLBACK = {
    opus: 'claude-opus-4-6',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5-20251001',
};
const FAMILY_ENV = {
    opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

export function resolveAnthropicModelForFamily(family, overrides = {}) {
    const key = String(family || '').toLowerCase();
    // 1. Explicit override (user config / call site).
    if (overrides[key]) return overrides[key];
    // 2. Claude Code runtime env default (set by harness when available).
    const envVar = FAMILY_ENV[key];
    if (envVar && process.env[envVar]) return process.env[envVar];
    // 3. Cached /v1/models response — pick the most recent version alias
    //    for this family. Stays fresh because the cache itself is refreshed
    //    daily by listModels() against Anthropic's real catalog.
    const fromCache = _resolveFromCatalog(key);
    if (fromCache) return fromCache;
    // 4. Static fallback (current-generation id baked in at plugin build time).
    return FAMILY_FALLBACK[key] || null;
}

function _resolveFromCatalog(family) {
    try {
        const cachePath = join(getPluginData(), 'anthropic-oauth-models.json');
        if (!existsSync(cachePath)) return null;
        const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
        const models = Array.isArray(data?.models) ? data.models : [];

        // Preference order:
        //   1. version-tier with latest=true (e.g., claude-sonnet-4-6)
        //   2. highest version-tier alias by id sort
        //   3. highest dated-tier by id sort (for families Anthropic only ships
        //      dated ids for, e.g., haiku currently has no version alias)
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

/**
 * Translate a "native" preset label (legacy Claude Code runtime tag) to its
 * concrete anthropic-oauth provider+model pair. Native is no longer a distinct
 * path — it's an alias for the OAuth subscription route. All entry points
 * should funnel native presets through this before calling createSession().
 */
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
export { loadProfiles, getProfile, SmartRouter, CacheRegistry, hashContent, DEFAULT_TTL_SECONDS };
export { buildProviderCacheOpts, computePrefixContent, ttlSecondsForProfile };
