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
import {
    askSession,
    createSession,
    updateSessionStatus,
} from '../session/manager.mjs';

/**
 * Resolve a preset name from (preset arg | opts.preset | user-workflow role map).
 */
function resolvePresetName({ preset, optsPreset, role }) {
    if (preset) return preset;
    if (optsPreset) return optsPreset;
    if (!role) return null;
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

        let preset = config.presets?.find((p) => p.id === presetName || p.name === presetName);
        if (!preset) {
            throw new Error(`[bridge-llm] preset "${presetName}" not found in agent-config.json`);
        }
        if (preset?.type === 'native') {
            const { translateNativePreset } = await import('./index.mjs');
            preset = translateNativePreset(preset);
        }

        const roleLabel = opts.role || opts.taskType || mode || defaultLabel;
        const runtimeSpec = resolveRuntimeSpec(preset, {
            lane: 'bridge',
            agentId: roleLabel,
        });

        const cwd = process.cwd();

        // Stateless ephemeral session — created fresh per call, never pooled
        // or resumed. Cache prefix matching happens at the provider layer
        // (account-level), not the session level, so we lose nothing from
        // skipping pool reuse. Mixing risk = 0.
        const session = createSession({
            preset,
            owner: 'bridge',
            scopeKey: runtimeSpec.scopeKey,
            lane: runtimeSpec.lane,
            cwd,
            role: opts.role || undefined,
            taskType: opts.taskType || undefined,
            sourceType: opts.sourceType || undefined,
            sourceName: sourceNameArg || opts.sourceName || undefined,
        });

        try {
            updateSessionStatus(session.id, 'running');
            const result = await askSession(session.id, prompt, null, null, cwd);
            updateSessionStatus(session.id, 'idle');
            return result?.content || '';
        } catch (err) {
            try { updateSessionStatus(session.id, 'error'); } catch {}
            throw err;
        }
    };
}
