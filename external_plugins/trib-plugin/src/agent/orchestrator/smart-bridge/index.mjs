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
        this.llmCall = opts.llmCall || null;
        this.registry = opts.registry || CacheRegistry.shared();
        this.router = new SmartRouter({
            profiles: this.profiles,
            userRoles: this.userRoles,
            llmCall: this.llmCall,
        });
    }

    /**
     * Primary routing entry. Given a request, returns:
     *   - profile         chosen Profile object
     *   - providerCacheOpts  partial sendOpts to merge into provider.send()
     *   - cacheKey        identifier for cache tracking
     *   - warm            whether provider cache is likely hot (skip cold-start)
     *
     * Callers then do:
     *   const { profile, providerCacheOpts } = await smartBridge.resolve(req);
     *   const sendOpts = { ...baseSendOpts, ...providerCacheOpts };
     *   provider.send(messages, model, tools, sendOpts);
     *   smartBridge.recordCall(profile, provider, { hit, ... });
     */
    async resolve(request) {
        const { profile, source, reasoning } = await this.router.resolve(request);
        const providerName = request.provider || profile.preferredProviders?.[0] || 'native';
        const cacheOpts = buildProviderCacheOpts(profile, providerName, request.sessionId);
        return {
            profile,
            provider: providerName,
            source,
            reasoning: reasoning || null,
            providerCacheOpts: cacheOpts,
        };
    }

    /**
     * Sync variant — rule-based only, no LLM fallback. Returns null if no
     * rule matches (callers should handle by using request.provider/preset
     * directly or falling back to default behavior).
     *
     * Used by sync call sites (createSession) that can't await.
     */
    resolveSync(request) {
        const routed = this.router.resolveSync(request);
        if (!routed) return null;
        const providerName = request.provider || routed.profile.preferredProviders?.[0] || 'native';
        const cacheOpts = buildProviderCacheOpts(routed.profile, providerName, request.sessionId);
        return {
            profile: routed.profile,
            provider: providerName,
            source: routed.source,
            providerCacheOpts: cacheOpts,
        };
    }

    /**
     * Called after a successful send to update the cache registry.
     * Also records whether this was a hit or miss (from usage data).
     */
    recordCall(profile, provider, { systemPrompt, tools, usage }) {
        if (!profile) return;
        const prefixContent = computePrefixContent(profile, systemPrompt, tools);
        const ttlSeconds = ttlSecondsForProfile(profile);
        if (ttlSeconds > 0) {
            this.registry.markWarm(profile.id, provider, prefixContent, ttlSeconds);
        }
        // Hit if any cache_read tokens came back. For providers that don't
        // expose that (most openai-compat), we treat as unknown → no record.
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
     * Full profile reload — used when profile config changes.
     */
    reload(opts = {}) {
        this.profiles = loadProfiles(opts.userProfiles);
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
