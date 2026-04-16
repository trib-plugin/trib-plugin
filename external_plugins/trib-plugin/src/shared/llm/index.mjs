/**
 * Unified LLM runner.
 * Routes to CLI or HTTP runners based on preset type/provider.
 * Supports maintenance (isolated) and active (full context) modes.
 */
import { runClaude, runCodex, runGemini } from './cli-runner.mjs'
import { runHTTP, runOllamaHTTP } from './http-runner.mjs'
import { DEFAULT_MAINTENANCE } from '../../agent/orchestrator/config.mjs'
import { readFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const AGENT_CONFIG_PATH = process.env.CLAUDE_PLUGIN_DATA
  ? join(process.env.CLAUDE_PLUGIN_DATA, 'agent-config.json')
  : join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin', 'agent-config.json')

const ENV_KEY_MAP = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  xai: 'XAI_API_KEY',
}

function loadAgentConfig() {
  try {
    return JSON.parse(readFileSync(AGENT_CONFIG_PATH, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[llm] agent-config parse error: ${e.message}`)
    return {}
  }
}

function findPreset(presetId, agentConfig) {
  const presets = agentConfig?.presets || []
  return presets.find(p => p.id === presetId) || presets.find(p => p.name === presetId) || null
}

function resolveApiKey(providerKey, agentConfig) {
  const envKey = ENV_KEY_MAP[providerKey]
  if (envKey && process.env[envKey]) return process.env[envKey]
  return agentConfig?.providers?.[providerKey]?.apiKey || null
}

/**
 * Unified LLM call.
 * @param {string} prompt
 * @param {string|object} presetOrId — preset ID string or preset object
 * @param {object} options — { mode?: 'maintenance'|'active', timeout?, systemPrompt?, taskType?, role? }
 *   taskType / role (optional) — when provided, route through Smart Bridge for
 *   profile-based cache + context optimization. Falls back to direct call if
 *   Smart Bridge has no matching profile or is unavailable.
 * @returns {Promise<string>}
 */
export async function callLLM(prompt, presetOrId, options = {}) {
  const { mode = 'maintenance', timeout = 180000, systemPrompt, taskType, role } = options

  // Smart Bridge opt-in routing. Caller indicates intent via taskType/role;
  // we try Smart Bridge first, falling back to direct path on any failure.
  if (taskType || role) {
    try {
      const { makeMaintenanceLlm } = await import('../../agent/orchestrator/smart-bridge/maintenance-llm.mjs')
      const smartLlm = makeMaintenanceLlm({ taskType, role })
      return await smartLlm({ prompt, mode, preset: presetOrId, timeout })
    } catch (err) {
      process.stderr.write(`[llm] smart routing failed, falling back to direct: ${err.message}\n`)
      // fall through to direct path below
    }
  }

  const agentConfig = loadAgentConfig()

  const preset = typeof presetOrId === 'string'
    ? findPreset(presetOrId, agentConfig)
    : presetOrId
  if (!preset) throw new Error(`Preset not found: ${presetOrId}`)

  const model = preset.model
  const providerKey = preset.provider
  const presetName = preset.id || preset.name || 'unknown'
  const startMs = Date.now()

  let result

  // Native (Claude Code CLI)
  if (preset.type === 'native') {
    result = await runClaude(prompt, { model, mode, timeout, systemPrompt, effort: preset.effort })
  } else if (!providerKey) {
    throw new Error(`Preset "${presetName}" has no provider`)
  } else {
    // Bridge — route by provider
    switch (providerKey) {
      case 'openai-oauth':
      case 'copilot':
        result = await runCodex(prompt, { model, mode, timeout, effort: preset.effort, fast: preset.fast })
        break
      case 'ollama': {
        const rawUrl = preset.baseUrl || agentConfig?.providers?.ollama?.baseURL || 'http://localhost:11434'
        const baseUrl = rawUrl.replace(/\/v1\/?$/, '')
        result = await runOllamaHTTP(prompt, { model, timeout, baseUrl })
        break
      }
      case 'lmstudio': {
        const apiKey = preset.apiKey || 'lm-studio'
        const baseUrl = preset.baseUrl || agentConfig?.providers?.lmstudio?.baseURL || 'http://localhost:1234/v1'
        result = await runHTTP(prompt, { model, timeout, apiKey, baseUrl, provider: 'lmstudio', systemPrompt })
        break
      }
      case 'gemini':
        result = await runGemini(prompt, { model, mode, timeout })
        break
      default: {
        const apiKey = preset.apiKey || resolveApiKey(providerKey, agentConfig)
        const baseUrl = preset.baseUrl || agentConfig?.providers?.[providerKey]?.baseURL
        result = await runHTTP(prompt, { model, timeout, apiKey, baseUrl, provider: providerKey, systemPrompt })
        break
      }
    }
  }

  // Unwrap { text, usage } from runners
  const text = typeof result === 'string' ? result : result.text
  const usage = typeof result === 'object' ? result.usage : null
  const durationMs = Date.now() - startMs

  // Log usage
  const parts = [`[llm] ${presetName} (${model}) ${durationMs}ms`]
  if (usage?.inputTokens) parts.push(`in=${usage.inputTokens}`)
  if (usage?.outputTokens) parts.push(`out=${usage.outputTokens}`)
  if (usage?.costUsd) parts.push(`$${usage.costUsd.toFixed(4)}`)
  process.stderr.write(parts.join(' ') + '\n')

  // Persist to llm-usage.jsonl
  try {
    const dataDir = process.env.CLAUDE_PLUGIN_DATA
      || join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin')
    const logPath = join(dataDir, 'llm-usage.jsonl')
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      preset: presetName,
      model,
      provider: providerKey || 'native',
      mode,
      duration: durationMs,
      inputTokens: usage?.inputTokens || 0,
      outputTokens: usage?.outputTokens || 0,
      costUsd: usage?.costUsd || 0,
    })
    appendFileSync(logPath, entry + '\n')
  } catch {}

  return text
}

/**
 * Resolve maintenance preset ID for a given task from agent-config.
 * Falls back to canonical defaults (DEFAULT_MAINTENANCE from config.mjs).
 */
export function resolveMaintenancePreset(task, agentConfig) {
  const cfg = agentConfig || loadAgentConfig()
  const maint = cfg?.maintenance || {}
  const presetId = maint[task] || maint.defaultPreset
    || DEFAULT_MAINTENANCE[task] || DEFAULT_MAINTENANCE.defaultPreset
  const presets = cfg?.presets || []
  if (presets.some(p => p.id === presetId || p.name === presetId)) return presetId
  return { id: '_fallback', type: 'native', model: 'sonnet', effort: 'medium' }
}
