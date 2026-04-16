/**
 * Smart Bridge — Maintenance LLM Helper (thin wrapper)
 *
 * Thin wrapper over `makeBridgeLlm` that pins taskType='maintenance',
 * routes usage logging to llm-maintenance.jsonl, and preserves the original
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
    return makeBridgeLlm({
        ...opts,
        taskType: opts.taskType || 'maintenance',
        mode: 'maintenance',
        maintenanceLog: true,
    });
}
