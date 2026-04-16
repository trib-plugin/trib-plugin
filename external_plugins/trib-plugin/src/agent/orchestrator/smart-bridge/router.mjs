/**
 * Smart Bridge — Router
 *
 * Decides which profile to use for an incoming request. Runs in two layers:
 *
 *   Layer 1 (Rule-based): explicit taskType or preset match → instant decision.
 *                          Zero cost. Covers the majority of cases.
 *
 *   Layer 2 (LLM-based):  for ambiguous requests, ask haiku which profile
 *                          fits best. ~1-2s, ~300 tokens. Result can be
 *                          cached so repeated patterns graduate to Layer 1.
 *
 * The router never violates user preferences — if a user preset maps
 * reviewer→sonnet-high, we find the profile that matches that preset,
 * not the one that the LLM "thinks" is best.
 */

import { findProfileForTaskType, findProfileForPreset, getProfile } from './profiles.mjs';

// LLM router system prompt template. Filled with current profiles + user roles
// at invocation time. Kept here (not a file) so it's import-time stable
// and can benefit from Anthropic cache.
const LLM_ROUTER_TEMPLATE = `You are the Smart Bridge router. Given a task description, pick the best profile from the registry.

## Available Profiles
{{PROFILES}}

## User Role Preferences
{{USER_ROLES}}

Rules:
1. If the task clearly matches a user role (worker, reviewer, researcher, tester, debugger), pick the profile whose taskType or preferredModel matches that role.
2. Prefer profiles that align with user preferences when multiple fit.
3. For ambiguous tasks, choose the most minimal profile that can handle it.

Respond ONLY with JSON:
{"profileId": "id", "reasoning": "1 sentence"}`;

export class SmartRouter {
    /**
     * @param {object} opts
     * @param {object} opts.profiles  — profile map from loadProfiles()
     * @param {object} opts.userRoles — { worker: "opus-max", reviewer: "GPT5.4", ... }
     * @param {function} opts.llmCall — async (systemPrompt, userMsg) => string
     *                                   Used for Layer 2. If not provided, Layer 2 disabled.
     * @param {object} opts.decisionCache — optional { get(key), set(key, value) }
     */
    constructor(opts = {}) {
        this.profiles = opts.profiles || {};
        this.userRoles = opts.userRoles || {};
        this.llmCall = opts.llmCall || null;
        this.decisionCache = opts.decisionCache || new Map();
    }

    /**
     * Resolve a profile for the given request.
     *
     * @param {object} request
     * @param {string} [request.taskType]    — explicit task type hint
     * @param {string} [request.preset]      — explicit preset (overrides taskType)
     * @param {string} [request.description] — natural-language task description (for Layer 2)
     * @param {string} [request.role]        — user-defined role (worker, reviewer, ...)
     * @returns {Promise<{ profile, source }>}  source = "explicit" | "rule" | "llm" | "default"
     */
    async resolve(request) {
        // --- Layer 0: explicit profile id ---
        if (request.profileId) {
            const p = getProfile(this.profiles, request.profileId);
            if (p) return { profile: p, source: 'explicit' };
        }

        // --- Layer 1a: user role ---
        // Role is more specific than preset — match taskType first so profiles
        // with distinct taskType but shared preset resolve correctly (e.g., both
        // reviewer and tester use GPT5.4, but have different profiles).
        if (request.role) {
            const taskMatch = findProfileForTaskType(this.profiles, request.role);
            if (taskMatch) return { profile: taskMatch, source: 'rule-role' };
            const preset = this.userRoles[request.role];
            if (preset) {
                const presetMatch = findProfileForPreset(this.profiles, preset);
                if (presetMatch) return { profile: presetMatch, source: 'rule-role' };
            }
        }

        // --- Layer 1b: explicit preset ---
        if (request.preset) {
            const p = findProfileForPreset(this.profiles, request.preset);
            if (p) return { profile: p, source: 'rule-preset' };
        }

        // --- Layer 1c: explicit taskType ---
        if (request.taskType) {
            const p = findProfileForTaskType(this.profiles, request.taskType);
            if (p) return { profile: p, source: 'rule-task' };
        }

        // --- Layer 2: LLM decision ---
        if (this.llmCall && request.description) {
            const cacheKey = this._cacheKey(request);
            const cached = this.decisionCache.get(cacheKey);
            if (cached) {
                const p = getProfile(this.profiles, cached.profileId);
                if (p) return { profile: p, source: 'llm-cached', reasoning: cached.reasoning };
            }

            try {
                const decision = await this._llmDecide(request.description);
                if (decision?.profileId) {
                    const p = getProfile(this.profiles, decision.profileId);
                    if (p) {
                        this.decisionCache.set(cacheKey, decision);
                        return { profile: p, source: 'llm', reasoning: decision.reasoning };
                    }
                }
            } catch (err) {
                process.stderr.write(`[smart-router] LLM fallback failed: ${err.message}\n`);
            }
        }

        // --- Default: user-facing profile (safe full-context) ---
        const fallback = getProfile(this.profiles, 'user-facing')
                      || getProfile(this.profiles, 'simple-fast')
                      || Object.values(this.profiles)[0];
        return { profile: fallback, source: 'default' };
    }

    /**
     * Sync subset of resolve() — skips LLM fallback, rule-based only.
     * Used by sync call sites (createSession) that can't await.
     * Returns null if no rule matches (caller should fall back to default).
     */
    resolveSync(request) {
        if (request.profileId) {
            const p = getProfile(this.profiles, request.profileId);
            if (p) return { profile: p, source: 'explicit' };
        }
        // Role before preset — see Layer 1a comment in resolve().
        if (request.role) {
            const taskMatch = findProfileForTaskType(this.profiles, request.role);
            if (taskMatch) return { profile: taskMatch, source: 'rule-role' };
            const preset = this.userRoles[request.role];
            if (preset) {
                const presetMatch = findProfileForPreset(this.profiles, preset);
                if (presetMatch) return { profile: presetMatch, source: 'rule-role' };
            }
        }
        if (request.preset) {
            const p = findProfileForPreset(this.profiles, request.preset);
            if (p) return { profile: p, source: 'rule-preset' };
        }
        if (request.taskType) {
            const p = findProfileForTaskType(this.profiles, request.taskType);
            if (p) return { profile: p, source: 'rule-task' };
        }
        return null;
    }

    /**
     * Invoke the LLM router.
     */
    async _llmDecide(description) {
        const systemPrompt = LLM_ROUTER_TEMPLATE
            .replace('{{PROFILES}}', this._renderProfiles())
            .replace('{{USER_ROLES}}', JSON.stringify(this.userRoles, null, 2));
        const raw = await this.llmCall(systemPrompt, 'Task: ' + description);
        return parseRouterResponse(raw);
    }

    _renderProfiles() {
        const lines = [];
        for (const p of Object.values(this.profiles)) {
            lines.push(`- ${p.id} (taskType=${p.taskType}, model=${p.preferredModel}): ${p.description}`);
        }
        return lines.join('\n');
    }

    _cacheKey(request) {
        // Cache LLM decisions by (taskType + role + first ~80 chars of description).
        // Descriptions with same intent usually share the prefix; this keeps the
        // cache small while still bucketing similar requests.
        const desc = String(request.description || '').slice(0, 80).toLowerCase().replace(/\s+/g, ' ');
        return `${request.taskType || ''}|${request.role || ''}|${desc}`;
    }

    /**
     * Update user role mapping (called when user changes preset assignments).
     * Invalidates the decision cache so old role-based decisions re-resolve.
     */
    updateUserRoles(userRoles) {
        this.userRoles = userRoles || {};
        this.decisionCache.clear();
    }
}

function parseRouterResponse(raw) {
    const trimmed = String(raw ?? '').trim();
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[0]);
        if (typeof parsed.profileId !== 'string') return null;
        return {
            profileId: parsed.profileId,
            reasoning: String(parsed.reasoning || ''),
        };
    } catch {
        return null;
    }
}
