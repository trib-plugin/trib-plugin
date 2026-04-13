/**
 * Unified LLM runner.
 * Routes to CLI or HTTP runners based on preset type/provider.
 * Supports maintenance (isolated) and active (full context) modes.
 */
import { runClaude, runCodex, runGemini } from './cli-runner.mjs'
import { runHTTP, runOllamaHTTP } from './http-runner.mjs'
import { readFileSync } from 'fs'
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
  try { return JSON.parse(readFileSync(AGENT_CONFIG_PATH, 'utf8')) }
  catch { return {} }
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
 * @param {object} options — { mode?: 'maintenance'|'active', timeout?, systemPrompt? }
 * @returns {Promise<string>}
 */
export async function callLLM(prompt, presetOrId, options = {}) {
  const { mode = 'maintenance', timeout = 180000, systemPrompt } = options
  const agentConfig = loadAgentConfig()

  const preset = typeof presetOrId === 'string'
    ? findPreset(presetOrId, agentConfig)
    : presetOrId
  if (!preset) throw new Error(`Preset not found: ${presetOrId}`)

  const model = preset.model
  const providerKey = preset.provider

  // Native (Claude Code CLI)
  if (preset.type === 'native') {
    return runClaude(prompt, { model, mode, timeout, systemPrompt, effort: preset.effort })
  }

  // Bridge — route by provider
  switch (providerKey) {
    case 'openai-oauth':
    case 'copilot':
      return runCodex(prompt, { model, mode, timeout, effort: preset.effort, fast: preset.fast })

    case 'ollama':
    case 'lmstudio': {
      const baseUrl = preset.baseUrl || agentConfig?.providers?.[providerKey]?.baseURL || 'http://localhost:11434'
      return runOllamaHTTP(prompt, { model, timeout, baseUrl })
    }

    case 'gemini':
      return runGemini(prompt, { model, mode, timeout })

    default: {
      // API-key based (openai, anthropic, groq, xai, openrouter, etc.)
      const apiKey = preset.apiKey || resolveApiKey(providerKey, agentConfig)
      const baseUrl = preset.baseUrl || agentConfig?.providers?.[providerKey]?.baseURL
      return runHTTP(prompt, { model, timeout, apiKey, baseUrl, provider: providerKey, systemPrompt })
    }
  }
}

/**
 * Resolve maintenance preset ID for a given task from agent-config.
 * Falls back to default maintenance preset, then 'sonnet-mid'.
 */
export function resolveMaintenancePreset(task, agentConfig) {
  const cfg = agentConfig || loadAgentConfig()
  const maint = cfg?.maintenance || {}
  return maint[task] || maint.defaultPreset || 'sonnet-mid'
}
