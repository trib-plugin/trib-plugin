/**
 * Smart Bridge — Internal LLM Helper (session-based).
 *
 * Every one-shot LLM dispatch from internal callers (memory-cycle,
 * scheduler, webhook) now flows through the SAME session pipeline as the
 * MCP `bridge` tool. No more parallel `provider.send()` helper — one code
 * path = one message shape = one usage log = "bridge 단일 통로".
 *
 * The returned function preserves the legacy signature used by
 * `makeMaintenanceLlm` and co., so callers do not need changes:
 *
 *   const llm = makeBridgeLlm({ role: 'maintenance', preset: 'haiku' });
 *   const text = await llm({ prompt });
 *
 * Internally it:
 *   1. Resolves the preset (explicit arg > opts.preset > user-workflow.json[role])
 *   2. Creates or reuses a session via the session manager
 *   3. Applies stateless-reset for stateless profiles so the prefix handle
 *      stays warm while per-dispatch transcripts never leak
 *   4. Calls `askSession` → provider.send() → usage logged via
 *      `session/manager.mjs` (mode='active')
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../config.mjs';
import { resolveRuntimeSpec } from '../config.mjs';
import { getHiddenRole } from '../internal-roles.mjs';
import {
    askSession,
    createSession,
    updateSessionStatus,
} from '../session/manager.mjs';

function pluginRoot() {
    return process.env.CLAUDE_PLUGIN_ROOT
        || join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'plugins', 'marketplaces', 'trib-plugin', 'external_plugins', 'trib-plugin');
}

// Per-role tool whitelist for Pool C hidden roles. Only the tools a role
// actually needs survive the `allowedTools` filter in manager.mjs; the rest
// are stripped so the BP_1 tool schema (and the shard it caches) shrinks to
// the minimum. Roles not listed here fall through to tools=full minus the
// read-permission deny list (legacy behaviour).
// Unified-shard policy — Pool C roles keep the same tool schema as every
// other Pool B session so BP_1 is bit-identical across roles and the
// provider-side cache shard is shared. Per-role behaviour is steered via
// rules/pool-c/*.md (system BP3) and runtime guards (loop.mjs write-block
// + ai-wrapped-dispatch recursion break).
const POOL_C_TOOL_KEEP = Object.freeze({});

/**
 * Lazy-cached per-role snippet loader for Pool C hidden roles.
 *
 * Each hidden role has a small (~100–200 token) instruction file under
 * rules/pool-c/. The snippet rides in the user-message tail rather than the
 * system prompt, so Pool B/C/D all share the SAME shard (tools + system
 * bit-identical). Only the per-call suffix diverges.
 */
const _roleSnippetCache = new Map();
function getRoleSnippet(role) {
    if (!role) return '';
    if (_roleSnippetCache.has(role)) return _roleSnippetCache.get(role);
    const hidden = getHiddenRole(role);
    let content = '';
    if (hidden && hidden.systemFile) {
        try {
            content = readFileSync(join(pluginRoot(), hidden.systemFile), 'utf8').trim();
        } catch {
            content = '';
        }
    }
    _roleSnippetCache.set(role, content);
    return content;
}

function buildUnifiedHeader({ permission, role }) {
    const lines = [];
    if (permission) lines.push(`Permission: ${permission}`);
    if (role) lines.push(`Role: ${role}`);
    if (lines.length === 0) return '';
    lines.push('');
    lines.push('---');
    lines.push('');
    return lines.join('\n');
}

/**
 * Resolve a preset name from (preset arg | opts.preset | hidden-role | user-workflow).
 *
 * Hidden roles (Pool C: explorer / recall-agent / search-agent) are
 * plugin-managed and take precedence over user-workflow.json — users cannot
 * override them by redefining the same name.
 */
function resolvePresetName({ preset, optsPreset, role }) {
    if (preset) return preset;
    if (optsPreset) return optsPreset;
    if (!role) return null;
    // Hidden roles (Pool C) look up preset via the shared maintenance config
    // slot so C and D move together when the user retunes a model tier.
    const hidden = getHiddenRole(role);
    if (hidden) {
        try {
            const config = loadConfig();
            return config?.maintenance?.[hidden.slot] || null;
        } catch { return null; }
    }
    try {
        const pluginData = process.env.CLAUDE_PLUGIN_DATA;
        if (!pluginData) return null;
        const wf = JSON.parse(readFileSync(join(pluginData, 'user-workflow.json'), 'utf8'));
        if (!Array.isArray(wf.roles)) return null;
        const entry = wf.roles.find((r) => r.name === role);
        return entry ? entry.preset : null;
    } catch {
        return null;
    }
}

/**
 * Build a bridge-backed LLM callback.
 *
 * @param {object} opts
 * @param {string} [opts.taskType]
 * @param {string} [opts.role]
 * @param {string} [opts.preset]
 * @param {string} [opts.sessionId] — reserved for future session reuse
 * @param {string} [opts.mode]
 * @param {boolean} [opts.maintenanceLog] — reserved; no longer applied (session manager logs all calls)
 * @returns {(args: { prompt, mode?, preset?, timeout?, tools? }) => Promise<string>}
 */
export function makeBridgeLlm(opts = {}) {
    const defaultLabel = opts.mode || opts.taskType || 'bridge';

    return async function bridgeLlm({ prompt, mode, preset: presetArg, timeout, sourceName: sourceNameArg }) {
        if (typeof prompt !== 'string' || !prompt) {
            throw new Error(`[bridge-llm] prompt required for "${defaultLabel}"`);
        }

        const config = loadConfig();
        const presetName = resolvePresetName({
            preset: presetArg,
            optsPreset: opts.preset,
            role: opts.role,
        });
        if (!presetName) {
            throw new Error(
                `[bridge-llm] preset unresolved for "${defaultLabel}" `
                + `(role="${opts.role || ''}", preset="${presetArg || opts.preset || ''}")`,
            );
        }

        const preset = config.presets?.find((p) => p.id === presetName || p.name === presetName);
        if (!preset) {
            throw new Error(`[bridge-llm] preset "${presetName}" not found in agent-config.json`);
        }

        const roleLabel = opts.role || opts.taskType || mode || defaultLabel;
        const runtimeSpec = resolveRuntimeSpec(preset, {
            lane: 'bridge',
            agentId: roleLabel,
        });

        // Callers (e.g. aiWrapped explore dispatch) may pass an explicit
        // `cwd` to scope the agent's filesystem view. Absolute path expected
        // (aiWrapped already expands `~` and resolves relatives). Falls back
        // to the MCP server's process cwd when unset.
        const cwd = (typeof opts.cwd === 'string' && opts.cwd) ? opts.cwd : process.cwd();

        // Unified dispatch: Pool B/C share bit-identical tools + system prompt
        // so every role lands on the same provider-side cache shard. Per-role
        // differentiation rides in the user-message header (permission + role
        // line) plus an optional short Pool C snippet. Tools stay on preset
        // default ('full'); permission enforces the read-only contract via
        // manager.mjs's PERMISSION_DENY mapping.
        const hidden = getHiddenRole(opts.role);
        const isPoolC = Boolean(hidden);
        // Permission resolution: explicit opts.permission > hidden-role default
        // ('read' for Pool C) > unset (preset/full default). Callers may still
        // pass `permission: 'readwrite'` explicitly to opt a Pool B role into
        // the same header format without the read-only deny list.
        const permission = opts.permission || (isPoolC ? 'read' : null);
        const sessionOpts = {
            preset,
            owner: 'bridge',
            scopeKey: runtimeSpec.scopeKey,
            lane: runtimeSpec.lane,
            cwd,
            role: opts.role || undefined,
            taskType: opts.taskType || undefined,
            sourceType: opts.sourceType || undefined,
            sourceName: sourceNameArg || opts.sourceName || undefined,
        };
        if (permission) sessionOpts.permission = permission;
        if (isPoolC) {
            sessionOpts.skipRoleReminder = true;
            // Per-role pre-seed migration map: roles listed here move their
            // playbook from the BP3 system snippet to an in-transcript
            // skill_load tool_use/tool_result pair (see manager.mjs's
            // preSeedSkill handler). BP3 stays empty for these roles so BP2
            // becomes bit-identical with Pool B and the shared cache shard
            // covers them. Roles absent from the map keep the legacy BP3
            // snippet path (rules/pool-c/*.md) until they migrate in turn.
            const POOL_C_PRESEED = { explorer: 'explorer-playbook' };
            const preSeedName = POOL_C_PRESEED[opts.role];
            if (preSeedName) {
                sessionOpts.preSeedSkill = preSeedName;
                sessionOpts.roleSnippet = null;
            } else {
                sessionOpts.roleSnippet = getRoleSnippet(opts.role) || null;
            }
        }
        // User message = pure query. Permission / role / snippet all live
        // in systemRole (composeSystemPrompt → BP3) so BP2 + BP3 carry the
        // invariant, and only the query varies per call.
        const finalPrompt = prompt;

        // Stateless ephemeral session — created fresh per call, never pooled
        // or resumed. Cache prefix matching happens at the provider layer
        // (account-level), not the session level, so we lose nothing from
        // skipping pool reuse. Mixing risk = 0.
        const session = createSession(sessionOpts);

        updateSessionStatus(session.id, 'running');
        let terminalStatus = 'idle';
        try {
            const result = await askSession(session.id, finalPrompt, null, null, cwd);
            return result?.content || '';
        } catch (err) {
            terminalStatus = 'error';
            throw err;
        } finally {
            // Always flip out of 'running' before returning so the sweep never
            // leaves a stateless Pool C session stuck in 'running' when the
            // try/catch falls through in unexpected ways.
            try { updateSessionStatus(session.id, terminalStatus); } catch { /* ignore */ }
        }
    };
}
