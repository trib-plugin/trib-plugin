/**
 * memory-score-utils.mjs — Scoring helpers for retrieval pipeline
 */

export function getScoringConfig(tuning = {}) {
  return tuning?.scoring ?? {}
}

// ── Importance tag factors (MEMORY-DECAY-PLAN.md) ───────────────────

const TAG_FACTORS = {
  rule: 0.0,
  goal: 0.025,
  directive: 0.05,
  preference: 0.075,
  decision: 0.1,
  incident: 0.125,
}

export function getTagFactor(importance) {
  if (!importance) return 1.0
  const tags = String(importance).split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
  if (tags.length === 0) return 1.0
  const factors = tags.map(t => TAG_FACTORS[t] ?? 1.0)
  return Math.min(...factors)
}

// ── Importance boost (search time) ──────────────────────────────────

export function computeImportanceBoost(importance) {
  const factor = getTagFactor(importance)
  return 1 + (1 - factor) * 0.5
}

// ── Exact match bonus ───────────────────────────────────────────────

export function computeExactMatchBonus(content, query, baseScore) {
  if (!content || !query) return 0
  const cleanQuery = String(query).toLowerCase().replace(/\s+/g, ' ').trim()
  const cleanContent = String(content).toLowerCase().replace(/\s+/g, ' ').trim()
  if (cleanQuery.length >= 4 && cleanContent.includes(cleanQuery)) {
    return baseScore * 0.2
  }
  return 0
}

// ── Combined final score ─────────────────────────────────────────────

export function computeFinalScore(baseScore, item, query, _options = {}) {
  const importanceBoost = computeImportanceBoost(item.importance)
  const exactBonus = computeExactMatchBonus(item.content, query, baseScore)

  // Time decay modulated by importance
  let timeFactor = 1.0
  if (item.ts) {
    const ageDays = Math.max(0, (Date.now() - new Date(item.ts).getTime()) / 86400000)
    const decay = 1 / Math.pow(1 + ageDays / 30, 0.3)
    const tagFactor = getTagFactor(item.importance)
    const actualLoss = (1 - decay) * tagFactor
    timeFactor = 1 - actualLoss
  }

  return (baseScore + exactBonus) * importanceBoost * timeFactor
}
