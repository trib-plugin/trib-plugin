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

// Phase B §4.5 — four sub roles share a single `sub-task` profile so
// Worker/Sub/Maintenance all ride the same Pool B prefix. Legacy per-role
// profiles (reviewer-external, tester-runtime, debugger-deep,
// researcher-minimal) remain for backward compatibility but the router
// prefers `sub-task` when it exists.
const SUB_ROLE_SET = new Set(['reviewer', 'tester', 'debugger', 'researcher']);

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
        // Role before preset — role maps to taskType-specific profiles first,
        // ensuring shared presets (e.g. multiple roles on GPT5.4) land on the
        // correct per-role profile.
        if (request.role) {
            // Sub-role aliasing: route all four sub roles to the unified
            // `sub-task` profile when it exists.
            if (SUB_ROLE_SET.has(request.role)) {
                const subProfile = getProfile(this.profiles, 'sub-task');
                if (subProfile) return { profile: subProfile, source: 'rule-sub' };
            }
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
