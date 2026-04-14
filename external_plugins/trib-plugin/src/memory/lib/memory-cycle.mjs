/**
 * memory-cycle.mjs — Memory consolidation and cleanup cycle.
 * Standalone memory consolidation module.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { cleanMemoryText, getMemoryStore } from './memory.mjs'
import { classifyCandidateConcept } from './memory-extraction.mjs'
import { embedText, configureEmbedding } from './embedding-provider.mjs'
import { callLLM, resolveMaintenancePreset } from '../../shared/llm/index.mjs'
import { cosineSimilarity as cosineSimilarityShared } from './memory-vector-utils.mjs'

const PLUGIN_DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || (() => {
  const candidates = [
    join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'memory.sqlite'))) return c
  }
  return candidates[0]
})()
const CONFIG_PATH = join(PLUGIN_DATA_DIR, 'memory-cycle.json')

// ── Cycle State (waterfall chaining) ──
const CYCLE_STATE_PATH = join(PLUGIN_DATA_DIR, 'cycle-state.json')

const DEFAULT_CYCLE_STATE = {
  cycle1: { lastRunAt: null, interval: '5m' },
  cycle2: { lastRunAt: null, interval: '1h' },
}

const CYCLE_WRITE_PRIORITY = {
  cycle1: 1,
  cycle2: 1,
}

let _cycleWriteActive = false
let _cycleWriteSeq = 0
const _cycleWriteQueue = []

function enqueueCycleWrite(kind, work) {
  return new Promise((resolve, reject) => {
    _cycleWriteQueue.push({
      kind,
      priority: CYCLE_WRITE_PRIORITY[kind] ?? 1,
      seq: _cycleWriteSeq++,
      work,
      resolve,
      reject,
    })
    _cycleWriteQueue.sort((left, right) => right.priority - left.priority || left.seq - right.seq)
    void pumpCycleWriteQueue()
  })
}

async function pumpCycleWriteQueue() {
  if (_cycleWriteActive) return
  const next = _cycleWriteQueue.shift()
  if (!next) return
  _cycleWriteActive = true
  try {
    const result = await next.work()
    next.resolve(result)
  } catch (error) {
    next.reject(error)
  } finally {
    _cycleWriteActive = false
    if (_cycleWriteQueue.length > 0) void pumpCycleWriteQueue()
  }
}

export function loadCycleState() {
  try {
    const raw = readFileSync(CYCLE_STATE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_CYCLE_STATE, ...parsed }
  } catch {
    return { ...DEFAULT_CYCLE_STATE }
  }
}

export function saveCycleState(state) {
  mkdirSync(PLUGIN_DATA_DIR, { recursive: true })
  writeFileSync(CYCLE_STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

const MAX_MEMORY_CONSOLIDATE_DAYS = 2
const MAX_MEMORY_CANDIDATES_PER_DAY = 40
const MAX_MEMORY_CONTEXTUALIZE_ITEMS = 24
const MEMORY_FLUSH_DEFAULT_MAX_DAYS = 1
const MEMORY_FLUSH_DEFAULT_MAX_CANDIDATES = 20
const MEMORY_FLUSH_DEFAULT_MAX_BATCHES = 1
const MEMORY_FLUSH_DEFAULT_MIN_PENDING = 8

// ── Batch system constants ──
const BATCH_SIZE = 50
const MAX_CONCURRENT_BATCHES = 5

// Tier 2 (Auto-flush) thresholds
const AUTO_FLUSH_THRESHOLD = 15
const AUTO_FLUSH_INTERVAL_MS = 2 * 60 * 60 * 1000  // 2 hours

function resolveCycleBackfillLimit(mainConfig, fallback) {
  return Math.max(1, Number(mainConfig?.runtime?.startup?.backfill?.limit ?? fallback))
}

function resolveEmbeddingRefreshOptions(mainConfig = {}, kind = 'cycle2') {
  const cycleConfig = mainConfig?.[kind] ?? {}
  const refreshConfig = cycleConfig?.embeddingRefresh ?? {}
  const contextualizeItems = Math.max(
    4,
    Number(refreshConfig.contextualizeItems ?? MAX_MEMORY_CONTEXTUALIZE_ITEMS),
  )
  const perTypeLimit = Math.max(
    4,
    Number(refreshConfig.perTypeLimit ?? Math.max(16, Math.floor(contextualizeItems / 2))),
  )
  return { contextualizeItems, perTypeLimit }
}

function getStore() {
  const mainConfig = readMainConfig()
  const embeddingConfig = mainConfig?.embedding ?? {}
  if (embeddingConfig.provider || embeddingConfig.ollamaModel || embeddingConfig.dtype) {
    configureEmbedding({
      provider: embeddingConfig.provider,
      ollamaModel: embeddingConfig.ollamaModel,
      dtype: embeddingConfig.dtype,
    })
  }
  return getMemoryStore(PLUGIN_DATA_DIR)
}

function readCycleConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}

function writeCycleConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

function resourceDir() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT
  try {
    const pluginJson = JSON.parse(readFileSync(join(PLUGIN_DATA_DIR, '..', '..', 'cache', 'trib-memory', 'trib-memory', 'plugin.json'), 'utf8'))
    if (pluginJson?.version) return join(PLUGIN_DATA_DIR, '..', '..', 'cache', 'trib-memory', 'trib-memory', pluginJson.version)
  } catch {}
  return join(PLUGIN_DATA_DIR, '..', '..', 'cache', 'trib-memory', 'trib-memory', '0.0.1')
}

function extractJsonObject(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(candidate.slice(start, end + 1)) } catch { return null }
}

function parseClassificationCsv(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const fenced = trimmed.match(/```(?:csv)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1].trim() : trimmed
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean)
  const startIdx = lines[0]?.toLowerCase().includes('case_id') ? 1 : 0
  const items = []
  for (let i = startIdx; i < lines.length; i++) {
    // CSV parsing: protect commas inside quotes
    const parts = []
    let cur = '', inQuote = false
    for (const ch of lines[i]) {
      if (ch === '"') { inQuote = !inQuote; continue }
      if (ch === ',' && !inQuote) { parts.push(cur.trim()); cur = ''; continue }
      cur += ch
    }
    parts.push(cur.trim())
    if (parts.length < 3) continue
    // case_id,text,topic,element,importance
    items.push({
      case_id: parts[0],
      topic: parts[2] || '',
      element: parts[3] || '',
      importance: parts[4] || '',
    })
  }
  return items.length > 0 ? { items } : null
}

// Delegate to shared implementation
function cosineSimilarity(a, b) {
  return cosineSimilarityShared(a, b)
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1))))]
}

export async function buildSemanticDayPlan(dayEpisodes) {
  const rows = dayEpisodes.map((ep, i) => ({ index: i, id: ep.id, role: ep.role, content: cleanMemoryText(ep.content ?? '') })).filter(r => r.content)
  if (rows.length <= 1) return { rows, segments: rows.length ? [{ start: 0, end: rows.length - 1 }] : [], threshold: 1 }
  const vectors = []
  for (const row of rows) {
    vectors.push(await embedText(String(row.content).slice(0, 768)))
  }
  const similarities = []
  for (let i = 0; i < vectors.length - 1; i++) similarities.push(cosineSimilarity(vectors[i], vectors[i + 1]))
  const threshold = Math.max(0.42, percentile(similarities, 35))
  const segments = []
  let start = 0
  for (let i = 0; i < similarities.length; i++) { if (similarities[i] < threshold) { segments.push({ start, end: i }); start = i + 1 } }
  segments.push({ start, end: rows.length - 1 })
  return { rows, segments, threshold }
}

function buildCandidateSpan(dayEpisodes, episodeId, semanticPlan) {
  const targetIndex = dayEpisodes.findIndex(item => Number(item.id) === Number(episodeId))
  if (targetIndex < 0) return ''
  let start = Math.max(0, targetIndex - 1), end = Math.min(dayEpisodes.length - 1, targetIndex + 2)
  if (semanticPlan?.rows?.length) {
    const si = semanticPlan.rows.findIndex(item => Number(item.id) === Number(episodeId))
    if (si >= 0) {
      const seg = semanticPlan.segments.find(s => si >= s.start && si <= s.end)
      if (seg) {
        const sr = semanticPlan.rows[Math.max(0, seg.start - 1)]
        const er = semanticPlan.rows[Math.min(semanticPlan.rows.length - 1, seg.end + 1)]
        if (sr) { const idx = dayEpisodes.findIndex(e => Number(e.id) === Number(sr.id)); if (idx >= 0) start = idx }
        if (er) { const idx = dayEpisodes.findIndex(e => Number(e.id) === Number(er.id)); if (idx >= 0) end = idx }
      }
    }
  }
  const rows = []
  for (let i = start; i <= end && rows.length < 6; i++) {
    const cleaned = cleanMemoryText(dayEpisodes[i]?.content ?? '')
    if (cleaned) rows.push(`${i === targetIndex ? '*' : '-'} ${dayEpisodes[i].role === 'user' ? 'user' : 'assistant'}: ${cleaned}`)
  }
  return rows.join('\n')
}

async function prepareConsolidationCandidates(candidates, maxPerBatch, dayEpisodes = []) {
  const seen = new Set()
  const prepared = []
  const plan = await buildSemanticDayPlan(dayEpisodes)
  for (const item of candidates) {
    const cleaned = cleanMemoryText(item?.content ?? '')
    if (!cleaned) continue
    const concept = classifyCandidateConcept(cleaned, item?.role ?? 'user')
    if (!concept.admit) continue
    const fp = cleaned.toLowerCase().replace(/\s+/g, ' ').trim()
    if (!fp || seen.has(fp)) continue
    seen.add(fp)
    prepared.push({ ...item, content: cleaned, span_content: buildCandidateSpan(dayEpisodes, item?.episode_id, plan) || cleaned })
    if (prepared.length >= maxPerBatch) break
  }
  return prepared
}

async function resolveCycleLlmOutput(prompt, ws, options = {}) {
  if (typeof options.llm === 'function') {
    return await options.llm({
      prompt,
      ws,
      preset: options.preset ?? null,
      timeout: options.timeout ?? null,
      mode: options.mode ?? 'cycle',
      batchIndex: options.batchIndex ?? 0,
      dayKey: options.dayKey ?? null,
      candidates: options.candidates ?? [],
    })
  }
  const preset = options.preset || resolveMaintenancePreset('cycle1')
  return await callLLM(prompt, preset, { mode: 'maintenance', timeout: options.timeout ?? 180000 })
}

// ── Public API ──

export async function consolidateCandidateDay(dayKey, _ws, options = {}) {
  const store = options.store ?? getStore()
  const maxPerBatch = Math.max(1, Number(options.maxCandidatesPerBatch ?? MAX_MEMORY_CANDIDATES_PER_DAY))
  const candidates = await prepareConsolidationCandidates(store.getCandidatesForDate(dayKey), maxPerBatch, store.getEpisodesForDate(dayKey))
  if (candidates.length === 0) return

  // Attempt LLM consolidation with the full consolidation prompt
  let llmSuccess = false
  try {
    const promptPath = join(resourceDir(), 'defaults', 'memory-consolidate-prompt.md')
    if (existsSync(promptPath)) {
      const template = readFileSync(promptPath, 'utf8')
      const candidatesText = candidates.map((c, i) => {
        const lines = [`Case ${i + 1}:`, `- content: ${c.content}`]
        if (c.span_content && c.span_content !== c.content) lines.push(`- Context:\n${c.span_content}`)
        return lines.join('\n')
      }).join('\n\n')
      const prompt = template.replace('{{DATE}}', dayKey).replace('{{CANDIDATES}}', candidatesText)
      const preset = options.preset || resolveMaintenancePreset('cycle2')
      const raw = await resolveCycleLlmOutput(prompt, _ws, {
        ...options,
        mode: 'consolidate',
        dayKey,
        candidates,
        preset,
        timeout: options.timeout ?? 180000,
      })
      const parsed = extractJsonObject(raw)
      if (parsed) {
        const ts = new Date().toISOString()
        // Map facts to classifications
        const classificationRows = []
        for (const fact of (parsed.facts ?? [])) {
          if (!fact?.text) continue
          const caseMatch = String(fact.text).match(/Case\s+(\d+)/i)
          const caseIdx = caseMatch ? Number(caseMatch[1]) - 1 : -1
          const episodeId = caseIdx >= 0 && caseIdx < candidates.length
            ? candidates[caseIdx].episode_id
            : candidates[0]?.episode_id
          classificationRows.push({
            episode_id: Number(episodeId ?? 0),
            classification: String(fact.type ?? 'fact').trim(),
            topic: String(fact.slot || fact.workstream || 'general').trim(),
            element: String(fact.text).trim(),
            importance: String(fact.type ?? '').trim(),
            confidence: Number(fact.confidence ?? 0.6),
          })
        }
        // Map tasks to classifications
        for (const task of (parsed.tasks ?? [])) {
          if (!task?.title) continue
          classificationRows.push({
            episode_id: Number(candidates[0]?.episode_id ?? 0),
            classification: 'task',
            topic: String(task.workstream || task.title).trim().slice(0, 80),
            element: String(task.title).trim() + (task.details ? ` | ${task.details}` : ''),
            importance: task.priority === 'high' ? 'goal' : 'directive',
            confidence: Number(task.confidence ?? 0.5),
          })
        }
        if (classificationRows.length > 0) {
          store.upsertClassifications(classificationRows, ts, null)
          llmSuccess = true
          process.stderr.write(`[memory-cycle] consolidated ${dayKey}: candidates=${candidates.length}, llm_classifications=${classificationRows.length}\n`)
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[memory-cycle] consolidation LLM failed for ${dayKey}: ${e.message}, falling back to classification-only\n`)
  }

  if (!llmSuccess) {
    const ts = new Date().toISOString()
    const fallbackRows = []
    for (const c of candidates) {
      const concept = classifyCandidateConcept(cleanMemoryText(c.content), c.role ?? 'user')
      if (!concept.admit) continue
      fallbackRows.push({
        episode_id: Number(c.episode_id ?? 0),
        classification: String(concept.category ?? 'fact').trim(),
        topic: String(concept.topic || 'general').trim(),
        element: String(cleanMemoryText(c.content)).trim().slice(0, 300),
        importance: concept.importance ?? '',
        confidence: 0.4,
      })
    }
    if (fallbackRows.length > 0) {
      store.upsertClassifications(fallbackRows, ts, null)
    }
    process.stderr.write(`[memory-cycle] consolidated ${dayKey}: candidates=${candidates.length}, mode=classification-only, classifications=${fallbackRows.length}\n`)
  }
  store.markEpisodesClassified(candidates.map(item => item.episode_id ?? item.id))
}

export async function consolidateRecent(dayKeys, ws, options = {}) {
  const targets = [...dayKeys].sort().reverse().slice(0, Math.max(1, Number(options.maxDays ?? MAX_MEMORY_CONSOLIDATE_DAYS))).sort()
  for (const dayKey of targets) await consolidateCandidateDay(dayKey, ws, options)
}

async function refreshEmbeddings(ws, options = {}) {
  const store = options.store ?? getStore()
  const mainConfig = readMainConfig()
  const kind = options.kind ?? 'cycle2'
  const refreshOptions = resolveEmbeddingRefreshOptions(mainConfig, kind)
  const perTypeLimit = options.perTypeLimit ?? refreshOptions.perTypeLimit
  const contextMap = new Map()

  const embedOpts = { perTypeLimit, contextMap }
  if (Array.isArray(options.dayKeys) && options.dayKeys.length > 0) {
    embedOpts.dayKeys = options.dayKeys
  }
  const updated = await store.ensureEmbeddings(embedOpts)
  process.stderr.write(`[memory-cycle] embeddings refreshed: ${updated}\n`)
}

export function readMainConfig() {
  // Try memory-config.json first (dedicated memory settings)
  const memoryConfigPath = join(PLUGIN_DATA_DIR, 'memory-config.json')
  try {
    const raw = JSON.parse(readFileSync(memoryConfigPath, 'utf8'))
    if (raw.enabled !== undefined || raw.cycle1 || raw.cycle2) return raw
  } catch { }
  // Fall back to config.json (legacy unified format)
  const mainConfigPath = join(PLUGIN_DATA_DIR, 'config.json')
  try {
    const raw = JSON.parse(readFileSync(mainConfigPath, 'utf8'))
    if (raw.memory && (raw.memory.cycle1 || raw.memory.enabled !== undefined)) return raw.memory
    return raw
  } catch { return {} }
}

async function runCycle2Impl(ws) {
  const store = getStore()
  const mainConfig = readMainConfig()

  process.stderr.write(`[memory-cycle2] Starting.\n`)

  // 1. Dedup — merge similar classifications (cosine >= 0.85)
  const dedupResult = await deduplicateClassifications(store, { dryRun: false })
  if (dedupResult.merged > 0) {
    process.stderr.write(`[memory-cycle2] dedup: merged=${dedupResult.merged}\n`)
  }

  // 2. Core memory promotion — LLM judges chunks, manages active/pending/demoted/processed
  try {
    await coreMemoryPromote(store, ws, mainConfig)
  } catch (e) {
    process.stderr.write(`[memory-cycle2] core-promote error: ${e.message}\n`)
  }

  // 3. User model decay — reduce confidence on stale hypotheses
  const decayConfig = readMainConfig()
  if (decayConfig.userModel?.enabled !== false) {
    try { store.decayUserModel(decayConfig.userModel?.decayDays || 30) } catch {}
  }

  // 4. Refresh context.md from core_memory
  try {
    store.writeContextFile()
    process.stderr.write('[memory-cycle2] context.md refreshed.\n')
  } catch (e) {
    process.stderr.write(`[memory-cycle2] context.md refresh error: ${e.message}\n`)
  }

  process.stderr.write('[memory-cycle2] Cycle complete.\n')

  // Update cycle config
  const cycleConfig = readCycleConfig()
  writeCycleConfig({ ...cycleConfig, lastSleepAt: Date.now() })

  // Update cycle state
  const cycleState = loadCycleState()
  cycleState.cycle2.lastRunAt = new Date().toISOString()
  saveCycleState(cycleState)
}

export async function runCycle2(ws) {
  return enqueueCycleWrite('cycle2', () => runCycle2Impl(ws))
}

// ── Cycle2: Dedup/merge similar classifications ──

const DEDUP_SIMILARITY_THRESHOLD = 0.85

async function deduplicateClassifications(store, options = {}) {
  const dryRun = Boolean(options.dryRun ?? false)
  const threshold = Number(options.threshold ?? DEDUP_SIMILARITY_THRESHOLD)

  const rows = store.db.prepare(`
    SELECT c.id, c.episode_id, c.topic, c.element, c.importance, c.confidence, c.updated_at
    FROM classifications c
    WHERE c.status = 'active'
    ORDER BY c.updated_at DESC
    LIMIT 500
  `).all()

  if (rows.length < 2) return { merged: 0, checked: 0 }

  // Load vectors for classifications
  const vectors = new Map()
  for (const row of rows) {
    const vec = store.db.prepare(`
      SELECT vector_json FROM memory_vectors
      WHERE entity_type = 'classification' AND entity_id = ?
    `).get(row.id)
    if (vec?.vector_json) {
      try {
        const parsed = typeof vec.vector_json === 'string' ? JSON.parse(vec.vector_json) : vec.vector_json
        if (Array.isArray(parsed) && parsed.length > 0) vectors.set(row.id, parsed)
      } catch {}
    }
  }

  const merged = []
  const removed = new Set()

  for (let i = 0; i < rows.length; i++) {
    if (removed.has(rows[i].id)) continue
    const vecA = vectors.get(rows[i].id)
    if (!vecA) continue

    for (let j = i + 1; j < rows.length; j++) {
      if (removed.has(rows[j].id)) continue
      const vecB = vectors.get(rows[j].id)
      if (!vecB) continue

      const sim = cosineSimilarity(vecA, vecB)
      if (sim >= threshold) {
        // Keep the newer one (i is newer due to DESC sort), remove j
        removed.add(rows[j].id)
        merged.push({
          kept: rows[i].id,
          removed: rows[j].id,
          similarity: sim,
          keptTopic: rows[i].topic,
          removedTopic: rows[j].topic,
        })
      }
    }
  }

  if (!dryRun && removed.size > 0) {
    const ids = [...removed]
    const placeholders = ids.map(() => '?').join(',')
    store.db.prepare(`UPDATE classifications SET status = 'superseded' WHERE id IN (${placeholders})`).run(...ids)
    store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'classification' AND entity_id IN (${placeholders})`).run(...ids)
  }

  return { merged: merged.length, checked: rows.length, removed: [...removed], details: dryRun ? merged : undefined }
}

async function memoryFlushImpl(ws, options = {}) {
  const mainConfig = readMainConfig()
  // Phase 1: process cycle1 backlog (large batch)
  try {
    const result = await runCycle1Impl(ws, mainConfig, {
      maxItems: Number(options.maxCandidatesPerBatch ?? 100),
      maxAgeDays: Number(options.maxDays ?? 30)
    })
    process.stderr.write(`[flush] cycle1: extracted=${result?.extracted ?? 0} classifications=${result?.classifications ?? 0}\n`)
  } catch (e) {
    process.stderr.write(`[flush] cycle1 error: ${e.message}\n`)
  }
  // Phase 2: trigger cycle2
  try {
    await runCycle2Impl(ws)
    process.stderr.write(`[flush] cycle2 completed\n`)
  } catch (e) {
    process.stderr.write(`[flush] cycle2 error: ${e.message}\n`)
  }
}

export async function memoryFlush(ws, options = {}) {
  return enqueueCycleWrite('cycle2', () => memoryFlushImpl(ws, options))
}

// ── Rebuild mode: concurrent batch cycle1 + embedding pairs ──

const WINDOW_TO_DAYS = { '1d': 1, '3d': 3, '7d': 7, '30d': 30 }

async function rebuildClassificationsImpl(ws, options = {}) {
  const store = options.store ?? getStore()
  const config = readMainConfig()
  const maxAgeDays = options.window ? (WINDOW_TO_DAYS[options.window] ?? null) : (options.maxAgeDays ?? null) // null = all
  const maxConcurrent = Math.max(1, Math.min(Number(options.maxConcurrentBatches ?? MAX_CONCURRENT_BATCHES), 10))
  const batchSize = Math.max(1, Number(options.batchSize ?? BATCH_SIZE))

  try { store.backfillProject(ws, { limit: 500 }) } catch {}

  const pendingDaysLimit = maxAgeDays ?? 9999
  const pendingDays = store.getPendingCandidateDays(pendingDaysLimit, 1)
  if (pendingDays.length === 0) {
    process.stderr.write('[rebuild] no pending candidates.\n')
    return { total: 0, batches: 0, classifications: 0 }
  }

  // Collect all pending candidates within maxAgeDays
  const allCandidates = []
  for (const { day_key } of pendingDays.sort((a, b) => b.day_key.localeCompare(a.day_key))) {
    const dayCandidates = store.getCandidatesForDate(day_key)
      .map(c => ({ ...c, content: cleanMemoryText(c.content) }))
      .filter(c => c.content && !looksLowSignalCycle1(c.content))
    allCandidates.push(...dayCandidates)
  }
  if (allCandidates.length === 0) {
    process.stderr.write('[rebuild] no valid candidates after filtering.\n')
    return { total: 0, batches: 0, classifications: 0 }
  }

  // Split into batches
  const batches = []
  for (let i = 0; i < allCandidates.length; i += batchSize) {
    batches.push(allCandidates.slice(i, i + batchSize))
  }

  process.stderr.write(`[rebuild] ${allCandidates.length} candidates in ${batches.length} batches (concurrency=${maxConcurrent})\n`)

  let totalExtracted = 0
  let totalClassifications = 0
  let batchesCompleted = 0

  // Process batches in concurrent waves
  for (let i = 0; i < batches.length; i += maxConcurrent) {
    const wave = batches.slice(i, i + maxConcurrent)
    const waveResults = await Promise.all(
      wave.map((batch, idx) => {
        const batchIdx = i + idx
        return runCycle1Impl(ws, config, {
          store,
          force: true,
          maxItems: batch.length,
          _preSplitCandidates: batch,
        }).catch(e => {
          process.stderr.write(`[rebuild] batch ${batchIdx} error: ${e.message}\n`)
          return { extracted: 0, classifications: 0 }
        })
      })
    )

    for (const result of waveResults) {
      totalExtracted += result.extracted ?? 0
      totalClassifications += result.classifications ?? 0
      batchesCompleted++
    }

    process.stderr.write(`[rebuild] wave ${Math.floor(i / maxConcurrent) + 1}: ${waveResults.length} batches done, total=${totalExtracted}/${allCandidates.length}\n`)
  }

  // Final embedding pass with high limit to cover all new chunks
  if (totalExtracted > 0) {
    const rebuildDayKeys = [...new Set(allCandidates.map(c => c.day_key).filter(Boolean))]
    await refreshEmbeddings(ws, { store, kind: 'cycle1', dayKeys: rebuildDayKeys })
  }

  store.writeRecentFile()

  process.stderr.write(`[rebuild] complete: ${totalExtracted} extracted, ${totalClassifications} classifications, ${batchesCompleted} batches\n`)
  return { total: totalExtracted, batches: batchesCompleted, classifications: totalClassifications }
}

export async function rebuildClassifications(ws, options = {}) {
  return enqueueCycleWrite('cycle1', () => rebuildClassificationsImpl(ws, options))
}

async function rebuildRecentImpl(ws, options = {}) {
  const store = getStore()
  const mainConfig = readMainConfig()
  store.backfillProject(ws, { limit: Math.max(resolveCycleBackfillLimit(mainConfig, 120), 240) })
  store.syncHistoryFromFiles()
  const maxDays = Math.max(1, Number(options.window ? (WINDOW_TO_DAYS[options.window] ?? options.maxDays ?? 2) : (options.maxDays ?? 2)))
  const dayKeys = store.getRecentCandidateDays(maxDays).map(d => d.day_key).sort().reverse()
  if (!dayKeys.length) { process.stderr.write('[memory-cycle] no recent days.\n'); return }
  store.resetConsolidatedMemoryForDays(dayKeys)
  const mergedOptions = options.preset ? options : { ...options, preset: resolveMaintenancePreset('cycle2') }
  for (const dayKey of dayKeys) await consolidateCandidateDay(dayKey, ws, mergedOptions)
  store.syncHistoryFromFiles()
  await refreshEmbeddings(ws, { kind: 'cycle2', dayKeys })
  process.stderr.write(`[memory-cycle] rebuilt recent ${dayKeys.length} day(s).\n`)
}

export async function rebuildRecent(ws, options = {}) {
  return enqueueCycleWrite('cycle2', () => rebuildRecentImpl(ws, options))
}

async function pruneToRecentImpl(ws, options = {}) {
  const store = getStore()
  const mainConfig = readMainConfig()
  store.backfillProject(ws, { limit: Math.max(resolveCycleBackfillLimit(mainConfig, 120), 240) })
  store.syncHistoryFromFiles()
  const maxDays = Math.max(1, Number(options.maxDays ?? 5))
  const dayKeys = store.getRecentCandidateDays(maxDays).map(d => d.day_key).sort().reverse()
  if (!dayKeys.length) { process.stderr.write('[memory-cycle] no recent days.\n'); return }
  store.pruneConsolidatedMemoryOutsideDays(dayKeys)
  await refreshEmbeddings(ws, { kind: 'cycle2', dayKeys })
  process.stderr.write(`[memory-cycle] pruned to ${dayKeys.join(', ')}.\n`)
}

export async function pruneToRecent(ws, options = {}) {
  return enqueueCycleWrite('cycle2', () => pruneToRecentImpl(ws, options))
}

export function getCycleStatus() {
  const config = readCycleConfig()
  const mainConfig = readMainConfig()
  const store = getStore()
  const pending = store.getPendingCandidateDays(100, 1)
  const cycleState = loadCycleState()
  const memoryConfig = mainConfig ?? {}
  return {
    lastSleepAt: config.lastSleepAt ? new Date(config.lastSleepAt).toISOString() : null,
    lastCycle1At: config.lastCycle1At ? new Date(config.lastCycle1At).toISOString() : null,
    pendingDays: pending.length,
    pendingCandidates: pending.reduce((sum, d) => sum + d.n, 0),
    cycleState,
    memoryConfig: {
      cycle1: {
        interval: memoryConfig.cycle1?.interval ?? '5m',
        maxPending: memoryConfig.cycle1?.maxPending ?? null,
        preset: resolveMaintenancePreset('cycle1'),
      },
      cycle2: { interval: memoryConfig.cycle2?.interval ?? '1h', maxCandidates: memoryConfig.cycle2?.maxCandidates ?? null, preset: resolveMaintenancePreset('cycle2') },
    },
  }
}

// ── Cycle1: Lightweight interval-based memory extraction ──

function looksLowSignalCycle1(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return true
  if (clean.includes('[Request interrupted by user]')) return true
  if (/<event-result[\s>]|<event\s/i.test(String(text ?? ''))) return true
  if (/^(read|list|show|count|find|tell me|summarize)\b/i.test(clean) && /(\/|\.jsonl\b|\.md\b|\.csv\b|\bfilenames?\b)/i.test(clean)) return true
  if (/^no response requested\.?$/i.test(clean)) return true
  if (/^stop hook error:/i.test(clean)) return true
  if (/return this exact shape:/i.test(clean)) return true
  const compact = clean.replace(/\s+/g, '')
  const hasKorean = /[\uAC00-\uD7AF]/.test(compact)
  const shortKoreanMeaningful =
    hasKorean &&
    compact.length >= 2 &&
    (
      /[?？]$/.test(clean) ||
      /일정|상태|시간|규칙|정책|언어|말투|호칭|기억|검색|중복|설정|오류|버그|왜|뭐|언제|어디|누구|무엇/.test(clean) ||
      classifyCandidateConcept(clean, 'user')?.admit
    )
  if (compact.length < (hasKorean ? 4 : 8) && !shortKoreanMeaningful) return true
  return false
}

function loadClassificationPrompt() {
  const promptPath = join(resourceDir(), 'defaults', 'memory-classification-prompt.md')
  if (existsSync(promptPath)) return readFileSync(promptPath, 'utf8')
  return 'Fill the missing classification columns for each row. Output JSON only.\n\n{{ROWS}}'
}


function buildCycle1ClassificationRows(candidates = []) {
  return candidates.map(candidate => {
    const text = candidate.content?.slice(0, 300) || ''
    return `- id:${candidate.episode_id} text:${text}`
  }).join('\n')
}



async function runCycle1Impl(ws, config, options = {}) {
  const store = options.store ?? getStore()
  const cycleConfig = readCycleConfig()
  const force = Boolean(options.force)

  // Backfill recent transcripts (config-driven limit)
  const backfillLimit = resolveCycleBackfillLimit(config, 50)
  try { store.backfillProject(ws, { limit: backfillLimit }) } catch {}

  const cycle1Config = config?.cycle1 ?? {}
  const batchSize = Math.max(1, Number(options.maxItems ?? cycle1Config.batchSize ?? BATCH_SIZE))
  const maxDays = force ? 9999 : Math.max(1, Number(options.maxAgeDays ?? cycle1Config.maxDays ?? 7))
  const preset = resolveMaintenancePreset('cycle1')
  const timeout = config?.cycle1?.timeout || 300000

  // Support pre-split candidates from rebuildClassifications
  let allCandidates
  if (Array.isArray(options._preSplitCandidates) && options._preSplitCandidates.length > 0) {
    allCandidates = options._preSplitCandidates
  } else {
    // Unclassified episodes from recent maxDays
    // getCandidatesForDate delegates to getUnclassifiedEpisodesForDate
    const pendingDays = store.getPendingCandidateDays(maxDays, 1)
    if (pendingDays.length === 0) {
      writeCycleConfig({ ...cycleConfig, lastCycle1At: Date.now() })
      return { extracted: 0, classifications: 0 }
    }

    allCandidates = []
    for (const { day_key } of pendingDays.sort((a, b) => b.day_key.localeCompare(a.day_key))) {
      const dayCandidates = store.getCandidatesForDate(day_key)
        .map(c => ({ ...c, content: cleanMemoryText(c.content) }))
        .filter(c => c.content && !looksLowSignalCycle1(c.content))
      allCandidates.push(...dayCandidates)
      if (!force && allCandidates.length >= batchSize) break
    }
    if (allCandidates.length === 0) {
      writeCycleConfig({ ...cycleConfig, lastCycle1At: Date.now() })
      return { extracted: 0, classifications: 0 }
    }
  }

  let totalExtracted = 0, totalClassifications = 0
  const changedClassificationIds = new Set()

  // force: process all pending in batchSize chunks continuously / scheduled: one batchSize pass
  const batches = []
  for (let i = 0; i < allCandidates.length; i += batchSize) {
    batches.push(allCandidates.slice(i, i + batchSize))
    if (!force) break
  }

  const concurrency = force ? Number(cycle1Config.concurrency ?? 2) : 1

  async function processSingleBatch(candidates, batchIndex) {
    const extractionPrompt = loadClassificationPrompt()
      .replace('{{ROWS}}', buildCycle1ClassificationRows(candidates))

    let raw
    try {
      raw = await resolveCycleLlmOutput(extractionPrompt, ws, {
        ...options,
        mode: 'cycle1',
        batchIndex,
        candidates,
        preset,
        timeout,
      })
    } catch (e) {
      process.stderr.write(`[cycle1] batch ${batchIndex} LLM error: ${e.message}\n`)
      return null
    }

    // Parse JSON array (primary) or CSV (fallback)
    let classificationRows = []
    try {
      const jsonMatch = String(raw).match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        const items = JSON.parse(jsonMatch[0])
        classificationRows = items.map(item => ({
          episode_id: Number(item?.id ?? item?.case_id ?? 0),
          classification: '-',
          topic: String(item?.topic ?? '').trim(),
          element: String(item?.element ?? '').trim(),
          importance: String(item?.importance ?? '').trim(),
          confidence: 0.6,
          chunks: Array.isArray(item?.chunks) ? item.chunks.map(c => String(c).trim()).filter(Boolean).slice(0, 3) : [],
        }))
      }
    } catch {}
    if (classificationRows.length === 0) {
      const parsed = parseClassificationCsv(raw)
      if (parsed?.items) {
        classificationRows = parsed.items.map(item => ({
          episode_id: Number(item?.case_id ?? 0),
          classification: '-',
          topic: String(item?.topic ?? '').trim(),
          element: String(item?.element ?? '').trim(),
          importance: String(item?.importance ?? '').trim(),
          confidence: 0.6,
        }))
      }
    }
    if (classificationRows.length === 0) {
      process.stderr.write(`[cycle1] batch ${batchIndex}: unparseable response (${String(raw).slice(0, 200)})\n`)
      return null
    }

    // Post-process: enrich short elements with candidate source text
    const candidateById = new Map(candidates.map(c => [Number(c.episode_id), c]))
    for (const row of classificationRows) {
      // element too short → use candidate content as fallback
      if (row.element.length < 8) {
        const src = candidateById.get(row.episode_id)
        if (src?.content) {
          const fallback = cleanMemoryText(src.content).slice(0, 120)
          row.element = fallback || row.element
        }
      }
      // topic too short → prepend element keywords
      if (row.topic.length < 4 && row.element.length >= 4) {
        row.topic = row.element.split(/\s+/).slice(0, 3).join(' ')
      }
    }

    return { candidates, classificationRows, batchIndex }
  }

  // LLM calls run in parallel; DB writes are sequential after collecting results
  const allResults = []
  for (let i = 0; i < batches.length; i += concurrency) {
    const chunk = batches.slice(i, i + concurrency)
    const results = await Promise.all(chunk.map((batch, idx) => processSingleBatch(batch, i + idx)))
    allResults.push(...results)

    // NOTE: cycle1 must NEVER write to core_memory table — that is cycle2's responsibility
    const ts = new Date().toISOString()
    for (const result of results) {
      if (!result) continue
      const { candidates, classificationRows, batchIndex } = result

      // Snapshot existing elements before upsert to detect changes for embedding refresh
      const elementChangedIds = new Set()
      for (const row of classificationRows) {
        const epId = Number(row.episode_id)
        if (!epId) continue
        const existing = store.db.prepare('SELECT id, element FROM classifications WHERE episode_id = ?').get(epId)
        if (existing && existing.element !== row.element) {
          elementChangedIds.add(existing.id)
        }
      }

      store.upsertClassifications(classificationRows, ts, null)

      // Update user model for preference/constraint classifications
      const umConfig = readMainConfig()
      if (umConfig.userModel?.enabled !== false) {
        for (const row of classificationRows) {
          if (['preference', 'constraint'].includes(row.importance)) {
            try {
              store.upsertUserModel(row.importance, row.element, row.confidence ?? 0.6, row.episode_id)
            } catch {}
          }
        }
      }

      // Save chunks to memory_chunks table + FTS
      for (const row of classificationRows) {
        const epId = Number(row.episode_id)
        if (!epId || !Array.isArray(row.chunks) || row.chunks.length === 0) continue
        const clsRow = store.db.prepare('SELECT id FROM classifications WHERE episode_id = ?').get(epId)
        const clsId = clsRow?.id ?? null
        // Remove old chunks for this episode
        try { store.db.prepare('DELETE FROM memory_chunks WHERE episode_id = ?').run(epId) } catch {}
        for (let seq = 0; seq < row.chunks.length; seq++) {
          const chunkText = String(row.chunks[seq]).trim()
          if (!chunkText) continue
          store.db.prepare(`
            INSERT INTO memory_chunks (episode_id, classification_id, content, topic, importance, seq)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(epId, clsId, chunkText, row.topic || null, row.importance || null, seq)
          // FTS
          const chunkId = store.db.prepare('SELECT last_insert_rowid() as id').get().id
          try {
            store.db.prepare('INSERT INTO memory_chunks_fts(rowid, content, topic) VALUES (?, ?, ?)').run(chunkId, chunkText, row.topic || '')
          } catch {}
        }
      }

      const processedEpisodeIds = candidates.map(c => c.episode_id ?? c.id).filter(id => id != null)
      if (processedEpisodeIds.length > 0) {
        store.markEpisodesClassified(processedEpisodeIds)
      }

      totalExtracted += candidates.length
      totalClassifications += classificationRows.length
      process.stderr.write(`[cycle1] batch ${batchIndex}: ${candidates.length} candidates → ${classificationRows.length} classifications\n`)

      // Collect classification IDs whose element changed (need embedding refresh)
      for (const id of elementChangedIds) {
        changedClassificationIds.add(id)
      }
    }
  }

  // Inline embedding: only embed classifications created/changed in THIS cycle
  if (totalExtracted > 0) {
    const targetIds = new Map()
    const clsIds = new Set(changedClassificationIds)
    for (const result of allResults) {
      if (!result) continue
      for (const row of result.classificationRows) {
        const epId = Number(row.episode_id)
        if (!epId) continue
        const cls = store.db.prepare('SELECT id FROM classifications WHERE episode_id = ?').get(epId)
        if (cls) clsIds.add(cls.id)
      }
    }
    targetIds.set('classification', clsIds)
    const embeddedCount = await store.ensureEmbeddings({ targetIds })
    process.stderr.write(`[cycle1] inline embeddings: ${embeddedCount}/${clsIds.size} classifications\n`)
  }

  // NOTE: cycle1 must NEVER access core_memory — that is cycle2's exclusive domain

  // Update recent.md (last 20 turns)
  store.writeRecentFile()

  writeCycleConfig({ ...cycleConfig, lastCycle1At: Date.now() })

  // Update cycle state
  const cycleState = loadCycleState()
  cycleState.cycle1.lastRunAt = new Date().toISOString()
  saveCycleState(cycleState)

  const result = {
    extracted: totalExtracted,
    classifications: totalClassifications,
  }
  if (totalExtracted > 0) {
    process.stderr.write(`[memory-cycle1] extracted=${result.extracted} classifications=${result.classifications}\n`)
  }
  return result
}

/**
 * Core memory LLM-based promotion (cycle2 exclusive).
 *
 * Three-phase flow:
 *   Phase 1: Unprocessed chunks → LLM judges active/pending/skip → mark chunks processed
 *   Phase 2: Re-evaluate pending + demoted → promote(active)/keep/processed
 *   Phase 3: Review active → enforce 50-item cap, demote stale/low-value
 *
 * States: active (injected), pending (not injected, re-eval), demoted (can revive), processed (done)
 */
async function coreMemoryPromote(store, ws, config) {
  const cycle2Config = config?.cycle2 ?? {}
  const preset = resolveMaintenancePreset('cycle2')
  const ACTIVE_CAP = 50
  const CHUNK_BATCH_SIZE = 50

  const corePromptPath = join(resourceDir(), 'defaults', 'memory-core-promote-prompt.md')
  if (!existsSync(corePromptPath)) {
    process.stderr.write(`[memory-cycle2] core-promote prompt not found, skipping\n`)
    return
  }
  const coreTemplate = readFileSync(corePromptPath, 'utf8')
  const ts = new Date().toISOString()

  // ── Helper: load current active list for LLM context ──
  function loadActiveList() {
    return store.db.prepare(
      `SELECT id, topic, element, importance, mention_count, last_mentioned_at
       FROM core_memory WHERE status = 'active'
       ORDER BY mention_count DESC, last_mentioned_at DESC NULLS LAST`
    ).all()
  }

  // ── Helper: sync linked chunk status when core_memory status changes ──
  function syncChunkStatus(coreMemoryId, newStatus) {
    try {
      const row = store.db.prepare(`SELECT chunk_id FROM core_memory WHERE id = ?`).get(coreMemoryId)
      if (row?.chunk_id) {
        store.db.prepare(`UPDATE memory_chunks SET status = ? WHERE id = ?`).run(newStatus, row.chunk_id)
      }
    } catch (e) {
      process.stderr.write(`[memory-cycle2] syncChunkStatus error: ${e.message}\n`)
    }
  }

  // ── Helper: apply LLM actions array to core_memory ──
  function applyActions(allActions, chunkRows) {
    let addCount = 0, pendingCount = 0, promoteCount = 0, updateCount = 0, demoteCount = 0, mergeCount = 0, processedCount = 0, archivedCount = 0

    for (const act of allActions) {
      try {
        if (act.action === 'add' && act.element) {
          // Find matching chunk or classification to link
          const matchChunk = chunkRows?.find(r => r.topic === act.topic || r.content?.includes(act.element?.slice(0, 60)))
          const clsId = matchChunk?.classification_id ?? act.classification_id ?? 0
          const chunkId = matchChunk?.id ?? act.chunk_id ?? null
          if (clsId <= 0) continue
          store.db.prepare(`
            INSERT INTO core_memory (classification_id, chunk_id, topic, element, importance, final_score, promoted_at, last_seen_at, status)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active')
            ON CONFLICT(classification_id) DO UPDATE SET
              chunk_id = excluded.chunk_id, topic = excluded.topic, element = excluded.element,
              importance = excluded.importance, last_seen_at = excluded.last_seen_at, status = 'active'
          `).run(clsId, chunkId, act.topic ?? '', act.element, act.importance ?? 'fact', ts, ts)
          // Sync linked chunk to active
          if (chunkId) {
            store.db.prepare(`UPDATE memory_chunks SET status = 'active' WHERE id = ?`).run(chunkId)
          }
          addCount++
        } else if (act.action === 'pending' && act.element) {
          const matchChunk = chunkRows?.find(r => r.topic === act.topic || r.content?.includes(act.element?.slice(0, 60)))
          const clsId = matchChunk?.classification_id ?? act.classification_id ?? 0
          const chunkId = matchChunk?.id ?? act.chunk_id ?? null
          if (clsId <= 0) continue
          store.db.prepare(`
            INSERT INTO core_memory (classification_id, chunk_id, topic, element, importance, final_score, promoted_at, last_seen_at, status)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'pending')
            ON CONFLICT(classification_id) DO UPDATE SET
              chunk_id = excluded.chunk_id, topic = excluded.topic, element = excluded.element,
              importance = excluded.importance, last_seen_at = excluded.last_seen_at, status = 'pending'
          `).run(clsId, chunkId, act.topic ?? '', act.element, act.importance ?? 'fact', ts, ts)
          // Sync linked chunk to pending
          if (chunkId) {
            store.db.prepare(`UPDATE memory_chunks SET status = 'pending' WHERE id = ?`).run(chunkId)
          }
          pendingCount++
        } else if (act.action === 'promote' && act.id) {
          store.db.prepare(
            `UPDATE core_memory SET status = 'active', last_seen_at = ? WHERE id = ? AND status IN ('pending', 'demoted')`
          ).run(ts, act.id)
          syncChunkStatus(act.id, 'active')
          promoteCount++
        } else if (act.action === 'update' && act.id && act.element) {
          store.db.prepare(
            `UPDATE core_memory SET element = ?, importance = ?, last_seen_at = ? WHERE id = ?`
          ).run(act.element, act.importance ?? 'fact', ts, act.id)
          updateCount++
        } else if (act.action === 'demote' && act.id) {
          store.db.prepare(`UPDATE core_memory SET status = 'demoted' WHERE id = ?`).run(act.id)
          syncChunkStatus(act.id, 'demoted')
          demoteCount++
        } else if (act.action === 'archived' && act.id) {
          store.db.prepare(`UPDATE core_memory SET status = 'archived' WHERE id = ?`).run(act.id)
          syncChunkStatus(act.id, 'archived')
          archivedCount++
        } else if (act.action === 'processed' && act.id) {
          store.db.prepare(`UPDATE core_memory SET status = 'processed' WHERE id = ?`).run(act.id)
          syncChunkStatus(act.id, 'processed')
          processedCount++
        } else if (act.action === 'merge' && Array.isArray(act.ids) && act.ids.length >= 2 && act.element) {
          const [keepId, ...removeIds] = act.ids
          store.db.prepare(
            `UPDATE core_memory SET element = ?, topic = ?, importance = ?, last_seen_at = ? WHERE id = ?`
          ).run(act.element, act.topic ?? '', act.importance ?? 'fact', ts, keepId)
          for (const rid of removeIds) {
            store.db.prepare(`UPDATE core_memory SET status = 'demoted' WHERE id = ?`).run(rid)
            syncChunkStatus(rid, 'demoted')
          }
          mergeCount++
          demoteCount += removeIds.length
        }
      } catch (e) {
        process.stderr.write(`[memory-cycle2] core-promote action error: ${e.message}\n`)
      }
    }
    return { addCount, pendingCount, promoteCount, updateCount, demoteCount, mergeCount, processedCount, archivedCount }
  }

  // ── Helper: format active list for LLM ──
  function formatActiveList(activeList) {
    if (activeList.length === 0) return '(empty)'
    return activeList.map(cm =>
      `- id:${cm.id} topic:${cm.topic} importance:${cm.importance} mentions:${cm.mention_count ?? 0} element:${cm.element}`
    ).join('\n')
  }

  // ═══════════════════════════════════════════════════════════════
  //  Phase 1: Unprocessed chunks → LLM judgment
  // ═══════════════════════════════════════════════════════════════

  // Track which chunks cycle2 has already processed via memory_meta
  let lastProcessedChunkId = 0
  try {
    const meta = store.db.prepare(`SELECT value FROM memory_meta WHERE key = 'cycle2_last_chunk_id'`).get()
    if (meta?.value) lastProcessedChunkId = Number(meta.value)
  } catch {}

  const unprocessedChunks = store.db.prepare(`
    SELECT mc.id, mc.episode_id, mc.classification_id, mc.content, mc.topic, mc.importance
    FROM memory_chunks mc
    WHERE mc.status = 'active' AND mc.id > ?
    ORDER BY mc.id ASC
    LIMIT ?
  `).all(lastProcessedChunkId, CHUNK_BATCH_SIZE)

  let phase1Stats = { addCount: 0, pendingCount: 0 }

  if (unprocessedChunks.length > 0) {
    const activeList = loadActiveList()
    const chunksText = unprocessedChunks.map(c =>
      `- chunk_id:${c.id} cls_id:${c.classification_id} topic:${c.topic || '(none)'} importance:${c.importance || '(none)'} content:${String(c.content).slice(0, 300)}`
    ).join('\n')

    const phase1Prompt = coreTemplate
      .replace('{{PHASE}}', 'phase1_new_chunks')
      .replace('{{CORE_MEMORY}}', formatActiveList(activeList))
      .replace('{{ITEMS}}', chunksText)

    try {
      const raw = await resolveCycleLlmOutput(phase1Prompt, ws, {
        mode: 'core-promote', preset, timeout: 180000,
      })
      const parsed = extractJsonObject(raw)
      if (parsed?.actions && Array.isArray(parsed.actions)) {
        phase1Stats = applyActions(parsed.actions, unprocessedChunks)
      }
    } catch (e) {
      process.stderr.write(`[memory-cycle2] phase1 LLM failed: ${e.message}\n`)
    }

    // Mark chunks as processed by updating watermark
    const maxChunkId = unprocessedChunks[unprocessedChunks.length - 1].id
    store.db.prepare(
      `INSERT INTO memory_meta (key, value) VALUES ('cycle2_last_chunk_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(String(maxChunkId))

    process.stderr.write(`[memory-cycle2] phase1: chunks=${unprocessedChunks.length} add=${phase1Stats.addCount} pending=${phase1Stats.pendingCount}\n`)
  }

  // ═══════════════════════════════════════════════════════════════
  //  Phase 2: Re-evaluate pending + demoted
  // ═══════════════════════════════════════════════════════════════

  const pendingDemotedRows = store.db.prepare(`
    SELECT id, topic, element, importance, mention_count, last_mentioned_at, status
    FROM core_memory
    WHERE status IN ('pending', 'demoted')
    ORDER BY mention_count DESC, last_mentioned_at DESC NULLS LAST
    LIMIT 50
  `).all()

  let phase2Stats = { promoteCount: 0, processedCount: 0 }

  if (pendingDemotedRows.length > 0) {
    const activeList = loadActiveList()
    const itemsText = pendingDemotedRows.map(r =>
      `- id:${r.id} status:${r.status} topic:${r.topic} importance:${r.importance} mentions:${r.mention_count ?? 0} last_mentioned:${r.last_mentioned_at ?? 'never'} element:${r.element}`
    ).join('\n')

    const phase2Prompt = coreTemplate
      .replace('{{PHASE}}', 'phase2_reevaluate')
      .replace('{{CORE_MEMORY}}', formatActiveList(activeList))
      .replace('{{ITEMS}}', itemsText)

    try {
      const raw = await resolveCycleLlmOutput(phase2Prompt, ws, {
        mode: 'core-promote', preset, timeout: 180000,
      })
      const parsed = extractJsonObject(raw)
      if (parsed?.actions && Array.isArray(parsed.actions)) {
        phase2Stats = applyActions(parsed.actions, null)
      }
    } catch (e) {
      process.stderr.write(`[memory-cycle2] phase2 LLM failed: ${e.message}\n`)
    }

    process.stderr.write(`[memory-cycle2] phase2: reviewed=${pendingDemotedRows.length} promote=${phase2Stats.promoteCount} processed=${phase2Stats.processedCount}\n`)
  }

  // ═══════════════════════════════════════════════════════════════
  //  Phase 3: Active review — enforce cap + demote stale
  // ═══════════════════════════════════════════════════════════════

  const currentActive = loadActiveList()

  if (currentActive.length > 0) {
    const activeList = currentActive
    const needsTrim = activeList.length > ACTIVE_CAP
    const itemsText = activeList.map(r =>
      `- id:${r.id} topic:${r.topic} importance:${r.importance} mentions:${r.mention_count ?? 0} last_mentioned:${r.last_mentioned_at ?? 'never'} element:${r.element}`
    ).join('\n')

    const phase3Prompt = coreTemplate
      .replace('{{PHASE}}', 'phase3_active_review')
      .replace('{{CORE_MEMORY}}', formatActiveList(activeList))
      .replace('{{ITEMS}}', itemsText)
      .replace('{{ACTIVE_CAP}}', String(ACTIVE_CAP))
      .replace('{{ACTIVE_COUNT}}', String(activeList.length))

    try {
      const raw = await resolveCycleLlmOutput(phase3Prompt, ws, {
        mode: 'core-promote', preset, timeout: 180000,
      })
      const parsed = extractJsonObject(raw)
      if (parsed?.actions && Array.isArray(parsed.actions)) {
        const phase3Stats = applyActions(parsed.actions, null)
        process.stderr.write(`[memory-cycle2] phase3: active=${activeList.length}→${loadActiveList().length} demote=${phase3Stats.demoteCount} merge=${phase3Stats.mergeCount}\n`)
      }
    } catch (e) {
      process.stderr.write(`[memory-cycle2] phase3 LLM failed: ${e.message}\n`)
    }
  }

  const finalActive = loadActiveList()
  process.stderr.write(`[memory-cycle2] core_memory final: active=${finalActive.length}\n`)
}

export async function runCycle1(ws, config, options = {}) {
  return enqueueCycleWrite('cycle1', () => runCycle1Impl(ws, config, options))
}

export function parseInterval(s) {
  if (String(s).toLowerCase() === 'immediate') return 0
  const match = String(s).match(/^(\d+)(s|m|h)$/)
  if (!match) return 600000 // default 10m
  const [, num, unit] = match
  const multiplier = { s: 1000, m: 60000, h: 3600000 }
  return Number(num) * multiplier[unit]
}

