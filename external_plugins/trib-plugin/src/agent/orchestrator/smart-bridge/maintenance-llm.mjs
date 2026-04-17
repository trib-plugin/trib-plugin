/**
 * Smart Bridge — Maintenance LLM Helper (thin wrapper)
 *
 * Thin wrapper over `makeBridgeLlm` that pins taskType='maintenance',
 * flags usage records as maintenance-origin in bridge-trace.jsonl, and preserves the original
 * `makeMaintenanceLlm` signature used by memory-cycle.mjs:
 *
 *   const result = await runCycle1(db, config, {
 *     llm: makeMaintenanceLlm({ taskType: 'maintenance' })
 *   });
 *
 * The actual provider selection, cache breakpoints, and usage recording live
 * in bridge-llm.mjs so scheduler / webhook / any other backend callsite can
 * share one implementation.
 */

import { makeBridgeLlm } from './bridge-llm.mjs';

/**
 * @param {object} opts
 * @param {string} [opts.taskType]   — defaults to 'maintenance'
 * @param {string} [opts.role]
 * @param {string} [opts.sessionId]
 * @returns {(args: { prompt, mode, preset, timeout }) => Promise<string>}
 */
export function makeMaintenanceLlm(opts = {}) {
    // Derive sourceName from role: "maintenance:cycle1" → "cycle1", else the
    // raw role. Callers can override by passing opts.sourceName.
    let sourceName = opts.sourceName;
    if (!sourceName && typeof opts.role === 'string') {
        const idx = opts.role.indexOf(':');
        sourceName = idx >= 0 ? opts.role.slice(idx + 1) : opts.role;
    }
    return makeBridgeLlm({
        ...opts,
        taskType: opts.taskType || 'maintenance',
        sourceType: opts.sourceType || 'maintenance',
        sourceName: sourceName || null,
    });
}
