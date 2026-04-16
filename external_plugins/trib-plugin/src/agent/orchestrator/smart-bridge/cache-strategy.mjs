/**
 * Smart Bridge — Cache Strategy
 *
 * Translates a profile's cache preferences into provider-specific options.
 * Each provider exposes different cache knobs; this module is the single
 * place that knows how to map between them.
 *
 * Providers:
 *   - anthropic-oauth / anthropic: 4 cache_control breakpoints, 5m/1h TTL
 *   - openai-oauth / openai: prompt_cache_key + prompt_cache_retention (in_memory/24h)
 *   - gemini: explicit cache objects (separate CRUD lifecycle)
 *   - openai-compat (Groq, Ollama, etc.): no API-level cache, engine-level only
 */

/**
 * Build provider-specific sendOpts from a profile's cacheStrategy.
 *
 * @param {object} profile  — profile with cacheStrategy field
 * @param {string} provider — provider name
 * @param {string} sessionId
 * @returns {object} partial sendOpts to merge into the provider call
 */
export function buildProviderCacheOpts(profile, provider, sessionId) {
    const strategy = profile?.cacheStrategy || defaultStrategy();

    switch (provider) {
        case 'anthropic-oauth':
        case 'anthropic':
            return {
                cacheStrategy: {
                    tools: strategy.tools || '1h',
                    system: strategy.system || '1h',
                    messages: strategy.messages || '5m',
                },
            };

        case 'openai-oauth':
        case 'openai': {
            // Retention: "24h" for multi-turn / repeated profiles, "in_memory" for one-shot.
            // Rule: if any layer is "1h" or "none with short-lived messages", treat as multi-turn → 24h.
            const multiTurn = strategy.tools === '1h' || strategy.system === '1h';
            return {
                cacheRetention: multiTurn ? '24h' : 'in_memory',
                // prompt_cache_key is set by caller based on profile.id or sessionId.
            };
        }

        case 'gemini':
            // Gemini uses external cache objects. Profile-aware provisioning
            // happens in the gemini provider itself; here we just signal intent.
            return {
                geminiCache: {
                    enabled: strategy.system !== 'none',
                    ttlSeconds: strategy.system === '1h' ? 3600 : 300,
                    // The actual cache object is created/updated by the provider
                    // when buildProviderCacheOpts is consumed.
                },
            };

        default:
            // OpenAI-compat providers (Groq, OpenRouter, Ollama, LMStudio, etc.)
            // have no standardized cache-control API. We pass through any
            // hints but the provider is free to ignore them.
            return {};
    }
}

/**
 * Compute the prefix content that goes into the cache hash.
 * This is the stable portion of the request: tools + system prompt + context chunks.
 *
 * The user message and volatile chat history are NOT included — those vary per call
 * and must not affect whether we consider a profile's cache warm.
 */
export function computePrefixContent(profile, systemPrompt, tools) {
    return {
        profileId: profile.id,
        systemPrompt: systemPrompt || '',
        tools: (tools || []).map(t => ({
            name: t.name,
            description: t.description,
            // inputSchema included — tool shape changes invalidate the cache.
            inputSchema: t.inputSchema,
        })),
        chunks: (profile.contextChunks || []).slice().sort(),
    };
}

/**
 * Return the expected TTL in seconds for the top-level (stable) cache layer.
 * Used to update the cache registry expiry.
 */
export function ttlSecondsForProfile(profile) {
    // Pick the longest-lived layer: if any layer caches at 1h, the prefix
    // lives at least that long. "none" doesn't count — it just means that
    // layer doesn't participate in caching (e.g., no tools defined).
    const strat = profile?.cacheStrategy || {};
    const layers = [strat.tools, strat.system, strat.messages];
    const toSeconds = (v) => {
        if (v === '24h') return 86400;
        if (v === '1h') return 3600;
        if (v === '5m') return 300;
        return 0;
    };
    return Math.max(...layers.map(toSeconds), 0);
}

function defaultStrategy() {
    return { tools: '1h', system: '1h', messages: '5m' };
}
