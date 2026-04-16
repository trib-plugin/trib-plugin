/**
 * Smart Bridge — Profile Registry
 *
 * Profiles define the SHAPE of execution (lifecycle, context chunks, tools,
 * skip flags). Model/provider selection comes from user-workflow.json + the
 * agent-config.json preset catalog — profiles never duplicate that.
 *
 * Resolution at runtime:
 *   1. Router picks profile by role / taskType / profileId
 *   2. Smart Bridge looks up user role → preset (user-workflow.json)
 *      → falls back to profile.fallbackPreset if no mapping
 *   3. Preset resolves to provider + model + effort + fast (agent-config.json)
 *   4. Cache strategy is derived from profile.lifecycle (not hardcoded)
 */

/**
 * Profile schema:
 * {
 *   id: string
 *   taskType: string              — "maintenance" | "worker" | ...
 *   lifecycle: "one-shot" | "recurring" | "continuous"
 *   recurrenceIntervalMs?: number — hint for recurring lifecycle
 *                                    < 1h → use cache, >= 1h → no cache
 *   contextChunks: string[]       — rules:*, memory:* chunk ids
 *   tools: string[]               — tool-set ids ("full" / "none" / specific)
 *   skip: { claudemd, skills, memory }
 *   fallbackPreset: string        — preset name if no user role mapping
 *   estimatedTurns: number
 *   description: string
 * }
 */

export const BUILTIN_PROFILES = {
    'maintenance-light': {
        id: 'maintenance-light',
        taskType: 'maintenance',
        lifecycle: 'recurring',
        recurrenceIntervalMs: 10 * 60_000,  // 10min cycle1; well inside 1h
        contextChunks: [],
        tools: [],
        skip: { claudemd: true, skills: true, memory: false },
        fallbackPreset: 'haiku',
        estimatedTurns: 1,
        description: 'Memory cycle maintenance. Minimal prompt, runs every 10min, 1h cache maximizes reuse.',
    },

    'worker-full': {
        id: 'worker-full',
        taskType: 'worker',
        lifecycle: 'continuous',
        contextChunks: ['rules:workflow', 'rules:commit', 'memory:stack'],
        tools: ['tools:filesystem', 'tools:git', 'tools:mcp'],
        skip: { claudemd: false, skills: false, memory: false },
        fallbackPreset: 'opus-max',
        estimatedTurns: 8,
        description: 'Code implementation agent. Full tool access, multi-turn, stable prefix heavy-caches.',
    },

    'reviewer-external': {
        id: 'reviewer-external',
        taskType: 'reviewer',
        lifecycle: 'one-shot',
        contextChunks: ['rules:commit', 'memory:stack'],
        tools: ['tools:filesystem'],
        skip: { claudemd: false, skills: true, memory: true },
        fallbackPreset: 'GPT5.4',
        estimatedTurns: 3,
        description: 'PR/code review. External perspective, read-only, no-cache (one-shot).',
    },

    'researcher-minimal': {
        id: 'researcher-minimal',
        taskType: 'researcher',
        lifecycle: 'one-shot',
        contextChunks: [],
        tools: ['tools:search'],
        skip: { claudemd: true, skills: true, memory: true },
        fallbackPreset: 'gpt5.4-mini',
        estimatedTurns: 2,
        description: 'Web research / info lookup. Minimal context, no-cache.',
    },

    'tester-runtime': {
        id: 'tester-runtime',
        taskType: 'tester',
        lifecycle: 'continuous',
        contextChunks: ['rules:workflow', 'memory:stack'],
        tools: ['tools:filesystem', 'tools:mcp'],
        skip: { claudemd: false, skills: true, memory: true },
        fallbackPreset: 'GPT5.4',
        estimatedTurns: 5,
        description: 'Runtime testing and behavior verification.',
    },

    'debugger-deep': {
        id: 'debugger-deep',
        taskType: 'debugger',
        lifecycle: 'continuous',
        contextChunks: ['rules:workflow', 'memory:stack'],
        tools: ['tools:filesystem', 'tools:analysis', 'tools:git'],
        skip: { claudemd: false, skills: true, memory: true },
        fallbackPreset: 'GPT5.4',
        estimatedTurns: 6,
        description: 'Deep bug investigation. Analysis tools, multi-turn.',
    },

    'simple-fast': {
        id: 'simple-fast',
        taskType: 'one-shot',
        lifecycle: 'one-shot',
        contextChunks: ['rules:writing', 'rules:comms'],
        tools: [],
        skip: { claudemd: true, skills: true, memory: true },
        fallbackPreset: 'haiku',
        estimatedTurns: 1,
        description: 'One-shot tasks (translate, format, summarize). No-cache, 20% cheaper.',
    },

    'user-facing': {
        id: 'user-facing',
        taskType: 'lead',
        lifecycle: 'continuous',
        contextChunks: ['rules:comms', 'memory:user', 'rules:workflow', 'memory:stack'],
        tools: ['full'],
        skip: { claudemd: false, skills: false, memory: false },
        fallbackPreset: 'opus-max',
        estimatedTurns: 20,
        description: 'Interactive user conversation. Full context, multi-turn.',
    },
};

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

export function findProfileForTaskType(profiles, taskType) {
    for (const p of Object.values(profiles)) {
        if (p.taskType === taskType) return p;
    }
    return null;
}

/**
 * Find a profile whose fallbackPreset matches. Used when the caller specifies
 * a preset directly but we still want profile-based cache/context decisions.
 */
export function findProfileForPreset(profiles, presetName) {
    for (const p of Object.values(profiles)) {
        if (p.fallbackPreset === presetName) return p;
    }
    return null;
}

// --- Helpers ---

function deepMerge(base, overlay, fixed = {}) {
    if (!overlay || typeof overlay !== 'object') return base;
    const out = { ...base, ...fixed };
    for (const [k, v] of Object.entries(overlay)) {
        if (fixed[k] !== undefined) continue;
        if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
            out[k] = { ...base[k], ...v };
        } else {
            out[k] = v;
        }
    }
    return out;
}
