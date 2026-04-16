/**
 * Smart Bridge — Generic LLM Helper
 *
 * Single shared bridge call helper for stateless one-shot external LLM calls.
 * Used by maintenance cycles, scheduler, webhook, and any backend callsite
 * that previously reached for shared/llm/index.mjs:callLLM.
 *
 * Each invocation:
 *   - Resolves profile / provider / model via smartBridge.resolve
 *   - Calls provider.send with profile-driven cache_control breakpoints
 *   - Records usage to llm-usage.jsonl (or llm-maintenance.jsonl via
 *     maintenanceLog=true) with rich fields (profileId, sessionId,
 *     cacheReadTokens, cacheWriteTokens, prefixHash)
 *   - Updates cache-registry.json for observability
 *
 * Fallback: if the resolved provider is unavailable or a call fails, we
 * currently drop back to legacy callLLM so unauthenticated environments still
 * work. A later Ship 2a step removes that fallback and converts to throw.
 */

import { getSmartBridge } from './index.mjs';
import { getProvider } from '../providers/registry.mjs';
import { logLlmCall } from '../../../shared/llm/usage-log.mjs';

/**
 * Build a bridge-backed LLM callback.
 *
 * @param {object} opts
 * @param {string} [opts.taskType]        — e.g. 'maintenance', 'scheduler-task', 'webhook-handler'
 * @param {string} [opts.role]            — explicit role override (precedence over taskType in router)
 * @param {string} [opts.sessionId]       — optional session id for cache routing (per-provider semantics apply)
 * @param {string} [opts.mode]            — logging mode label; defaults to taskType or 'bridge'
 * @param {boolean} [opts.maintenanceLog] — route usage log to llm-maintenance.jsonl instead of llm-usage.jsonl
 * @returns {(args: { prompt, mode, preset, timeout }) => Promise<string>}
 */
export function makeBridgeLlm(opts = {}) {
    const defaultLabel = opts.mode || opts.taskType || 'bridge';
    const logMaintenance = opts.maintenanceLog === true;

    return async function bridgeLlm({ prompt, mode, preset, timeout }) {
        const smartBridge = getSmartBridge();
        const request = {
            taskType: opts.taskType,
            role: opts.role,
            preset: preset || opts.preset,
            description: mode || defaultLabel + ' task',
            sessionId: opts.sessionId,
        };
        if (!request.taskType && !request.role && !request.preset) request.taskType = defaultLabel;

        const resolved = await smartBridge.resolve(request);
        const provider = getProvider(resolved.provider);

        if (!provider) {
            throw new Error(
                `[bridge-llm] provider "${resolved.provider}" unavailable for "${defaultLabel}". `
                + 'All LLM calls must route through Smart Bridge; legacy callLLM fallback has been removed. '
                + 'Authenticate the target provider (e.g., anthropic-oauth) or override via agent-config.'
            );
        }

        const messages = [{ role: 'user', content: prompt }];
        const tools = [];
        const sendOpts = {
            sessionId: opts.sessionId,
            effort: resolved.effort,
            fast: resolved.fast,
            ...resolved.providerCacheOpts,
        };

        const model = resolved.model;
        if (!model) {
            throw new Error(
                `[bridge-llm] no model resolved for "${defaultLabel}". `
                + 'Check agent-config presets and user-workflow role mapping for this taskType.'
            );
        }

        const startedAt = Date.now();
        try {
            const result = await provider.send(messages, model, tools, sendOpts);

            smartBridge.recordCall(resolved.profile, resolved.provider, {
                systemPrompt: '',
                tools,
                usage: result.usage,
            });
            const prefixHash = smartBridge.registry?.data?.profiles?.[resolved.profile?.id]?.prefixHash || null;

            if (result.usage) {
                logLlmCall({
                    ts: new Date().toISOString(),
                    preset: resolved.presetName || null,
                    model,
                    provider: resolved.provider,
                    mode: mode || defaultLabel,
                    duration: Date.now() - startedAt,
                    profileId: resolved.profile?.id || null,
                    sessionId: opts.sessionId || null,
                    inputTokens: result.usage.inputTokens || 0,
                    outputTokens: result.usage.outputTokens || 0,
                    cacheReadTokens: result.usage.cachedTokens || 0,
                    cacheWriteTokens: result.usage.cacheWriteTokens || 0,
                    prefixHash,
                    costUsd: result.usage.costUsd || 0,
                }, { maintenance: logMaintenance });
            }

            return result.content || '';
        } catch (err) {
            process.stderr.write(`[bridge-llm] send failed (${resolved.provider}/${model}, ${defaultLabel}): ${err.message}\n`);
            throw err;
        }
    };
}
