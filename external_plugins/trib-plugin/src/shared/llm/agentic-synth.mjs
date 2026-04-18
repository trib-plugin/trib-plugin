/**
 * Agentic Synth Engine — single entry point for all Pool C system synthesis.
 *
 * Replaces scattered LLM calls in memory-cycle, future get_recap, future
 * search-synth, etc. with one unified API:
 *
 *   const result = await synth({
 *     task: 'cycle1',          // identifies the task (cycle1/cycle2/recap/search-synth)
 *     userMessage: '...',       // the data + instructions for this call
 *     mode: 'single-shot',      // 'single-shot' | 'write-back'
 *     preset: 'haiku',          // optional override
 *     timeout: 120000,
 *   });
 *
 * Invariants:
 *   - SYSTEM is always Pool C (rules/pool-c/* monolithic concat).
 *   - Provider/preset is resolved via resolveMaintenancePreset(task).
 *   - All calls log to bridge-trace via maintenance-llm wrapper.
 *
 * Modes:
 *   - single-shot: 1 LLM call → return text. For recap, search-synth, etc.
 *   - write-back: 1 LLM call → caller persists result to DB. For cycle1/2.
 *     (Persistence remains the caller's responsibility — synth only returns text.)
 *
 * Cache strategy:
 *   - Pool C SYSTEM is identical across all synth calls → maximum cache hit
 *     ratio (one cache entry shared workspace-wide).
 *   - Per-task differentiation lives in `userMessage` (the volatile tail).
 *   - For Anthropic OAuth (1h TTL), continuous cycle traffic keeps the
 *     prefix warm so even rare tasks (recap, ad-hoc) hit cache.
 *
 * Future modes (deferred):
 *   - fan-out: parallel sub-queries → merge → synth. Used by Step B
 *     (search/recall AI conversion).
 */

import { createRequire } from 'module'
import { systemBridge } from '../../agent/orchestrator/smart-bridge/system-bridge.mjs'
import { resolveMaintenancePreset } from './index.mjs'

const _require = createRequire(import.meta.url)
const { buildSystemInjectionContent } = _require('../../../lib/rules-builder.cjs')

let _poolCCache = null
let _poolCCacheKey = null

function getPoolCSystem() {
  const root = process.env.CLAUDE_PLUGIN_ROOT
  if (!root) {
    throw new Error('[agentic-synth] CLAUDE_PLUGIN_ROOT not set')
  }
  const dataDir = process.env.CLAUDE_PLUGIN_DATA || ''
  const key = `${root}|${dataDir}`
  // Memoize per-(root, dataDir) — both rarely change within a process lifetime.
  if (_poolCCache && _poolCCacheKey === key) return _poolCCache
  _poolCCache = buildSystemInjectionContent({ PLUGIN_ROOT: root, DATA_DIR: dataDir })
  _poolCCacheKey = key
  return _poolCCache
}

/**
 * Run a Pool C synthesis task.
 *
 * @param {object} opts
 * @param {string} opts.task         — task identifier (cycle1, cycle2, recap, search-synth, ...)
 * @param {string} opts.userMessage  — task-specific data + instructions
 * @param {string} [opts.mode]       — 'single-shot' (default) | 'write-back'
 * @param {string} [opts.preset]     — preset override (else resolved from agent-config)
 * @param {number} [opts.timeout]    — ms, default 120000
 * @param {object} [opts.agentConfig] — explicit agent config (for testing)
 * @returns {Promise<string>}        — the synthesized text
 */
export async function synth({
  task,
  userMessage,
  mode = 'single-shot',
  preset,
  timeout = 120000,
  agentConfig,
}) {
  if (!task) throw new Error('[agentic-synth] task required')
  if (typeof userMessage !== 'string' || !userMessage) {
    throw new Error('[agentic-synth] userMessage (string) required')
  }

  // Pool C SYSTEM = stable monolithic prefix (cache-friendly).
  const system = getPoolCSystem()

  // User message: short task header + the actual data.
  // Identifier (~10 tok) tells the model which Pool C section applies (cycle1,
  // recap, etc.), since the monolithic Pool C contains rules for all tasks.
  const taskHeader = `## Task: ${task}\n\n`
  const composedUserMessage = `${taskHeader}${userMessage}`

  // Resolve preset (caller override > agent-config[task] > default).
  const resolvedPreset = preset || resolveMaintenancePreset(task, agentConfig)

  // Direct provider call via systemBridge — no session pool, no agent
  // orchestration, no tools. The mode parameter is informational only;
  // both 'single-shot' and 'write-back' make the same LLM call. Caller
  // persists the result for write-back tasks.
  const text = await systemBridge({
    task,
    system,
    userMessage: composedUserMessage,
    preset: resolvedPreset,
    timeout,
  })

  return text
}

/**
 * Get the current Pool C SYSTEM content (for tests / inspection).
 */
export function getSystemContent() {
  return getPoolCSystem()
}

/**
 * Clear the Pool C cache (for hot-reload during dev).
 */
export function _clearPoolCCache() {
  _poolCCache = null
  _poolCCacheKey = null
}
