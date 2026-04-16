import { buildFtsQuery } from './memory-text-utils.mjs'
import { vecToHex } from './memory-vector-utils.mjs'
import { computeEntryScore } from './memory-score.mjs'

export async function searchRelevantHybrid(db, query, options = {}) {
  const clean = String(query ?? '').trim()
  if (!clean) return []

  const limit = Math.max(1, Number(options.limit ?? 8))
  const includeMembers = Boolean(options.includeMembers)
  const writeBackMemberHits = options.writeBackMemberHits !== false

  const candidateIds = new Map()
  let denseCount = 0
  let sparseCount = 0

  if (Array.isArray(options.queryVector) && options.queryVector.length > 0) {
    try {
      const hex = vecToHex(options.queryVector)
      const knnRows = db.prepare(
        `SELECT rowid, distance FROM vec_entries WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT ?`,
      ).all(limit * 3)
      knnRows.forEach((row, rank) => {
        const id = Number(row.rowid)
        if (!Number.isFinite(id)) return
        if (!candidateIds.has(id)) candidateIds.set(id, { denseRank: null, sparseRank: null })
        candidateIds.get(id).denseRank = rank + 1
      })
      denseCount = knnRows.length
    } catch { /* vec_entries may be empty */ }
  }

  if (clean.length >= 3) {
    try {
      const ftsRows = db.prepare(
        `SELECT rowid, bm25(entries_fts) AS bm25
         FROM entries_fts
         WHERE entries_fts MATCH ?
         ORDER BY bm25 LIMIT ?`,
      ).all(buildFtsQuery(clean), limit * 3)
      ftsRows.forEach((row, rank) => {
        const id = Number(row.rowid)
        if (!Number.isFinite(id)) return
        if (!candidateIds.has(id)) candidateIds.set(id, { denseRank: null, sparseRank: null })
        candidateIds.get(id).sparseRank = rank + 1
      })
      sparseCount = ftsRows.length
    } catch { /* fts unavailable */ }
  } else {
    try {
      const likePattern = `%${clean}%`
      const likeRows = db.prepare(
        `SELECT id FROM entries
         WHERE content LIKE ? OR summary LIKE ? OR element LIKE ?
         ORDER BY ts DESC LIMIT ?`,
      ).all(likePattern, likePattern, likePattern, limit * 3)
      likeRows.forEach((row, rank) => {
        const id = Number(row.id)
        if (!Number.isFinite(id)) return
        if (!candidateIds.has(id)) candidateIds.set(id, { denseRank: null, sparseRank: null })
        candidateIds.get(id).sparseRank = rank + 1
      })
      sparseCount = likeRows.length
    } catch { /* ignore */ }
  }

  if (candidateIds.size === 0) return []

  const K = 60
  const scored = []
  for (const [id, ranks] of candidateIds) {
    const rrf = (ranks.denseRank ? 1 / (K + ranks.denseRank) : 0)
              + (ranks.sparseRank ? 1 / (K + ranks.sparseRank) : 0)
    scored.push({ id, rrf })
  }
  scored.sort((a, b) => b.rrf - a.rrf)

  const topIds = scored.map(s => s.id)
  const placeholders = topIds.map(() => '?').join(',')
  const rawRows = db.prepare(
    `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
            element, category, summary, status, score, last_seen_at
     FROM entries WHERE id IN (${placeholders})`,
  ).all(...topIds)
  const byId = new Map(rawRows.map(r => [Number(r.id), r]))

  const nowMs = Date.now()
  const memberHitRootIds = new Set()
  const rootIdsForReturn = []
  const seen = new Set()

  for (const { id, rrf } of scored) {
    const row = byId.get(id)
    if (!row) continue
    let targetRow = null
    if (row.is_root === 1) {
      targetRow = row
    } else if (row.chunk_root != null && row.chunk_root !== row.id) {
      const r = db.prepare(
        `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
                element, category, summary, status, score, last_seen_at
         FROM entries WHERE id = ? AND is_root = 1`,
      ).get(row.chunk_root)
      if (!r) continue
      memberHitRootIds.add(r.id)
      targetRow = r
    } else {
      targetRow = row
    }
    if (seen.has(targetRow.id)) continue
    seen.add(targetRow.id)
    rootIdsForReturn.push({ root: targetRow, rrf })
    if (rootIdsForReturn.length >= limit) break
  }

  let writeBackCount = 0
  if (writeBackMemberHits && memberHitRootIds.size > 0) {
    const updateRoot = db.prepare(
      `UPDATE entries SET last_seen_at = ?, score = ? WHERE id = ? AND is_root = 1`,
    )
    for (const rootId of memberHitRootIds) {
      const r = rootIdsForReturn.find(x => x.root.id === rootId)?.root ?? byId.get(rootId)
      if (!r) continue
      const newScore = computeEntryScore(r.category, nowMs, nowMs)
      try {
        updateRoot.run(nowMs, newScore, rootId)
        writeBackCount += 1
      } catch (err) {
        process.stderr.write(`[recall] writeback failed (root=${rootId}): ${err.message}\n`)
      }
    }
  }

  const results = rootIdsForReturn.map(({ root, rrf }) => {
    const out = { ...root, rrf }
    if (includeMembers && root.is_root === 1) {
      out.members = db.prepare(
        `SELECT id, ts, role, content, session_id, source_turn
         FROM entries WHERE chunk_root = ? AND is_root = 0
         ORDER BY ts ASC, id ASC`,
      ).all(root.id)
    }
    return out
  })

  process.stderr.write(
    `[recall] dense=${denseCount} sparse=${sparseCount} merged=${results.length} write_back=${writeBackCount}\n`,
  )

  return results
}
