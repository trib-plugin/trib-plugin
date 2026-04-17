/**
 * Smart Bridge — Profile Registry
 *
 * Profiles only carry routing + cacheType + role-level metadata. The system
 * prompt + tool schema are unified across every Pool B caller so all traffic
 * shares one cache shard per provider × model. Role-specific behaviour lives
 * in `rules/roles/{role}.md` injected into the Tier 3 system-reminder.
 *
 * Resolution at runtime:
 *   1. Router picks profile by role / taskType / profileId
 *   2. Smart Bridge looks up user role → preset (user-workflow.json)
 *      → falls back to profile.fallbackPreset if no mapping
 *   3. Preset resolves to provider + model + effort + fast (agent-config.json)
 *   4. Cache strategy is derived from profile.cacheType
 */

/**
 * Profile schema:
 * {
 *   id: string
 *   taskType: string              — "maintenance" | "worker" | ...
 *   cacheType: "stateful" | "stateless"
 *   behavior?: "stateless"        — pool reuse semantics (sub-task)
 *   fallbackPreset: string        — preset name if no user role mapping
 *   description: string
 * }
 *
 * tools and skip are intentionally not per-profile — every Pool B call
 * gets the same `tools: ['full']` and full system prefix so BP_1/BP_2
 * hashes stay identical across roles. Per-role narrowing happens in the
 * Tier 3 role.md injected into messages, not in the cached prefix.
 */

const UNIFIED_TOOLS = ['full'];
const UNIFIED_SKIP = { claudemd: false, skills: false, memory: false };

function profile(id, taskType, cacheType, fallbackPreset, description, extra = {}) {
    return {
        id,
        taskType,
        cacheType,
        tools: UNIFIED_TOOLS,
        skip: UNIFIED_SKIP,
        fallbackPreset,
        description,
        ...extra,
    };
}

export const BUILTIN_PROFILES = {
    'maintenance-light': profile(
        'maintenance-light', 'maintenance', 'stateless', 'haiku',
        'Memory cycle maintenance. Minimal prompt, runs every ~10min.',
    ),

    'worker-full': profile(
        'worker-full', 'worker', 'stateful', 'opus-max',
        'Code implementation agent. Multi-turn, stable prefix heavy-caches.',
    ),

    'reviewer-external': profile(
        'reviewer-external', 'reviewer', 'stateless', 'GPT5.4',
        'PR/code review. External perspective, read-only.',
    ),

    'researcher-minimal': profile(
        'researcher-minimal', 'researcher', 'stateless', 'gpt5.4-mini',
        'Web research / info lookup.',
    ),

    'tester-runtime': profile(
        'tester-runtime', 'tester', 'stateful', 'GPT5.4',
        'Runtime testing and behavior verification.',
    ),

    'debugger-deep': profile(
        'debugger-deep', 'debugger', 'stateful', 'GPT5.4',
        'Deep bug investigation. Multi-turn.',
    ),

    'simple-fast': profile(
        'simple-fast', 'one-shot', 'stateless', 'haiku',
        'One-shot tasks (translate, format, summarize).',
    ),

    'user-facing': profile(
        'user-facing', 'lead', 'stateful', 'opus-max',
        'Interactive user conversation. Multi-turn.',
    ),

    'sub-task': profile(
        'sub-task', 'sub', 'stateless', 'GPT5.4',
        'Unified sub-agent profile (reviewer / tester / debugger / researcher). Prefix-handle reuse across roles; messages reset per dispatch so task-briefs never leak between calls.',
        { behavior: 'stateless' },
    ),

    'scheduler-task': profile(
        'scheduler-task', 'scheduler-task', 'stateless', 'sonnet-mid',
        'Scheduled channel task. Cron-triggered one-shot LLM call.',
    ),

    'proactive-decision': profile(
        'proactive-decision', 'proactive-decision', 'stateless', 'sonnet-mid',
        'Proactive channel decision (fire/defer/skip). JSON-structured output.',
    ),

    'webhook-handler': profile(
        'webhook-handler', 'webhook-handler', 'stateless', 'sonnet-mid',
        'Webhook event analyser. One-shot external model call.',
    ),
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
 * a preset directly but we still want profile-based cache decisions.
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
