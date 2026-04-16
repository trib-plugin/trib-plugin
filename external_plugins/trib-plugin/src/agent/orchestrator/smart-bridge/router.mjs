/**
 * Smart Bridge — Router (rule-based only)
 *
 * Layer 1 resolution:
 *   Layer 0  explicit profileId
 *   Layer 1a user role → profile (taskType match first, then preset fallback)
 *   Layer 1b explicit preset → profile
 *   Layer 1c explicit taskType → profile
 *   Default  user-facing profile
 *
 * Layer 2 (LLM-based dispatch) was removed in v0.6.47 (Phase B §10) — the
 * profile set is small enough that rule-based routing covers every real call
 * site, and a Haiku hop per dispatch paid more than it saved.
 */

import { findProfileForTaskType, findProfileForPreset, getProfile } from './profiles.mjs';

// Phase C Ship 3 — role category rules (no role-name hardcoding beyond the
// reserved worker role).
//
// The plugin recognises exactly two user-facing role categories:
//   • "worker"  — the reserved, non-deletable role. Always routes to
//                 `worker-full` (stateful, continuous).
//   • everything else — any other role defined in user-workflow.json is a
//                 Sub. All Subs route to `sub-task` (stateless prefix-handle
//                 reuse). Role names are user-customisable; no code path
//                 depends on specific names like "reviewer" or "tester".
//
// Maintenance profiles (cycle1 / cycle2 / scheduler-task / webhook-handler /
// proactive-decision) are selected by taskType and are never user roles.
const RESERVED_WORKER_ROLE = 'worker';

export class SmartRouter {
    /**
     * @param {object} opts
     * @param {object} opts.profiles  — profile map from loadProfiles()
     * @param {object} opts.userRoles — { worker: "opus-max", reviewer: "GPT5.4", ... }
     */
    constructor(opts = {}) {
        this.profiles = opts.profiles || {};
        this.userRoles = opts.userRoles || {};
    }

    /**
     * Resolve a profile for the given request.
     *
     * @param {object} request
     * @param {string} [request.profileId]   — explicit profile id (highest precedence)
     * @param {string} [request.role]        — user-defined role (worker, reviewer, ...)
     * @param {string} [request.preset]      — explicit preset (secondary to role)
     * @param {string} [request.taskType]    — explicit task type hint (lowest rule precedence)
     * @returns {Promise<{ profile, source }>}  source = "explicit" | "rule-*" | "default"
     */
    async resolve(request) {
        return this.resolveSync(request) || this._defaultResolution();
    }

    /**
     * Sync subset of resolve() — pure rule lookup, no I/O.
     * Returns null when nothing matches (caller can fall back to default).
     */
    resolveSync(request) {
        if (!request) return null;
        if (request.profileId) {
            const p = getProfile(this.profiles, request.profileId);
            if (p) return { profile: p, source: 'explicit' };
        }
        // Role category routing — reserved `worker` goes to worker-full,
        // every other user-defined role routes to sub-task. Role names stay
        // user-customisable because the category is decided by membership in
        // userRoles, not by the name itself.
        if (request.role) {
            if (request.role === RESERVED_WORKER_ROLE) {
                const workerProfile = getProfile(this.profiles, 'worker-full');
                if (workerProfile) return { profile: workerProfile, source: 'rule-worker' };
            } else if (this.userRoles[request.role]) {
                const subProfile = getProfile(this.profiles, 'sub-task');
                if (subProfile) return { profile: subProfile, source: 'rule-sub' };
            }
            // Role is not recognised as a user-defined role — fall through to
            // the taskType / preset resolution below so callers supplying a
            // raw taskType string still get the correct maintenance profile.
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

    _defaultResolution() {
        const fallback = getProfile(this.profiles, 'user-facing')
                      || getProfile(this.profiles, 'simple-fast')
                      || Object.values(this.profiles)[0];
        return { profile: fallback, source: 'default' };
    }

    /**
     * Update user role mapping (called when user changes preset assignments).
     */
    updateUserRoles(userRoles) {
        this.userRoles = userRoles || {};
    }
}
