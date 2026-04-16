/**
 * Smart Bridge — Profile Registry
 *
 * Profiles define stable execution contexts for the Smart Bridge router.
 * Each profile produces a deterministic prefix (system + tools + context chunks)
 * so cache hashes stay stable across sessions — the key property that makes
 * cache reuse possible.
 *
 * Profiles are opinionated defaults. User settings always win at the router
 * layer; these are just starting points.
 */

/**
 * Profile schema:
 * {
 *   id: string                        — stable identifier (used in cache registry)
 *   taskType: string                  — "maintenance" | "worker" | ...
 *   preferredProviders: string[]      — ordered fallback list, first hit wins
 *   preferredModel: string            — preset name or model id
 *   contextChunks: string[]           — chunk ids to include (rules:*, memory:*)
 *   tools: string[]                   — tool-set ids ("tools:filesystem" etc)
 *                                       special: "full" = bring everything
 *                                                "none" / [] = no tools
 *   cacheStrategy: {
 *     tools: "1h" | "5m" | "none"
 *     system: "1h" | "5m" | "none"
 *     messages: "1h" | "5m" | "none"
 *   }
 *   skip: {
 *     recap: bool                     — skip session recap injection
 *     claudemd: bool                  — skip CLAUDE.md
 *     skills: bool                    — skip skills catalogue
 *     memory: bool                    — skip memory/core memory injection
 *   }
 *   estimatedTurns: number            — heuristic (affects breakpoint placement)
 *   description: string               — human-readable summary
 * }
 */

export const BUILTIN_PROFILES = {
    // --- Maintenance: memory cycle, periodic tasks ---
    'maintenance-light': {
        id: 'maintenance-light',
        taskType: 'maintenance',
        preferredProviders: ['anthropic-oauth', 'openai-oauth', 'native'],
        preferredModel: 'haiku',
        contextChunks: [],
        tools: [],
        cacheStrategy: { tools: 'none', system: '1h', messages: 'none' },
        skip: { recap: true, claudemd: true, skills: true, memory: false },
        estimatedTurns: 1,
        description: 'Memory cycle maintenance. Fixed prompt, runs every 10min-1h, 1h cache maximizes reuse.',
    },

    // --- Worker: code implementation, full-capability agent ---
    'worker-full': {
        id: 'worker-full',
        taskType: 'worker',
        preferredProviders: ['native', 'anthropic-oauth'],
        preferredModel: 'opus-max',
        contextChunks: ['rules:workflow', 'rules:commit', 'memory:stack'],
        tools: ['tools:filesystem', 'tools:git', 'tools:mcp'],
        cacheStrategy: { tools: '1h', system: '1h', messages: '5m' },
        skip: { recap: false, claudemd: false, skills: false, memory: false },
        estimatedTurns: 8,
        description: 'Code implementation agent. Full tool access, multi-turn, stable prefix caches heavily.',
    },

    // --- Reviewer: external code review perspective ---
    'reviewer-external': {
        id: 'reviewer-external',
        taskType: 'reviewer',
        preferredProviders: ['openai-oauth', 'anthropic-oauth'],
        preferredModel: 'GPT5.4',
        contextChunks: ['rules:commit', 'memory:stack'],
        tools: ['tools:filesystem'],
        cacheStrategy: { tools: '1h', system: '1h', messages: '5m' },
        skip: { recap: true, claudemd: false, skills: true, memory: true },
        estimatedTurns: 3,
        description: 'PR/code review. External perspective (GPT5.4), read-only tools, one-shot.',
    },

    // --- Researcher: web/info lookup ---
    'researcher-minimal': {
        id: 'researcher-minimal',
        taskType: 'researcher',
        preferredProviders: ['openai-oauth', 'anthropic-oauth'],
        preferredModel: 'gpt5.4-mini',
        contextChunks: [],
        tools: ['tools:search'],
        cacheStrategy: { tools: '1h', system: '1h', messages: '5m' },
        skip: { recap: true, claudemd: true, skills: true, memory: true },
        estimatedTurns: 2,
        description: 'Web research, info lookup. Minimal context, search-only tools, cheap model.',
    },

    // --- Tester: runtime/behavior verification ---
    'tester-runtime': {
        id: 'tester-runtime',
        taskType: 'tester',
        preferredProviders: ['openai-oauth', 'anthropic-oauth'],
        preferredModel: 'GPT5.4',
        contextChunks: ['rules:workflow', 'memory:stack'],
        tools: ['tools:filesystem', 'tools:mcp'],
        cacheStrategy: { tools: '1h', system: '1h', messages: '5m' },
        skip: { recap: true, claudemd: false, skills: true, memory: true },
        estimatedTurns: 5,
        description: 'Runtime testing and behavior verification. External perspective.',
    },

    // --- Debugger: bug investigation ---
    'debugger-deep': {
        id: 'debugger-deep',
        taskType: 'debugger',
        preferredProviders: ['openai-oauth', 'anthropic-oauth'],
        preferredModel: 'GPT5.4',
        contextChunks: ['rules:workflow', 'memory:stack'],
        tools: ['tools:filesystem', 'tools:analysis', 'tools:git'],
        cacheStrategy: { tools: '1h', system: '1h', messages: '5m' },
        skip: { recap: true, claudemd: false, skills: true, memory: true },
        estimatedTurns: 6,
        description: 'Deep bug investigation. External perspective, analysis tools.',
    },

    // --- Simple: one-shot tasks (translate, format, summarize) ---
    'simple-fast': {
        id: 'simple-fast',
        taskType: 'one-shot',
        preferredProviders: ['anthropic-oauth', 'openai-oauth'],
        preferredModel: 'haiku',
        contextChunks: ['rules:writing', 'rules:comms'],
        tools: [],
        cacheStrategy: { tools: 'none', system: '5m', messages: 'none' },
        skip: { recap: true, claudemd: true, skills: true, memory: true },
        estimatedTurns: 1,
        description: 'One-shot simple tasks. Translation, formatting, summarization.',
    },

    // --- User-facing lead: interactive conversation ---
    'user-facing': {
        id: 'user-facing',
        taskType: 'lead',
        preferredProviders: ['native'],
        preferredModel: 'opus-max',
        contextChunks: ['rules:comms', 'memory:user', 'rules:workflow', 'memory:stack'],
        tools: ['full'],
        cacheStrategy: { tools: '1h', system: '1h', messages: '5m' },
        skip: { recap: false, claudemd: false, skills: false, memory: false },
        estimatedTurns: 20,
        description: 'Interactive user conversation. Full context, multi-turn, cache-heavy.',
    },
};

/**
 * Merge user-defined profile overrides with builtins.
 * User can redefine a builtin profile (by id) or add entirely new ones.
 */
export function loadProfiles(userProfiles = {}) {
    const merged = { ...BUILTIN_PROFILES };
    for (const [id, overrides] of Object.entries(userProfiles)) {
        const base = merged[id] || {};
        merged[id] = deepMerge(base, overrides, { id });
    }
    return merged;
}

export function getProfile(profiles, id) {
    return profiles[id] || null;
}

export function listProfiles(profiles) {
    return Object.values(profiles);
}

/**
 * Given a taskType, find the best matching profile (first exact match wins).
 * Returns null if no profile matches.
 */
export function findProfileForTaskType(profiles, taskType) {
    for (const p of Object.values(profiles)) {
        if (p.taskType === taskType) return p;
    }
    return null;
}

/**
 * Find a profile whose preferredModel matches the requested preset.
 * Used when caller specifies a preset directly (e.g., user sets reviewer=sonnet-high).
 */
export function findProfileForPreset(profiles, presetName) {
    for (const p of Object.values(profiles)) {
        if (p.preferredModel === presetName) return p;
    }
    return null;
}

// --- Helpers ---

function deepMerge(base, overlay, fixed = {}) {
    if (!overlay || typeof overlay !== 'object') return base;
    const out = { ...base, ...fixed };
    for (const [k, v] of Object.entries(overlay)) {
        if (fixed[k] !== undefined) continue; // fixed fields win
        if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
            out[k] = { ...base[k], ...v };
        } else {
            out[k] = v;
        }
    }
    return out;
}
