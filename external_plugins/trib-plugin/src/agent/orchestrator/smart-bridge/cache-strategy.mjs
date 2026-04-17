/**
 * Smart Bridge — Cache Strategy
 *
 * Two cacheTypes cover every Pool B workload:
 *   - stateful  → 1h on tools+system, 5m on messages tail.
 *                 Multi-turn workers that re-enter the same session within
 *                 minutes (worker, debugger, tester).
 *   - stateless → 1h on tools+system, no cache on messages.
 *                 Single dispatch or pooled stateless calls where the
 *                 messages tail is replaced every turn (sub-task, reviewer,
 *                 researcher, ad-hoc bridge, maintenance, webhook).
 *
 * Both share an identical tools+system prefix across the workspace, so all
 * Pool B traffic hits one Anthropic shard per model. The only difference is
 * whether the messages tail also carries a cache breakpoint.
 *
 * Providers differ in what they can express:
 *   - Anthropic: per-layer TTL via cache_control breakpoints — full control.
 *   - OpenAI public: prompt_cache_retention (in_memory / 24h) — request-level.
 *   - OpenAI Codex OAuth: no retention control — server-side default only.
 *   - Gemini: explicit cache objects (separate CRUD lifecycle).
 *   - OpenAI-compat locals (Ollama, Groq, etc.): no API-level cache.
 */

/**
 * Return the layered cache policy (Anthropic-style TTL per layer) for a cacheType.
 * Used directly by anthropic/anthropic-oauth; translated for other providers.
 *
 * Values:
 *   '1h'   → ephemeral 1h TTL  (2x write premium, 0.1x read)
 *   '5m'   → ephemeral 5m TTL  (1.25x write premium, 0.1x read)
 *   'none' → no cache_control  (1x flat, no premium, no cache)
 */
export function resolveCacheStrategy(cacheType) {
    if (cacheType === 'stateful') {
        return { tools: '1h', system: '1h', messages: '5m' };
    }
    // stateless (default) — covers sub-task, reviewer, researcher, ad-hoc,
    // maintenance, webhook, and anything unspecified.
    return { tools: '1h', system: '1h', messages: 'none' };
}

/**
 * Build provider-specific sendOpts from a cacheType + provider.
 *
 * @param {string} cacheType   — 'stateful' | 'stateless'
 * @param {string} provider
 * @param {string} [sessionId]
 * @returns {object} partial sendOpts — spread into provider.send call
 */
export function buildProviderCacheOpts(cacheType, provider, sessionId) {
    const ttls = resolveCacheStrategy(cacheType);

    switch (provider) {
        case 'anthropic-oauth':
        case 'anthropic':
            // Pass the per-layer TTL map directly — the provider translates into
            // cache_control breakpoints at render time.
            return { cacheStrategy: ttls };

        case 'openai-oauth':
            // Codex endpoint rejects prompt_cache_retention. We rely on the
            // server-side default in_memory cache (5-10min). The server still
            // prefix-caches if the prefix is reused within the in-memory window.
            return {};

        case 'openai':
            // Public OpenAI API supports prompt_cache_retention. Both cache
            // types want extended retention — the prefix is shared across
            // every Pool B call in the workspace.
            return { cacheRetention: '24h' };

        case 'gemini':
            // Gemini uses cache objects. Signal intent; the provider layer
            // creates/updates the object separately from the message.
            return {
                geminiCache: {
                    enabled: true,
                    ttlSeconds: ttlToSeconds(ttls.system),
                },
            };

        default:
            // OpenAI-compat (Groq, OpenRouter, Ollama, LMStudio, local) —
            // no API-level cache surface. Return empty; engines do their own
            // KV-cache behind the scenes.
            return {};
    }
}

/**
 * Prefix content used to derive the cache hash for registry tracking.
 * Excludes the volatile user message — only the stable prefix (tools,
 * system) determines whether our cache is "still warm". The Pool B prefix
 * is workspace-wide, so a single hash represents every Pool B caller.
 */
export function computePrefixContent(systemPrompt, tools) {
    return {
        systemPrompt: systemPrompt || '',
        tools: (tools || []).map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
    };
}

/**
 * Longest-lived layer TTL (seconds) for registry expiry tracking.
 */
export function ttlSecondsForCacheType(cacheType) {
    const ttls = resolveCacheStrategy(cacheType);
    return Math.max(
        ttlToSeconds(ttls.tools),
        ttlToSeconds(ttls.system),
        ttlToSeconds(ttls.messages),
    );
}

// --- Helpers ---

function ttlToSeconds(v) {
    if (v === '24h') return 86400;
    if (v === '1h') return 3600;
    if (v === '5m') return 300;
    return 0;
}
