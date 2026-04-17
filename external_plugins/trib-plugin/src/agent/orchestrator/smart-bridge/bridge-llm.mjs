/**
 * Smart Bridge — Generic LLM Helper (unified 4-field renderer)
 *
 * Every one-shot LLM dispatch flows through a unified renderer:
 *   Input:  { role, permission, desc, task }
 *   Output: messages[] with
 *           messages[0] = { role:'system',  text: common-permission-manual }
 *           messages[1] = { role:'user',
 *                           content: [
 *                             { type:'text', text: identity,
 *                               cache_control: { type:'ephemeral', ttl } },
 *                             { type:'text', text: task }
 *                           ] }
 *
 * System prompt: common-permission-manual.md is prepended as a system
 * message (messages[0]) rather than passed via sendOpts.system. The oauth
 * providers we support (anthropic-oauth, openai-oauth) read system from
 * the messages array; passing it via sendOpts.system was silently dropped.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getSmartBridge } from './index.mjs';
import { getProvider } from '../providers/registry.mjs';
import { logLlmCall } from '../../../shared/llm/usage-log.mjs';

let _getRoleConfig = null;
async function getRoleConfigLazy(role) {
    if (!_getRoleConfig) {
        try {
            const mod = await import('../../../agent/index.mjs');
            _getRoleConfig = mod.getRoleConfig || (() => null);
        } catch {
            _getRoleConfig = () => null;
        }
    }
    return _getRoleConfig(role);
}

// --- System prompt: loaded once per process ---
let _systemPrompt = null;
function getSystemPrompt() {
    if (_systemPrompt !== null) return _systemPrompt;
    try {
        const root = process.env.CLAUDE_PLUGIN_ROOT;
        if (root) {
            const p = join(root, 'rules', 'common-permission-manual.md');
            if (existsSync(p)) {
                _systemPrompt = readFileSync(p, 'utf8').trim();
                return _systemPrompt;
            }
        }
    } catch {}
    _systemPrompt = '';
    return _systemPrompt;
}

// --- Agent desc loader: agents/{role}.md ---
const _descCache = new Map();
async function loadAgentDesc(role) {
    if (!role) return null;
    if (_descCache.has(role)) return _descCache.get(role);
    try {
        const root = process.env.CLAUDE_PLUGIN_ROOT;
        if (root) {
            const roleConfig = await getRoleConfigLazy(role);
            if (roleConfig?.desc_path) {
                const descPath = join(root, roleConfig.desc_path);
                if (existsSync(descPath)) {
                    const content = readFileSync(descPath, 'utf8').trim();
                    _descCache.set(role, content);
                    return content;
                }
            }
            const p = join(root, 'agents', `${role}.md`);
            if (existsSync(p)) {
                const content = readFileSync(p, 'utf8').trim();
                _descCache.set(role, content);
                return content;
            }
        }
    } catch {}
    _descCache.set(role, null);
    return null;
}

export function clearDescCache() {
    _descCache.clear();
}

async function renderIdentity({ role, permission, desc }) {
    const lines = [];
    if (role) lines.push(`# role\n${role}`);
    if (permission) lines.push(`# permission\n${permission}`);
    // Hierarchical role "maintenance:cycle1" — base identity first (shared
    // prefix across sibling roles), task-specific guidance appended at the
    // end of Tier 2 so the common head maximises cache hits.
    if (role && role.includes(':')) {
        const [base, sub] = role.split(':');
        const baseDesc = await loadAgentDesc(base);
        if (baseDesc) lines.push(`# agent-role\n${baseDesc}`);
        const specificDesc = await loadAgentDesc(`${base}-${sub}`);
        if (specificDesc) lines.push(`# task\n${specificDesc}`);
        if (!baseDesc && !specificDesc && desc) lines.push(`# agent-role\n${desc}`);
    } else {
        const fileDesc = await loadAgentDesc(role);
        if (fileDesc) {
            lines.push(`# agent-role\n${fileDesc}`);
        } else if (desc) {
            lines.push(`# agent-role\n${desc}`);
        }
    }
    return lines.join('\n\n');
}

/**
 * Build a bridge-backed LLM callback.
 *
 * @param {object} opts
 * @param {string} [opts.taskType]
 * @param {string} [opts.role]
 * @param {string} [opts.sessionId]
 * @param {string} [opts.mode]
 * @param {boolean} [opts.maintenanceLog]
 * @param {Array<object>} [opts.tools] — optional tool subset to pass to the
 *   provider. Defaults to []. Callers (e.g. scheduler proactive) that need
 *   search tools pass them explicitly here.
 * @returns {(args: { prompt, mode, preset, timeout }) => Promise<string>}
 */
export function makeBridgeLlm(opts = {}) {
    const defaultLabel = opts.mode || opts.taskType || 'bridge';
    const logMaintenance = opts.maintenanceLog === true;
    const toolsDefault = Array.isArray(opts.tools) ? opts.tools : [];

    return async function bridgeLlm({ prompt, mode, preset, timeout, tools: callTools }) {
        const smartBridge = getSmartBridge();
        const request = {
            taskType: opts.taskType,
            role: opts.role,
            preset: preset || opts.preset,
            description: mode || defaultLabel + ' task',
            sessionId: opts.sessionId,
        };
        // Plain-string prompt normalization: treat as ad-hoc when no routing
        // metadata was given at all.
        if (!request.taskType && !request.role && !request.preset) {
            request.taskType = 'ad-hoc';
            request.role = 'ad-hoc';
        }

        const resolved = await smartBridge.resolve(request);
        const provider = getProvider(resolved.provider);

        if (!provider) {
            throw new Error(
                `[bridge-llm] provider "${resolved.provider}" unavailable for "${defaultLabel}". `
                + 'All LLM calls must route through Smart Bridge; legacy callLLM fallback has been removed. '
                + 'Authenticate the target provider (e.g., anthropic-oauth) or override via agent-config.'
            );
        }

        const model = resolved.model;
        if (!model) {
            throw new Error(
                `[bridge-llm] no model resolved for "${defaultLabel}". `
                + 'Check agent-config presets and user-workflow role mapping for this taskType.'
            );
        }

        const effectiveRole = opts.role || opts.taskType || defaultLabel;
        const roleConfig = await getRoleConfigLazy(effectiveRole);
        const profileDesc = resolved.profile?.description || null;
        const permission = roleConfig?.permission || 'read-write';
        const desc = profileDesc;

        // Resolve TTL via learner. Learner returns '5m' | '1h' | 'none'.
        let ttl = '1h';
        try {
            const { learnTtl, recordCall } = await import('./ttl-learner.mjs');
            recordCall(effectiveRole, Date.now());
            const learned = learnTtl(effectiveRole);
            if (learned) ttl = learned;
        } catch { /* keep default */ }

        const identityText = await renderIdentity({ role: effectiveRole, permission, desc });
        const systemPrompt = getSystemPrompt();

        // Identity content block — cache_control only when ttl is an
        // ephemeral tier. When ttl === 'none', omit cache_control entirely
        // so the provider treats this block as uncached. Passing
        // { type:'ephemeral', ttl:'none' } is not a valid shape.
        const identityBlock = { type: 'text', text: identityText };
        if (ttl === '5m' || ttl === '1h') {
            identityBlock.cache_control = { type: 'ephemeral', ttl };
        }

        // messages[0] system: common-permission-manual.md. Included in
        // messages so both anthropic-oauth and openai-oauth providers see
        // it (sendOpts.system was provider-specific and got dropped on
        // oauth paths).
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({
            role: 'user',
            content: [
                identityBlock,
                { type: 'text', text: prompt },
            ],
        });

        // Tools: per-call override wins, else constructor default ([]).
        const tools = Array.isArray(callTools) ? callTools : toolsDefault;
        const sendOpts = {
            sessionId: opts.sessionId,
            effort: resolved.effort,
            fast: resolved.fast,
            ...resolved.providerCacheOpts,
        };

        const startedAt = Date.now();
        try {
            const result = await provider.send(messages, model, tools, sendOpts);

            smartBridge.recordCall(resolved.profile, resolved.provider, {
                systemPrompt: systemPrompt || '',
                tools,
                usage: result.usage,
            });
            const prefixHash = smartBridge.registry?.data?.profiles?.[resolved.profile?.id]?.[resolved.provider]?.prefixHash || null;

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
            const isModelError = /\b(model_not_found|not_found_error|invalid.*model)\b/i.test(err.message)
                              || /\b40[04]\b/.test(err.message);
            if (isModelError && resolved.provider === 'anthropic-oauth') {
                try {
                    const { nextFallbackModel } = await import('./index.mjs');
                    const fallback = nextFallbackModel(model);
                    if (fallback) {
                        process.stderr.write(`[bridge-llm] retrying with fallback model ${fallback}\n`);
                        const result = await provider.send(messages, fallback, tools, sendOpts);
                        return result.content || '';
                    }
                } catch (retryErr) {
                    process.stderr.write(`[bridge-llm] fallback retry also failed: ${retryErr.message}\n`);
                }
            }
            throw err;
        }
    };
}
