/**
 * System Bridge — direct stateless provider call for Pool D synth tasks.
 *
 * Bypasses the session manager + bridge-llm orchestration. Each call:
 *   1. Creates a fresh provider instance (no session pool, no reuse)
 *   2. Sends [system, user] messages directly via provider.send()
 *   3. Records usage to bridge-trace
 *   4. Returns the response text
 *
 * This is intentionally minimal — no tools, no multi-round, no continuation.
 * For pool C (cycle, recap-synth, search-synth), that simplicity is the win:
 *   - No session pool memory
 *   - No mixing risk
 *   - No reset logic
 *   - Cache still works (provider-level prefix matching)
 *
 * For agent dispatches (sub-agent with tools, multi-round) use the agent
 * path (`bridge-llm.mjs`) which still needs sessions.
 */

import { getProvider as _getProviderFromRegistry } from '../providers/registry.mjs'
import { resolveCacheStrategy } from './cache-strategy.mjs'
import { recordCall } from './ttl-learner.mjs'
import { resolveMaintenancePreset } from '../../../shared/llm/index.mjs'
import { loadConfig } from '../config.mjs'

function _resolvePreset(presetName) {
  const config = loadConfig()
  const presets = config?.presets || []
  const found = presets.find(p => p.id === presetName || p.name === presetName)
  if (found) return found
  // Fallback for unknown preset — anthropic-oauth / sonnet, full model id.
  return { id: '_fallback', type: 'bridge', provider: 'anthropic-oauth', model: 'claude-sonnet-4-6', effort: 'medium' }
}

function _resolveModel(preset) {
  if (typeof preset === 'string') return preset
  return preset?.model || 'claude-sonnet-4-6'
}

/**
 * Run a Pool D synth task with direct provider call.
 *
 * @param {object} opts
 * @param {string} opts.task         — task identifier (cycle1, recap, search-synth, ...)
 * @param {string} opts.system       — Pool D SYSTEM content (built by caller)
 * @param {string} opts.userMessage  — task-specific data + instructions
 * @param {string|object} [opts.preset] — preset id or object; default resolved via maintenance preset
 * @param {number} [opts.timeout]    — ms, default 120000
 * @returns {Promise<string>}        — synthesized text
 */
export async function systemBridge({
  task,
  system,
  userMessage,
  preset,
  timeout = 120000,
}) {
  if (!task) throw new Error('[system-bridge] task required')
  if (typeof system !== 'string' || !system) {
    throw new Error('[system-bridge] system (string) required')
  }
  if (typeof userMessage !== 'string' || !userMessage) {
    throw new Error('[system-bridge] userMessage (string) required')
  }

  // Preset resolution (caller override > maintenance preset for task > fallback).
  const presetSpec = preset
    ? (typeof preset === 'object' ? preset : _resolvePreset(preset))
    : (() => {
        const resolved = resolveMaintenancePreset(task)
        return typeof resolved === 'object' ? resolved : _resolvePreset(resolved)
      })()
  const model = _resolveModel(presetSpec)

  // ttl-learner: feed timestamp so future calls can pick TTL based on frequency.
  const sourceKey = `system:${task}`
  recordCall(sourceKey, Date.now())

  // Cache strategy — Pool D is always stateless (single-shot synth).
  const cacheStrategy = resolveCacheStrategy('stateless')

  // Build messages — system + user only. No tools, no history.
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userMessage },
  ]

  const providerName = presetSpec?.provider || 'anthropic-oauth'
  const provider = _getProviderFromRegistry(providerName)
  if (!provider) {
    throw new Error(`[system-bridge] provider "${providerName}" not initialized (preset=${presetSpec?.id || presetSpec?.name}). Enable ${providerName} in agent-config.json.providers, or change maintenance preset for task "${task}" to one of the enabled providers.`)
  }
  const sendOpts = {
    cacheStrategy,
    sourceType: 'maintenance',
    sourceName: task,
    sessionId: `system-${task}-${Date.now()}`, // ephemeral id for trace correlation
    iteration: 1,
    effort: presetSpec?.effort,
  }

  const result = await provider.send(messages, model, [], sendOpts)
  return result?.content || ''
}
