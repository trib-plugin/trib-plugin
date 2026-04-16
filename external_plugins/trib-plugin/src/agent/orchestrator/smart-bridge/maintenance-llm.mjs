/**
 * Smart Bridge — Maintenance LLM Helper
 *
 * Routes memory cycle (and other maintenance) invocations through the Smart
 * Bridge router, picking the right provider + cache strategy + profile.
 *
 * Designed as a drop-in for memory-cycle.mjs's `options.llm` callback:
 *
 *   const result = await runCycle1(db, config, {
 *     llm: makeMaintenanceLlm({ taskType: 'maintenance' })
 *   });
 *
 * The helper handles:
 *   - Profile resolution via Smart Bridge router
 *   - Provider selection (anthropic-oauth preferred for 1h cache)
 *   - Cache opts injection (profile.cacheStrategy → sendOpts)
 *   - Usage recording for cache stats
 *   - Graceful fallback to native callLLM if OAuth provider unavailable
 */

import { getSmartBridge } from './index.mjs';
import { getProvider } from '../providers/registry.mjs';
import { callLLM, resolveMaintenancePreset } from '../../../shared/llm/index.mjs';

/**
 * Build a maintenance-LLM callback suitable for memory-cycle.mjs.
 *
 * @param {object} opts
 * @param {string} opts.taskType        — e.g., 'maintenance' (maps to maintenance-light)
 * @param {string} [opts.sessionId]     — optional session id for cache routing
 * @returns {(args: { prompt, mode, preset, timeout }) => Promise<string>}
 */
export function makeMaintenanceLlm(opts = {}) {
    return async function maintenanceLlm({ prompt, mode, preset, timeout }) {
        const smartBridge = getSmartBridge();
        const request = {
            taskType: opts.taskType || 'maintenance',
            description: mode || 'maintenance cycle',
            sessionId: opts.sessionId,
        };
        const resolved = await smartBridge.resolve(request);
        const provider = getProvider(resolved.provider);

        // If the preferred provider isn't available (e.g., no OAuth), fall back
        // to native callLLM with the original preset. This preserves behavior
        // for users who haven't authenticated with Anthropic/OpenAI OAuth.
        if (!provider) {
            process.stderr.write(`[smart-bridge-maintenance] provider "${resolved.provider}" unavailable, falling back to native\n`);
            return await callLLM(prompt, preset || resolveMaintenancePreset(mode), {
                mode: 'maintenance',
                timeout,
            });
        }

        // Build messages + tools (maintenance tasks are stateless; no tools).
        const messages = [{ role: 'user', content: prompt }];
        const tools = [];
        const sendOpts = {
            sessionId: opts.sessionId,
            ...resolved.providerCacheOpts,
        };

        const model = resolveModelForProfile(resolved.profile);
        try {
            const result = await provider.send(messages, model, tools, sendOpts);

            // Record for cache stats (systemPrompt empty for maintenance cycles —
            // the prompt is all in the user message, which is correct per Anthropic's
            // "messages at 5m, system at 1h" caching model).
            smartBridge.recordCall(resolved.profile, resolved.provider, {
                systemPrompt: '',
                tools,
                usage: result.usage,
            });

            return result.content || '';
        } catch (err) {
            process.stderr.write(`[smart-bridge-maintenance] send failed (${resolved.provider}/${model}): ${err.message}\n`);
            // Fall through to native as last resort.
            return await callLLM(prompt, preset || resolveMaintenancePreset(mode), {
                mode: 'maintenance',
                timeout,
            });
        }
    };
}

/**
 * Map profile's preferredModel (preset name) to an actual model id for the provider.
 */
function resolveModelForProfile(profile) {
    const preset = profile.preferredModel;
    // Map common preset names to provider-specific model ids.
    const map = {
        haiku: 'claude-haiku-4-5-20251001',
        'sonnet-mid': 'claude-sonnet-4-6',
        'sonnet-high': 'claude-sonnet-4-6',
        'opus-max': 'claude-opus-4-6',
        'opus-mid': 'claude-opus-4-6',
        'GPT5.4': 'gpt-5.4',
        'gpt5.4-mini': 'gpt-5.4-mini',
    };
    return map[preset] || preset;
}
