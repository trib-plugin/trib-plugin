/**
 * Smart Bridge — public API
 *
 * Single entry point for the unified router + cache strategy + profile system.
 * Callers (session manager, memory cycle, bridge agents) route through here
 * instead of wiring to each sub-module directly.
 */

import { loadProfiles, getProfile } from './profiles.mjs';
import { SmartRouter } from './router.mjs';
import { CacheRegistry, hashContent, DEFAULT_TTL_SECONDS } from './registry.mjs';
import { buildProviderCacheOpts, computePrefixContent, ttlSecondsForProfile } from './cache-strategy.mjs';

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
        if (preset?.type !== 'native') return preset;
        // Claude Code's native preset.model is a coarse family token ("opus",
        // "sonnet", "haiku"). Map to the concrete Anthropic model id usable
        // by anthropic-oauth. When Anthropic releases new model versions the
        // one place to update is here.
        const NATIVE_TO_ANTHROPIC = {
            opus: 'claude-opus-4-6',
            sonnet: 'claude-sonnet-4-6',
            haiku: 'claude-haiku-4-5-20251001',
        };
        const model = NATIVE_TO_ANTHROPIC[preset.model];
        if (!model) return preset; // unknown family — let caller handle
        return {
            ...preset,
            provider: 'anthropic-oauth',
            model,
            // effort/fast preserved from the original preset.
        };
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

// Re-exports for convenience.
export { loadProfiles, getProfile, SmartRouter, CacheRegistry, hashContent, DEFAULT_TTL_SECONDS };
export { buildProviderCacheOpts, computePrefixContent, ttlSecondsForProfile };
