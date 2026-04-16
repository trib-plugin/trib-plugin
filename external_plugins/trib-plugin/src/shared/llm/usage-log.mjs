/**
 * Unified LLM usage logger for Smart Bridge paths.
 *
 * Two files, identical schema:
 *   - llm-usage.jsonl       — active (bridge tool, bridge_spawn → askSession)
 *   - llm-maintenance.jsonl — maintenance cycles (memory cycle1/cycle2)
 *
 * Legacy `shared/llm/index.mjs` keeps writing to llm-usage.jsonl for callLLM
 * fallbacks (mode:'active'|'maintenance'). Smart Bridge writes through here
 * with richer fields (profileId, sessionId, cacheReadTokens, cacheWriteTokens,
 * prefixHash). Schema is additive — legacy readers still see the same flat
 * inputTokens/outputTokens/costUsd fields.
 */

import { appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function resolveDataDir() {
    return process.env.CLAUDE_PLUGIN_DATA
        || join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin');
}

/**
 * Append a usage entry to the appropriate jsonl file.
 *
 * @param {object} entry — usage record (see schema below)
 * @param {object} opts
 * @param {boolean} [opts.maintenance=false] — route to llm-maintenance.jsonl instead
 *
 * Entry schema (both files share this):
 *   ts, preset, model, provider, mode, duration,
 *   profileId, sessionId,
 *   inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *   prefixHash, costUsd
 */
export function logLlmCall(entry, opts = {}) {
    try {
        const file = opts.maintenance ? 'llm-maintenance.jsonl' : 'llm-usage.jsonl';
        const path = join(resolveDataDir(), file);
        appendFileSync(path, JSON.stringify(entry) + '\n');
    } catch {
        // Never let logging break the caller. Silent failure is acceptable
        // since observability is best-effort.
    }
}
