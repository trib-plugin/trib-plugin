import { cleanMemoryText } from './memory-extraction.mjs'
import { getIntentSubtypeBonus } from './memory-ranking-utils.mjs'
import { extractKoCompoundTokens, tokenizeMemoryText } from './memory-text-utils.mjs'
import { detectArchitectureQuery, detectOperationalIssueQuery } from './memory-query-cues.mjs'

export function buildCandidateRows(queryText, intentObj, plan, sparse = [], dense = []) {
  const deduped = new Map()
  const queryTokens = new Set(tokenizeMemoryText(queryText))
  for (const token of extractKoCompoundTokens(queryText)) queryTokens.add(token)
  const queryTokenCount = Math.max(1, queryTokens.size)
  const primaryIntent = intentObj?.primary ?? 'decision'
  const exactDate = String(plan?.temporal?.start ?? '')
  const cleanQuery = cleanMemoryText(queryText).toLowerCase()
  const operationalIssueQuery = detectOperationalIssueQuery(queryText)
  const architectureQuery = detectArchitectureQuery(queryText)

  for (const item of [...sparse, ...dense]) {
    const entityId = Number(item?.entity_id ?? 0)
    const key = entityId > 0
      ? `${item?.type ?? 'unknown'}:${entityId}`
      : `${item?.type ?? 'unknown'}:${String(item?.ref ?? item?.content ?? '').slice(0, 120)}`
    if (!deduped.has(key)) deduped.set(key, item)
  }

  const queryKoTokens = extractKoCompoundTokens(queryText)

  return [...deduped.values()]
    .map(item => {
      const contentTokens = tokenizeMemoryText(`${item?.subtype ?? ''} ${item?.content ?? ''}`)
      const overlapCount = contentTokens.reduce((count, token) => count + (queryTokens.has(token) ? 1 : 0), 0)
      const overlapRatio = overlapCount / queryTokenCount
      const denseSig = item?.dense_score != null ? Math.abs(Number(item.dense_score)) : 0
      const sparseSig = item?.sparse_score != null ? Math.min(1, Math.abs(Number(item.sparse_score)) / 10) : 0
      const quality = Number(item?.quality_score ?? item?.confidence ?? 0.5)
      const content = cleanMemoryText(item?.content ?? '').toLowerCase()
      const koSubstringHits = queryKoTokens.length > 0
        ? queryKoTokens.filter(token => content.includes(token)).length
        : 0
      const koSubstringRatio = queryKoTokens.length > 0 ? koSubstringHits / queryKoTokens.length : 0
      const sourceTs = String(item?.source_ts ?? item?.updated_at ?? '')
      const sameDay = Boolean(exactDate) && sourceTs.startsWith(exactDate)
      const directEcho = Boolean(queryText) && content.includes(cleanQuery)

      let partialEchoRatio = 0
      if (!directEcho && cleanQuery.length >= 6) {
        const queryCompact = cleanQuery.replace(/\s+/g, '')
        const contentCompact = content.replace(/\s+/g, '')
        let bestLen = 0
        for (let windowLen = Math.min(queryCompact.length, 20); windowLen >= 5; windowLen -= 1) {
          for (let start = 0; start <= queryCompact.length - windowLen; start += 1) {
            if (contentCompact.includes(queryCompact.slice(start, start + windowLen))) {
              bestLen = windowLen
              break
            }
          }
          if (bestLen > 0) break
        }
        partialEchoRatio = bestLen / queryCompact.length
      }

      const taskStage = String(item?.stage ?? item?.subtype ?? '').toLowerCase()
      const taskStatus = String(item?.status ?? '').toLowerCase()
      let candidateScore = -(
        denseSig * 0.48 +
        overlapRatio * 0.32 +
        koSubstringRatio * 0.12 +
        sparseSig * 0.14 +
        quality * 0.06 +
        partialEchoRatio * 0.10
      )

      candidateScore += getIntentSubtypeBonus(primaryIntent, item)

      if (primaryIntent === 'task') {
        if (item?.type === 'task') {
          if (overlapCount > 0) candidateScore -= 0.18
          if (taskStage === 'implementing' || taskStage === 'wired' || taskStage === 'verified') candidateScore -= 0.08
          if (taskStatus === 'in_progress' || taskStatus === 'active') candidateScore -= 0.06
          if (operationalIssueQuery && /(discord|channel|binding|inbound|delay|message|queue|renderer|hook|session|디스코드|채널|바인딩|인바운드|지연|메세지|메시지|큐잉|렌더러|훅|세션)/.test(content)) {
            candidateScore -= 0.12
          }
        } else if (item?.type === 'episode') {
          candidateScore += 0.18
          if (directEcho) candidateScore += 0.16
        } else if (item?.type === 'fact' && item?.subtype === 'preference') {
          candidateScore += 0.12
        }
      } else if (primaryIntent === 'history' || primaryIntent === 'event') {
        if (item?.type === 'episode') {
          if (sameDay) candidateScore -= 0.24
          else if (overlapCount > 0) candidateScore -= 0.10
          if (directEcho) candidateScore -= 0.18
        } else if (item?.type === 'task' || item?.type === 'fact') {
          candidateScore += 0.08
        }
      } else if (primaryIntent === 'decision') {
        if (item?.type === 'relation') candidateScore -= 0.08
        if (item?.type === 'entity') candidateScore -= 0.06
        if (item?.type === 'fact' && item?.subtype === 'decision') candidateScore -= 0.06
        if (item?.type === 'fact' && item?.subtype === 'preference') candidateScore += 0.12
        if (item?.type === 'episode') candidateScore += 0.14
        if (architectureQuery) {
          if ((item?.type === 'entity' || item?.type === 'relation') && /(rag|memory|retrieval|injection|mcp|search|structure|storage|메모리|검색|주입|구조|저장)/.test(content)) {
            candidateScore -= 0.12
          }
          if (item?.type === 'task' && /(rag|memory|retrieval|injection|mcp|search|structure|storage|메모리|검색|주입|구조|저장)/.test(content)) {
            candidateScore -= 0.08
          }
          if (item?.type === 'fact' && (item?.subtype === 'decision' || item?.subtype === 'constraint')) {
            candidateScore -= 0.04
          }
          if (item?.type === 'episode' && directEcho) {
            candidateScore += 0.10
          }
        }
      } else if (primaryIntent === 'policy' || primaryIntent === 'security') {
        if (item?.type === 'fact' && item?.subtype === 'constraint') candidateScore -= 0.10
        if (item?.type === 'proposition') candidateScore -= 0.04
        if (item?.type === 'episode') candidateScore += 0.12
      }

      return {
        ...item,
        overlapCount,
        candidate_score: candidateScore,
      }
    })
    .sort((left, right) => Number(left.candidate_score) - Number(right.candidate_score))
}
