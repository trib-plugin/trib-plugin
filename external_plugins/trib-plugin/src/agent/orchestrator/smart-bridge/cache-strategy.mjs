/**
 * Smart Bridge — Cache Strategy
 *
 * Derives provider-specific cache settings from profile.lifecycle. Profiles
 * declare WHAT kind of workload they are (one-shot / recurring / continuous);
 * this module decides HOW to cache given that lifecycle + provider.
 *
 * Key decisions encoded here:
 *   - one-shot: never cache (cache write premium has no payoff when there's
 *     no re-read in the TTL window). 20% cheaper than 5m cache for true
 *     single-call prompts.
 *   - recurring: depends on interval.
 *       interval < 1h → 1h cache (fits within TTL, read discount applies).
 *       interval >= 1h → no cache (cache expires before next call, write
 *       premium is pure waste).
 *   - continuous: 1h on stable layers (tools, system) + 5m on messages
 *     sliding breakpoint for multi-turn sessions.
 *
 * Providers differ in what they can express:
 *   - Anthropic: per-layer TTL via cache_control breakpoints — full control.
 *   - OpenAI public: prompt_cache_retention (in_memory / 24h) — request-level.
 *   - OpenAI Codex OAuth: no retention control — server-side default only.
 *   - Gemini: explicit cache objects (separate CRUD lifecycle).
 *   - OpenAI-compat locals (Ollama, Groq, etc.): no API-level cache.
 */

const ANTHROPIC_1H_WINDOW_MS = 60 * 60_000;

/**
 * Return the layered cache policy (Anthropic-style TTL per layer) for a profile.
 * Used directly by anthropic/anthropic-oauth; translated for other providers.
 *
 * Values:
 *   '1h'   → ephemeral 1h TTL  (2x write premium, 0.1x read)
 *   '5m'   → ephemeral 5m TTL  (1.25x write premium, 0.1x read)
 *   'none' → no cache_control  (1x flat, no premium, no cache)
 */
export function resolveLifecycleCacheStrategy(profile) {
    const lifecycle = profile?.lifecycle || 'one-shot';

    if (lifecycle === 'one-shot') {
        return { tools: 'none', system: 'none', messages: 'none' };
    }

    if (lifecycle === 'continuous') {
        return { tools: '1h', system: '1h', messages: '5m' };
    }

    if (lifecycle === 'recurring') {
        const interval = Number(profile?.recurrenceIntervalMs) || 0;
        // Unknown interval: assume "short enough" (1h) as the safer default —
        // pays write premium once but catches reuse if it happens.
        if (interval === 0) {
            return { tools: '1h', system: '1h', messages: 'none' };
        }
        // Short interval: cache fits within 1h TTL — read discount pays for
        // write premium after ~3 calls.
        if (interval < ANTHROPIC_1H_WINDOW_MS) {
            return { tools: '1h', system: '1h', messages: 'none' };
        }
        // Long interval: cache always expires before next call — write premium
        // is pure waste. No-cache is 50% cheaper.
        return { tools: 'none', system: 'none', messages: 'none' };
    }

    // Unknown lifecycle — be safe.
    return { tools: 'none', system: 'none', messages: 'none' };
}

/**
 * Build provider-specific sendOpts from a profile + provider.
 *
 * @param {object} profile
 * @param {string} provider
 * @param {string} [sessionId]
 * @returns {object} partial sendOpts — spread into provider.send call
 */
export function buildProviderCacheOpts(profile, provider, sessionId) {
    const ttls = resolveLifecycleCacheStrategy(profile);

    switch (provider) {
        case 'anthropic-oauth':
        case 'anthropic':
            // Pass the per-layer TTL map directly — the provider translates into
            // cache_control breakpoints at render time.
            return { cacheStrategy: ttls };

        case 'openai-oauth':
            // Codex endpoint rejects prompt_cache_retention. We rely on the
            // server-side default in_memory cache (5-10min). For one-shot
            // profiles the server will still prefix-cache if the prefix is
            // reused within the in-memory window, so no user action needed.
            return {};

        case 'openai': {
            // Public OpenAI API supports prompt_cache_retention. Map lifecycle:
            //   one-shot → in_memory (default; 5-10min, no commitment)
            //   recurring/continuous → 24h for extended retention
            const lifecycle = profile?.lifecycle || 'one-shot';
            if (lifecycle === 'one-shot') return { cacheRetention: 'in_memory' };
            return { cacheRetention: '24h' };
        }

        case 'gemini':
            // Gemini uses cache objects. Signal intent; the provider layer
            // creates/updates the object separately from the message.
            return {
                geminiCache: {
                    enabled: ttls.system !== 'none',
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
 * system, contextChunks) determines whether our cache is "still warm".
 */
export function computePrefixContent(profile, systemPrompt, tools) {
    return {
        profileId: profile?.id,
        systemPrompt: systemPrompt || '',
        tools: (tools || []).map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        })),
        chunks: (profile?.contextChunks || []).slice().sort(),
    };
}

/**
 * Longest-lived layer TTL (seconds) for registry expiry tracking.
 */
export function ttlSecondsForProfile(profile) {
    const ttls = resolveLifecycleCacheStrategy(profile);
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
