import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { embedText, getEmbeddingModelId } from './embedding-provider.mjs'
import { cleanMemoryText } from './memory-extraction.mjs'
import { buildHintKey, formatHintTag } from './memory-context-utils.mjs'
import { readMemoryFeatureFlags } from './memory-ops-policy.mjs'
import { parseTemporalHint } from './ko-date-parser.mjs'
import { looksLowSignalQuery, tokenizeMemoryText } from './memory-text-utils.mjs'
import { cosineSimilarity } from './memory-vector-utils.mjs'

function nextDateStr(value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(date.getTime())) return ''
  date.setDate(date.getDate() + 1)
  return date.toISOString().slice(0, 10)
}

function readContextBuilderConfig(store) {
  try {
    return JSON.parse(fs.readFileSync(path.join(store.dataDir, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

export async function buildInboundMemoryContext(store, query, options = {}) {
  const clean = cleanMemoryText(query)
  if (!clean) return ''
  if (!options.skipLowSignal && looksLowSignalQuery(clean)) return ''

  const totalStartedAt = Date.now()
  const stageTimings = []
  const tuning = store.getRetrievalTuning()
  const measureStage = async (label, work) => {
    const startedAt = Date.now()
    try {
      return await work()
    } finally {
      stageTimings.push(`${label}=${Date.now() - startedAt}ms`)
    }
  }

  const limit = Number(options.limit ?? 3)
  const lines = []
  const seenHintKeys = new Set()
  const queryTokenCount = Math.max(1, tokenizeMemoryText(clean).length)
  const featureFlags = readMemoryFeatureFlags(readContextBuilderConfig(store))
  const queryVector = await measureStage('embed_query', () => embedText(clean))
  const pushHint = (item, overrides = {}) => {
    const rawText = String(overrides.text ?? item.content ?? item.text ?? item.value ?? '').trim()
    if (!rawText) return
    // weighted_score >= 0.012 threshold (low-quality hints filtered)
    if (item.weighted_score == null || item.weighted_score < 0.012) return
    const key = buildHintKey(item, overrides)
    if (!key) return
    if (seenHintKeys.has(key)) return
    seenHintKeys.add(key)
    lines.push(formatHintTag(item, overrides, { queryTokenCount, nowTs: totalStartedAt }))
  }

  let relevant = await measureStage('hybrid_search', () => store.searchRelevantHybrid(clean, limit, {
    queryVector,
    channelId: options.channelId,
    userId: options.userId,
    recordRetrieval: false,
    tuning,
  }))
  relevant = relevant
    .filter(item => {
      if (item.type !== 'classification' && item.type !== 'episode' && item.type !== 'chunk') return false
      // Filter out short noisy episodes (ㅎㅇ, ㅇㅇ, ㄱㄱ etc.)
      if (item.type === 'episode') {
        const text = String(item.content || '').replace(/\s+/g, '')
        if (text.length < 5) return false
      }
      return true
    })

  // Deduplicate: if a chunk covers the same episode, drop the raw episode
  const chunkEpisodeIds = new Set(
    relevant.filter(r => r.type === 'chunk' && r.chunk_episode_id).map(r => Number(r.chunk_episode_id))
  )
  if (chunkEpisodeIds.size > 0) {
    relevant = relevant.filter(item =>
      item.type !== 'episode' || !chunkEpisodeIds.has(Number(item.entity_id))
    )
  }

  // Session exclusion: filter out episodes from the current session
  const serverStartedAt = options.serverStartedAt
  if (serverStartedAt) {
    relevant = relevant.filter(item => {
      if (item.type !== 'episode') return true
      const ts = item.source_ts || item.updated_at
      if (!ts) return true
      return ts < serverStartedAt
    })
  }

  // Type priority: chunk > classification > episode
  const typePriority = { chunk: 0, classification: 1, episode: 2 }
  relevant.sort((a, b) => {
    const pa = typePriority[a.type] ?? 2
    const pb = typePriority[b.type] ?? 2
    if (pa !== pb) return pa - pb
    return (b.weighted_score || 0) - (a.weighted_score || 0)
  })

  relevant = relevant.slice(0, Math.max(3, limit))

  if (relevant.length > 0) {
    for (const item of relevant) {
      pushHint(item)
    }
  } else {
    const fallbackClassifications = store.getClassificationRows(4).map(item => ({
      type: 'classification',
      subtype: item.classification,
      content: [item.classification, item.topic, item.element, item.state].filter(Boolean).join(' | '),
      confidence: item.confidence,
      updated_at: item.updated_at,
      entity_id: item.id,
    }))
    for (const item of fallbackClassifications) {
      pushHint(item, { type: 'classification' })
    }
  }

  if (lines.length > 0) {
    try {
      let recentTopics = []
      if (options.channelId) {
        recentTopics = store.db.prepare(`
          SELECT content FROM episodes
          WHERE role = 'user'
            AND kind = 'message'
            AND channel_id = ?
            AND content NOT LIKE 'You are consolidating%'
            AND content NOT LIKE 'You are improving%'
            AND LENGTH(content) BETWEEN 10 AND 200
            AND ts >= datetime('now', '-1 day')
          ORDER BY ts DESC
          LIMIT 3
        `).all(String(options.channelId))
      }
      if (recentTopics.length === 0 && options.userId) {
        recentTopics = store.db.prepare(`
          SELECT content FROM episodes
          WHERE role = 'user'
            AND kind = 'message'
            AND user_id = ?
            AND content NOT LIKE 'You are consolidating%'
            AND content NOT LIKE 'You are improving%'
            AND LENGTH(content) BETWEEN 10 AND 200
            AND ts >= datetime('now', '-1 day')
          ORDER BY ts DESC
          LIMIT 3
        `).all(String(options.userId))
      }
      if (recentTopics.length > 0) {
        lines.push('<recent>' + recentTopics.map(r => cleanMemoryText(r.content).slice(0, 40)).join(' / ') + '</recent>')
      }
    } catch {}
  }

  // Temporal-based episode injection: temporal keywords get recent episodes
  const temporal = parseTemporalHint(clean)
  if (lines.length === 0 && temporal) {
    try {
      const startDate = temporal.start
      const endDate = nextDateStr(temporal.end ?? temporal.start)

      // Fallback: history=3 days, event=7 days
      const fallbackDays = '-3 days'
      let recentEpisodes
      if (startDate) {
        recentEpisodes = store.db.prepare(`
          SELECT ts, role, content FROM episodes
          WHERE kind IN ('message', 'turn')
            AND content NOT LIKE 'You are consolidating%'
            AND content NOT LIKE 'You are improving%'
            AND LENGTH(content) BETWEEN 10 AND 500
            AND ts >= ? AND ts < ?
          ORDER BY ts DESC
          LIMIT 5
        `).all(startDate, endDate)
      } else {
        recentEpisodes = store.db.prepare(`
          SELECT ts, role, content FROM episodes
          WHERE kind IN ('message', 'turn')
            AND content NOT LIKE 'You are consolidating%'
            AND content NOT LIKE 'You are improving%'
            AND LENGTH(content) BETWEEN 10 AND 500
            AND ts >= datetime('now', ?)
          ORDER BY ts DESC
          LIMIT 5
        `).all(fallbackDays)
      }
      for (const ep of recentEpisodes) {
        const prefix = ep.role === 'user' ? 'u' : 'a'
        const text = cleanMemoryText(ep.content).slice(0, 150)
        lines.push(`<hint type="episode" age="${ep.ts}">[${prefix}] ${text}</hint>`)
      }
    } catch {}
  }

  // Passive mention tracking: update retrieval_count for semantically similar classifications
  if (Array.isArray(queryVector) && queryVector.length > 0) {
    try {
      const activeModel = getEmbeddingModelId()
      const classVectors = store.db.prepare(`
        SELECT mv.entity_id, mv.vector_json
        FROM memory_vectors mv
        JOIN classifications c ON c.id = mv.entity_id
        WHERE mv.entity_type = 'classification'
          AND mv.model = ?
          AND c.status = 'active'
      `).all(activeModel)
      const nowTs = Math.floor(Date.now() / 1000)
      const mentionedIds = []
      for (const row of classVectors) {
        try {
          const vec = JSON.parse(row.vector_json)
          if (!Array.isArray(vec) || vec.length === 0) continue
          const sim = cosineSimilarity(queryVector, vec)
          if (sim >= 0.4) mentionedIds.push(row.entity_id)
        } catch {}
      }
      if (mentionedIds.length > 0) {
        const placeholders = mentionedIds.map(() => '?').join(',')
        store.db.prepare(`
          UPDATE classifications
          SET retrieval_count = COALESCE(retrieval_count, 0) + 1,
              last_retrieved_at = ?
          WHERE id IN (${placeholders})
        `).run(nowTs, ...mentionedIds)
      }
    } catch {}
  }

  const validLines = lines.filter(l => l && l.trim())
  if (validLines.length === 0) return ''
  const ctx = `<memory-context>\n${validLines.join('\n')}\n</memory-context>`
  const totalMs = Date.now() - totalStartedAt
  process.stderr.write(
    `[memory-timing] q="${clean.slice(0, 40)}" total=${totalMs}ms ${stageTimings.join(' ')}\n`,
  )
  process.stderr.write(`[memory] recall q="${clean.slice(0, 40)}" hints=${lines.filter(l => l.startsWith('<hint ')).length}\n`)
  return ctx
}
