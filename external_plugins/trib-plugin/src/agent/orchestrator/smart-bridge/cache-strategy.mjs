/**
 * Smart Bridge — Cache Strategy
 *
 * Stateless-only (v0.6.96+). All bridge calls are stateless: messages tail
 * is freshly composed per call, sessions are ephemeral, and there is no
 * cross-call message cache. Only the prefix (tools + system) is cached.
 *
 * Providers differ in what they can express:
 *   - Anthropic: per-layer TTL via cache_control breakpoints — full control.
 *   - OpenAI public: prompt_cache_retention (in_memory / 24h) — request-level.
 *   - OpenAI Codex OAuth: no retention control — server-side default only.
 *   - Gemini: explicit cache objects (separate CRUD lifecycle).
 *   - OpenAI-compat locals (Ollama, Groq, etc.): no API-level cache.
 */

/**
 * Return the layered cache policy. Single fixed strategy now that all
 * bridge calls are stateless: cache the prefix (tools + system), never
 * cache the messages tail.
 *
 * Values:
 *   '1h'   → ephemeral 1h TTL  (2x write premium, 0.1x read)
 *   '5m'   → ephemeral 5m TTL  (1.25x write premium, 0.1x read)
 *   'none' → no cache_control  (1x flat, no premium, no cache)
 *
 * The cacheType parameter is accepted for backward compatibility but
 * ignored; legacy callers passing 'stateful' get the same stateless
 * policy as everyone else.
 */
export function resolveCacheStrategy(_cacheType) {
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
            // 2026-03-06 Anthropic dropped default TTL 1h→5m. We send
            // extended-cache-ttl-2025-04-11 header to retain 1h.
            // Verified 2026-04-17 (ephemeral_1h_input_tokens=4722).
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

        case 'groq':
            // Auto prompt cache since 2025-12 (gpt-oss-120b, 50% saving). No code-level control.
            return {};

        case 'openrouter':
            // Passes anthropic beta cache_control for supported backends
            return { cacheStrategy: ttls };

        case 'xai':
            // No public prompt cache API (as of 2026-04)
            return {};

        case 'copilot':
            // Consumer API, no prompt cache controls
            return {};

        case 'ollama':
            // Local KV cache only, no API-level surface
            return {};

        case 'lmstudio':
            // Local, no API cache
            return {};

        default:
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
