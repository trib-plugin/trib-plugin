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
import { traceBridgePreset } from '../bridge-trace.mjs';
import {
    askSession,
    createSession,
    updateSessionStatus,
} from '../session/manager.mjs';

// v0.6.231: cap sub-agent synthesis to ~3000 tokens (~12 KB at the 4 B/tok
// working average). Pool B explore/recall/search answers occasionally land
// 8-10k-token walls that then ride in the Lead context for the rest of the
// turn; the cap keeps those outliers bounded without touching the 95%+ of
// answers already under the threshold.
const BRIEF_CAP_BYTES = 12 * 1024;
function applyBriefCap(text) {
    if (typeof text !== 'string') return text;
    if (text.length <= BRIEF_CAP_BYTES) return text;
    const head = text.slice(0, BRIEF_CAP_BYTES);
    const approxTokens = Math.round(text.length / 4);
    return `${head}\n\n... [TRUNCATED — full answer was ~${approxTokens} tokens / ${Math.round(text.length / 1024)} KB. Re-run with brief:false for the complete synthesis]`;
}

function pluginRoot() {
    return process.env.CLAUDE_PLUGIN_ROOT
        || join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'plugins', 'marketplaces', 'trib-plugin', 'external_plugins', 'trib-plugin');
}

// Per-role tool whitelist for hidden roles. Only the tools a role
// actually needs survive the `allowedTools` filter in manager.mjs; the rest
// are stripped so the BP_1 tool schema (and the shard it caches) shrinks to
// the minimum. Roles not listed here fall through to tools=full minus the
// read-permission deny list (legacy behaviour).
// Unified-shard policy — hidden roles keep the same tool schema as every
// other bridge session so BP_1 is bit-identical across roles and the
// provider-side cache shard is shared. Per-role behaviour is steered via
// rules/bridge/*.md (concatenated into BP2 roleCatalog by
// loadAllAgentBodies — every bridge session carries the full hidden-role
// catalog so the shard stays bit-identical across roles) and runtime guards
// (loop.mjs write-block + ai-wrapped-dispatch recursion break).
const POOL_C_TOOL_KEEP = Object.freeze({});

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
 * Hidden roles (explorer / recall-agent / search-agent) are
 * plugin-managed and take precedence over user-workflow.json — users cannot
 * override them by redefining the same name.
 */
export function resolvePresetName({ preset, optsPreset, role }) {
    if (preset) return preset;
    if (optsPreset) return optsPreset;
    if (!role) return null;
    // Hidden roles look up preset via the shared maintenance config
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
            // Hidden-role instructions live in BP2 roleCatalog (loaded by
            // loadAllAgentBodies from rules/bridge/*.md). No per-call
            // snippet plumbing needed — the shard is bit-identical across
            // every bridge role.
        }
        // User message = pure query. Permission / role ride in BP3
        // sessionMarker (composeSystemPrompt) — only the query varies per
        // call, so provider cache reuses the shared prefix.
        const finalPrompt = prompt;

        // Stateless ephemeral session — created fresh per call, never pooled
        // or resumed. Cache prefix matching happens at the provider layer
        // (account-level), not the session level, so we lose nothing from
        // skipping pool reuse. Mixing risk = 0.
        const session = createSession(sessionOpts);

        // Emit role/preset trace AFTER session.id is known so post-hoc
        // analysis (e.g. matching stalled sess_xxx → role) can join cleanly.
        // Pre-session emission stamped sessionId="no-session" and broke that
        // join; failed createSession paths intentionally skip the trace.
        try {
            traceBridgePreset({
                sessionId: session.id,
                role: roleLabel,
                presetName,
                model: runtimeSpec?.model || null,
                provider: runtimeSpec?.provider || null,
            });
        } catch { /* telemetry best-effort */ }

        updateSessionStatus(session.id, 'running');
        let terminalStatus = 'idle';
        try {
            const result = await askSession(session.id, finalPrompt, null, null, cwd);
            const raw = result?.content || '';
            // v0.6.231 brief cap. Sub-agent answers (explore/recall/search)
            // occasionally balloon to 8-10k token walls that then ride in the
            // parent Lead's context for the rest of the turn. A 3000-token
            // (~12 KB) ceiling trims the long tail while leaving the vast
            // majority of answers untouched. Opt-out via `brief:false` when
            // the caller explicitly wants the full synthesis.
            if (opts.brief === false) return raw;
            return applyBriefCap(raw);
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
