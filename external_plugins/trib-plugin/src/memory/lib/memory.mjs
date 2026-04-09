import { DatabaseSync } from 'node:sqlite'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import { embedText, getEmbeddingModelId, getEmbeddingDims, warmupEmbeddingProvider, configureEmbedding, consumeProviderSwitchEvent } from './embedding-provider.mjs'
import { cleanMemoryText } from './memory-extraction.mjs'
import {
  buildFtsQuery,
  firstTextContent,
  generateQueryVariants,
  getShortTokensForLike,
  insertCandidateUnits,
  looksLowSignal,
  shortTokenMatchScore,
  tokenizeMemoryText,
  localNow,
  localDateStr,
  toLocalTs,
} from './memory-text-utils.mjs'
import {
  parseTemporalHint,
} from './ko-date-parser.mjs'
import { rerank as jsRerank, getRerankerModelId, getRerankerDevice } from './reranker.mjs'
import {
  applyMetadataFilters as applyMetadataFiltersImpl,
  getEpisodeRecallRows as getEpisodeRecallRowsImpl,
  getRecallShortcutRows as getRecallShortcutRowsImpl,
} from './memory-recall-store.mjs'
import {
  countEpisodes as countEpisodesImpl,
  countPendingCandidates as countPendingCandidatesImpl,
  getCandidatesForDate as getCandidatesForDateImpl,
  getDecayRows as getDecayRowsImpl,
  getEpisodesSince as getEpisodesSinceImpl,
  getPendingCandidateDays as getPendingCandidateDaysImpl,
  getRecentCandidateDays as getRecentCandidateDaysImpl,
  markCandidateIdsConsolidated as markCandidateIdsConsolidatedImpl,
  markCandidatesConsolidated as markCandidatesConsolidatedImpl,
  pruneConsolidatedMemoryOutsideDays as pruneConsolidatedMemoryOutsideDaysImpl,
  rebuildCandidates as rebuildCandidatesImpl,
  resetConsolidatedMemory as resetConsolidatedMemoryImpl,
  resetConsolidatedMemoryForDays as resetConsolidatedMemoryForDaysImpl,
  resetEmbeddingIndex as resetEmbeddingIndexImpl,
  vacuumDatabase as vacuumDatabaseImpl,
} from './memory-maintenance-store.mjs'
import { mergeMemoryTuning } from './memory-tuning.mjs'
import { getTagFactor } from './memory-score-utils.mjs'
import { readMemoryFeatureFlags } from './memory-ops-policy.mjs'
// memory-score-utils imports removed — scoring consolidated into 3-stage pipeline
import {
  averageVectors,
  contextualizeEmbeddingInput,
  cosineSimilarity,
  embeddingItemKey,
  hashEmbeddingInput,
  vecToHex,
} from './memory-vector-utils.mjs'
let sqliteVec = null
try { sqliteVec = await import('sqlite-vec') } catch (e) { process.stderr.write(`[memory] sqlite-vec not available — dense search will use slow JS cosine fallback: ${e.message}\n`) }

const stores = new Map()

function applyMMR(results, lambda = 0.7) {
  if (results.length <= 1) return results
  const selected = [results[0]]
  const remaining = results.slice(1)

  while (selected.length < results.length && remaining.length > 0) {
    let bestIdx = -1
    let bestScore = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      // Max similarity to already selected items (using content overlap as proxy)
      const maxSim = Math.max(...selected.map(s => {
        const a = String(s.content || '').toLowerCase()
        const b = String(candidate.content || '').toLowerCase()
        if (!a || !b) return 0
        // Simple Jaccard-like overlap on words
        const wordsA = new Set(a.split(/\s+/))
        const wordsB = new Set(b.split(/\s+/))
        const intersection = [...wordsA].filter(w => wordsB.has(w)).length
        const union = new Set([...wordsA, ...wordsB]).size
        return union > 0 ? intersection / union : 0
      }))

      const mmrScore = lambda * (candidate.weighted_score || 0) - (1 - lambda) * maxSim
      if (mmrScore > bestScore) {
        bestScore = mmrScore
        bestIdx = i
      }
    }

    if (bestIdx >= 0) {
      selected.push(remaining.splice(bestIdx, 1)[0])
    } else {
      break
    }
  }
  return selected
}

function logIgnoredError(scope, error) {
  if (!error) return
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[memory] ${scope}: ${message}\n`)
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true })
}

function workspaceToProjectSlug(workspacePath) {
  return resolve(workspacePath)
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, '$1-')
    .replace(/\//g, '-')
}

export { cleanMemoryText }

const RECALL_EPISODE_KIND_SQL = `'message', 'turn'`
const DEBUG_RECALL_EPISODE_KIND_SQL = `'message', 'turn', 'transcript'`

function isTranscriptQuarantineContent(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return true
  if (clean.length >= 10000) return true
  if (clean.length > 2000 && /(?:^|\n)[ua]:\s/.test(clean)) return true
  if (/^you are summarizing a day's conversation\b/i.test(clean)) return true
  if (/^you are compressing summaries\b/i.test(clean)) return true
  if (/below is the cleaned conversation log/i.test(clean)) return true
  if (/output only the summary/i.test(clean) && /what tasks were worked on/i.test(clean)) return true
  if (/summarize in ~?\d+ lines/i.test(clean) && /date:\s*\d{4}-\d{2}-\d{2}/i.test(clean)) return true
  if (/^you are (analyzing|consolidating|improving|summarizing)\b/i.test(clean)) return true
  if (/^summarize the conversation\b/i.test(clean)) return true
  if (/history directory:/i.test(clean) && /read existing files/i.test(clean)) return true
  if (/return this exact shape:/i.test(clean)) return true
  if (/output json only/i.test(clean) && /(memory system|trib-memory)/i.test(clean)) return true
  return false
}


export class MemoryStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.historyDir = join(dataDir, 'history')
    this.dbPath = join(dataDir, 'memory.sqlite')
    ensureDir(dirname(this.dbPath))
    this.db = new DatabaseSync(this.dbPath, { allowExtension: true })
    this.vecEnabled = false
    this.readDb = null
    this._transcriptOffsets = new Map()
    this._loadVecExtension()
    this._openReadDb()
    this.init()
    this.syncEmbeddingMetadata()
  }

  _loadVecExtension() {
    if (!sqliteVec) return
    try {
      sqliteVec.load(this.db)
      this.vecEnabled = true
      let dims = getEmbeddingDims()
      try {
        const forcedDims = Number(process.env.CLAUDE2BOT_FORCE_VEC_DIMS ?? '0')
        if (forcedDims > 0) {
          dims = forcedDims
        } else {
          const hasMeta = this.db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='memory_meta'`).get()?.ok
          if (hasMeta) {
            const storedDims = Number(this.db.prepare(`SELECT value FROM memory_meta WHERE key = 'embedding.vector_dims'`).get()?.value ?? '0')
            if (storedDims > 0) dims = storedDims
          }
        }
      } catch { /* ignore metadata lookup */ }
      // Check if vec_memory exists with different dimensions
      try {
        const existing = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_memory'`).get()
        if (existing?.sql && !existing.sql.includes(`float[${dims}]`)) {
          this.db.exec('DROP TABLE vec_memory')
          process.stderr.write(`[memory] vec_memory dimension changed, recreating with float[${dims}]\n`)
        }
      } catch {}
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[${dims}])`)
    } catch (e) {
      process.stderr.write(`[memory] sqlite-vec load failed: ${e.message}\n`)
    }
  }

  _openReadDb() {
    try {
      const rdb = new DatabaseSync(this.dbPath, { readOnly: true, allowExtension: true })
      if (sqliteVec) sqliteVec.load(rdb)
      rdb.exec(`PRAGMA busy_timeout = 1000;`)
      this.readDb = rdb
    } catch (e) {
      process.stderr.write(`[memory] readDb open failed, falling back to main db: ${e.message}\n`)
      this.readDb = null
    }
  }

  get vecReadDb() {
    return this.readDb ?? this.db
  }

  close() {
    try { this.readDb?.close() } catch {}
    this.readDb = null
    try { this.db?.close() } catch {}
  }

  async switchEmbeddingModel(config = {}) {
    const oldModel = getEmbeddingModelId()
    configureEmbedding(config)
    await warmupEmbeddingProvider()
    const newModel = getEmbeddingModelId()
    if (oldModel === newModel) return { changed: false }

    process.stderr.write(`[memory] switching embedding model: ${oldModel} → ${newModel}\n`)
    const reset = this.resetDerivedMemoryForEmbeddingChange({ newModel })
    process.stderr.write(
      `[memory] embedding model changed; cleared derived memory and rebuilt ${reset.rebuiltCandidates} candidates for ${newModel}\n`,
    )
    return { changed: true, oldModel, newModel, reset }
  }

  resetDerivedMemoryForEmbeddingChange(options = {}) {
    const preservedEpisodes = Number(this.countEpisodes() ?? 0)
    this.db.exec(`
      DELETE FROM memory_candidates;
      DELETE FROM classifications;
      DELETE FROM classifications_fts;
      DELETE FROM documents;
      DELETE FROM memory_vectors;
      DELETE FROM pending_embeds;
      DELETE FROM memory_meta;
    `)

    if (this.vecEnabled) {
      try {
        this.db.exec('DROP TABLE IF EXISTS vec_memory')
        const dims = getEmbeddingDims()
        this.db.exec(`CREATE VIRTUAL TABLE vec_memory USING vec0(embedding float[${dims}])`)
        try { this.readDb?.close() } catch {}
        this.readDb = null
        this._openReadDb()
      } catch {}
    }

    this.clearHistoryOutputs()
    const rebuiltCandidates = this.rebuildCandidates()
    this.writeContextFile()
    this.syncEmbeddingMetadata({ reason: 'switch_embedding_model' })

    return {
      preservedEpisodes,
      rebuiltCandidates,
      historyCleared: true,
      targetModel: options.newModel ?? getEmbeddingModelId(),
    }
  }

  clearHistoryOutputs() {
    ensureDir(this.historyDir)
    const directFiles = ['context.md', 'identity.md', 'ongoing.md', 'lifetime.md', 'interests.json']
    for (const name of directFiles) {
      try { rmSync(join(this.historyDir, name), { force: true }) } catch {}
    }
    for (const dir of ['daily', 'weekly', 'monthly', 'yearly']) {
      try { rmSync(join(this.historyDir, dir), { recursive: true, force: true }) } catch {}
    }
  }

  init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
    `)

    // Migrate FTS tables from unicode61 to trigram for Korean support
    const ftsToMigrate = ['episodes_fts', 'facts_fts', 'tasks_fts', 'signals_fts']
    for (const table of ftsToMigrate) {
      try {
        const info = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table)
        if (info?.sql && !info.sql.includes('trigram')) {
          this.db.exec(`DROP TABLE IF EXISTS ${table}`)
        }
      } catch { /* table may not exist yet */ }
    }

    this.db.exec(`

      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        day_key TEXT NOT NULL,
        backend TEXT NOT NULL DEFAULT 'trib-memory',
        channel_id TEXT,
        user_id TEXT,
        user_name TEXT,
        session_id TEXT,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source_ref TEXT UNIQUE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      DROP INDEX IF EXISTS idx_episodes_source_ref;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_source_ref ON episodes(source_ref);
      CREATE INDEX IF NOT EXISTS idx_episodes_day ON episodes(day_key, ts);
      CREATE INDEX IF NOT EXISTS idx_episodes_role ON episodes(role, ts);

      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts
        USING fts5(content, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS memory_candidates (
        id INTEGER PRIMARY KEY,
        episode_id INTEGER NOT NULL,
        ts TEXT NOT NULL,
        day_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_day ON memory_candidates(day_key, status, score DESC);

      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        doc_key TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(kind, doc_key)
      );

      CREATE TABLE IF NOT EXISTS classifications (
        id INTEGER PRIMARY KEY,
        episode_id INTEGER NOT NULL UNIQUE,
        ts TEXT NOT NULL,
        day_key TEXT NOT NULL,
        classification TEXT NOT NULL,
        topic TEXT NOT NULL,
        element TEXT NOT NULL,
        state TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active',
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        last_retrieved_at TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_classifications_day ON classifications(day_key, status, updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS classifications_fts
        USING fts5(classification, topic, element, state, tokenize='trigram');
    `)

    // importance column migration
    try {
      this.db.exec(`ALTER TABLE classifications ADD COLUMN importance TEXT DEFAULT ''`)
    } catch { /* already exists */ }

    // chunks column migration (semantic chunks from cycle1 LLM)
    try {
      this.db.exec(`ALTER TABLE classifications ADD COLUMN chunks TEXT DEFAULT '[]'`)
    } catch { /* already exists */ }

    this.db.exec(`

      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_embeds (
        id INTEGER PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(entity_type, entity_id)
      );

      CREATE TABLE IF NOT EXISTS memory_vectors (
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        content_hash TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY(entity_type, entity_id, model)
      );

      CREATE TABLE IF NOT EXISTS memory_chunks (
        id INTEGER PRIMARY KEY,
        episode_id INTEGER NOT NULL,
        classification_id INTEGER,
        content TEXT NOT NULL,
        topic TEXT,
        importance TEXT,
        seq INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_episode ON memory_chunks(episode_id, status);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts
        USING fts5(content, topic, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS core_memory (
        id INTEGER PRIMARY KEY,
        classification_id INTEGER NOT NULL UNIQUE,
        chunk_id INTEGER,
        topic TEXT NOT NULL,
        element TEXT NOT NULL,
        importance TEXT,
        final_score REAL NOT NULL DEFAULT 0,
        promoted_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        mention_count INTEGER NOT NULL DEFAULT 0,
        last_mentioned_at TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'pending', 'demoted', 'processed', 'archived')),
        FOREIGN KEY(classification_id) REFERENCES classifications(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_core_memory_status ON core_memory(status, final_score DESC);
      CREATE INDEX IF NOT EXISTS idx_core_memory_cls ON core_memory(classification_id);

      CREATE TABLE IF NOT EXISTS proactive_sources (
        id INTEGER PRIMARY KEY,
        category TEXT NOT NULL,
        topic TEXT NOT NULL,
        query TEXT,
        score REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'dormant', 'removed')),
        pinned INTEGER NOT NULL DEFAULT 0,
        last_used TEXT,
        hit_count INTEGER NOT NULL DEFAULT 0,
        skip_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_proactive_status ON proactive_sources(status, score DESC);

      CREATE TABLE IF NOT EXISTS classification_stats (
        classification_id INTEGER NOT NULL UNIQUE,
        mention_count INTEGER NOT NULL DEFAULT 0,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        last_seen TEXT,
        FOREIGN KEY(classification_id) REFERENCES classifications(id) ON DELETE CASCADE
      );
    `)

    try {
      this.db.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TABLE IF EXISTS task_events;
        DROP TABLE IF EXISTS interests;
        DROP TABLE IF EXISTS entity_links;
        DROP TABLE IF EXISTS relations;
        DROP TABLE IF EXISTS entities;
        DROP TABLE IF EXISTS propositions_fts;
        DROP TABLE IF EXISTS signals_fts;
        DROP TABLE IF EXISTS tasks_fts;
        DROP TABLE IF EXISTS facts_fts;
        DROP TABLE IF EXISTS propositions;
        DROP TABLE IF EXISTS signals;
        DROP TABLE IF EXISTS tasks;
        DROP TABLE IF EXISTS facts;
        DROP TABLE IF EXISTS profiles;
        PRAGMA foreign_keys = ON;
      `)
      this.db.prepare(`
        DELETE FROM memory_vectors
        WHERE entity_type NOT IN ('classification', 'episode')
      `).run()
      this.db.prepare(`
        DELETE FROM pending_embeds
        WHERE entity_type NOT IN ('classification', 'episode')
      `).run()
    } catch (error) {
      logIgnoredError('legacy schema cleanup', error)
    }

    try {
      this.db.exec(`ALTER TABLE memory_vectors ADD COLUMN content_hash TEXT;`)
    } catch { /* already present */ }

    // core_memory schema migration: add chunk_id, mention_count, last_mentioned_at, expand status
    try { this.db.exec(`ALTER TABLE core_memory ADD COLUMN chunk_id INTEGER`) } catch { /* already exists */ }
    try { this.db.exec(`ALTER TABLE core_memory ADD COLUMN mention_count INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
    try { this.db.exec(`ALTER TABLE core_memory ADD COLUMN last_mentioned_at TEXT`) } catch { /* already exists */ }
    // Migrate status CHECK constraint: recreate if 'pending'/'processed' not allowed
    try {
      // Test insert with 'pending' status — if CHECK fails, we need to migrate
      this.db.exec(`INSERT INTO core_memory (classification_id, topic, element, promoted_at, last_seen_at, status) VALUES (-999, '__test__', '__test__', '', '', 'archived')`)
      this.db.exec(`DELETE FROM core_memory WHERE classification_id = -999`)
    } catch {
      // Old CHECK missing archived — rebuild table with expanded CHECK
      try {
        this.db.exec(`
          PRAGMA foreign_keys = OFF;
          CREATE TABLE IF NOT EXISTS core_memory_new (
            id INTEGER PRIMARY KEY,
            classification_id INTEGER NOT NULL UNIQUE,
            chunk_id INTEGER,
            topic TEXT NOT NULL,
            element TEXT NOT NULL,
            importance TEXT,
            final_score REAL NOT NULL DEFAULT 0,
            promoted_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            mention_count INTEGER NOT NULL DEFAULT 0,
            last_mentioned_at TEXT,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'pending', 'demoted', 'processed', 'archived')),
            FOREIGN KEY(classification_id) REFERENCES classifications(id) ON DELETE CASCADE
          );
          INSERT INTO core_memory_new (id, classification_id, chunk_id, topic, element, importance, final_score, promoted_at, last_seen_at, mention_count, last_mentioned_at, status)
            SELECT id, classification_id, chunk_id, topic, element, importance, final_score, promoted_at, last_seen_at, mention_count, last_mentioned_at, status FROM core_memory;
          DROP TABLE core_memory;
          ALTER TABLE core_memory_new RENAME TO core_memory;
          CREATE INDEX IF NOT EXISTS idx_core_memory_status ON core_memory(status, final_score DESC);
          CREATE INDEX IF NOT EXISTS idx_core_memory_cls ON core_memory(classification_id);
          PRAGMA foreign_keys = ON;
        `)
      } catch (e) { logIgnoredError('core_memory CHECK migration', e) }
    }

    this.insertEpisodeStmt = this.db.prepare(`
      INSERT OR IGNORE INTO episodes (
        ts, day_key, backend, channel_id, user_id, user_name, session_id,
        role, kind, content, source_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.insertEpisodeFtsStmt = this.db.prepare(`
      INSERT INTO episodes_fts(rowid, content) VALUES (?, ?)
    `)
    this.getEpisodeBySourceStmt = this.db.prepare(`
      SELECT id FROM episodes WHERE source_ref = ?
    `)
    this.insertCandidateStmt = this.db.prepare(`
      INSERT INTO memory_candidates (episode_id, ts, day_key, role, content, score)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.upsertClassificationStmt = this.db.prepare(`
      INSERT INTO classifications (episode_id, ts, day_key, classification, topic, element, state, importance, chunks, confidence, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', unixepoch())
      ON CONFLICT(episode_id) DO UPDATE SET
        ts = excluded.ts,
        day_key = excluded.day_key,
        classification = excluded.classification,
        topic = excluded.topic,
        element = excluded.element,
        state = excluded.state,
        importance = excluded.importance,
        chunks = excluded.chunks,
        confidence = MAX(classifications.confidence, excluded.confidence),
        status = 'active',
        updated_at = unixepoch()
    `)
    this.getClassificationByEpisodeStmt = this.db.prepare(`
      SELECT id
      FROM classifications
      WHERE episode_id = ?
    `)
    this.deleteClassificationFtsStmt = this.db.prepare(`DELETE FROM classifications_fts WHERE rowid = ?`)
    this.insertClassificationFtsStmt = this.db.prepare(`
      INSERT INTO classifications_fts(rowid, classification, topic, element, state)
      VALUES (?, ?, ?, ?, ?)
    `)
    this.bumpClassificationRetrievalStmt = this.db.prepare(`
      UPDATE classifications
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `)
    this.clearCandidatesStmt = this.db.prepare(`DELETE FROM memory_candidates`)
    this.clearClassificationsStmt = this.db.prepare(`DELETE FROM classifications`)
    this.clearClassificationsFtsStmt = this.db.prepare(`DELETE FROM classifications_fts`)
    this.clearVectorsStmt = this.db.prepare(`DELETE FROM memory_vectors`)
    this.getMetaStmt = this.db.prepare(`SELECT value FROM memory_meta WHERE key = ?`)
    this.upsertMetaStmt = this.db.prepare(`
      INSERT INTO memory_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    this.hasVectorModelStmt = this.db.prepare(`
      SELECT 1 AS ok
      FROM memory_vectors
      WHERE model = ?
      LIMIT 1
    `)
    this.upsertVectorStmt = this.db.prepare(`
      INSERT INTO memory_vectors (entity_type, entity_id, model, dims, vector_json, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(entity_type, entity_id, model) DO UPDATE SET
        dims = excluded.dims,
        vector_json = excluded.vector_json,
        content_hash = excluded.content_hash,
        updated_at = unixepoch()
    `)
    this.getVectorStmt = this.db.prepare(`
      SELECT entity_type, entity_id, model, dims, vector_json, content_hash
      FROM memory_vectors
      WHERE entity_type = ? AND entity_id = ? AND model = ?
    `)
    this.listDenseClassificationRowsStmt = this.db.prepare(`
      SELECT 'classification' AS type, c.classification AS subtype, c.id AS entity_id,
             trim(c.element || ' | ' || c.topic || CASE WHEN c.importance IS NOT NULL AND c.importance != '' THEN ' | ' || c.importance ELSE '' END || CASE WHEN c.state IS NOT NULL AND c.state != '' THEN ' | ' || c.state ELSE '' END) AS content,
             c.updated_at AS updated_at, c.retrieval_count AS retrieval_count,
             c.confidence AS quality_score, c.importance AS importance,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN classifications c ON c.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = c.episode_id
      WHERE mv.entity_type = 'classification'
        AND mv.model = ?
        AND c.status = 'active'
    `)
    this.listDenseEpisodeRowsStmt = this.db.prepare(`
      SELECT 'episode' AS type, e.role AS subtype, e.id AS entity_id, e.content AS content,
             e.created_at AS updated_at, 0 AS retrieval_count,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN episodes e ON e.id = mv.entity_id
      WHERE mv.entity_type = 'episode'
        AND mv.model = ?
        AND e.kind IN (${RECALL_EPISODE_KIND_SQL})
    `)
    this.listDenseChunkRowsStmt = this.db.prepare(`
      SELECT 'chunk' AS type, 'chunk' AS subtype, mc.id AS entity_id, mc.content AS content,
             mc.created_at AS updated_at, 0 AS retrieval_count,
             NULL AS quality_score, NULL AS importance,
             NULL AS source_ref, mc.created_at AS source_ts, NULL AS source_kind, NULL AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN memory_chunks mc ON mc.id = mv.entity_id
      WHERE mv.entity_type = 'chunk'
        AND mv.model = ?
        AND mc.status = 'active'
    `)
  }

  getMetaValue(key, fallback = null) {
    const row = this.getMetaStmt.get(key)
    return row?.value ?? fallback
  }

  getRetrievalTuning() {
    const configPath = join(this.dataDir, 'config.json')
    try {
      const mtimeMs = statSync(configPath).mtimeMs
      if (this._retrievalTuningCache?.mtimeMs === mtimeMs) return this._retrievalTuningCache.value
      const raw = JSON.parse(readFileSync(configPath, 'utf8'))
      const value = mergeMemoryTuning(raw?.retrieval ?? {})
      const featureFlags = readMemoryFeatureFlags(raw)
      value.reranker.enabled = featureFlags.reranker
      this._retrievalTuningCache = { mtimeMs, value }
      return value
    } catch {
      if (this._retrievalTuningCache?.value) return this._retrievalTuningCache.value
      const value = mergeMemoryTuning()
      this._retrievalTuningCache = { mtimeMs: 0, value }
      return value
    }
  }

  setMetaValue(key, value) {
    const serialized =
      typeof value === 'string'
        ? value
        : JSON.stringify(value)
    this.upsertMetaStmt.run(key, serialized)
  }

  syncEmbeddingMetadata(extra = {}) {
    this.setMetaValue('embedding.current_model', getEmbeddingModelId())
    this.setMetaValue('embedding.current_dims', String(getEmbeddingDims()))
    this.setMetaValue('embedding.index_version', '2')
    this.setMetaValue('embedding.updated_at', localNow())
    if (extra.vectorModel) this.setMetaValue('embedding.vector_model', extra.vectorModel)
    if (extra.vectorDims) this.setMetaValue('embedding.vector_dims', String(extra.vectorDims))
    if (extra.reason) this.setMetaValue('embedding.last_reason', extra.reason)
    if (extra.reindexRequired != null) this.setMetaValue('embedding.reindex_required', extra.reindexRequired ? '1' : '0')
    if (extra.reindexReason) this.setMetaValue('embedding.reindex_reason', extra.reindexReason)
    if (extra.reindexCompleted) {
      this.setMetaValue('embedding.reindex_required', '0')
      this.setMetaValue('embedding.reindex_reason', '')
    }
  }

  noteVectorWrite(model, dims) {
    const switchEvent = consumeProviderSwitchEvent()
    this.syncEmbeddingMetadata({
      vectorModel: model,
      vectorDims: dims,
      reason: switchEvent ? `vector_write_after_${switchEvent.phase}_switch` : 'vector_write',
      reindexRequired: switchEvent ? 1 : 0,
      reindexReason: switchEvent
        ? `${switchEvent.previousModelId} -> ${switchEvent.currentModelId} (${switchEvent.phase}: ${switchEvent.reason})`
        : '',
    })
  }

  /**
   * Retrieve a stored vector from memory_vectors, or compute and store it.
   * @param {string} entityType - 'fact', 'task', 'signal', 'episode'
   * @param {number} entityId - row id
   * @param {string} text - text to embed if no stored vector found
   * @returns {number[]} embedding vector
   */
  async getStoredVector(entityType, entityId, text) {
    const lookupModel = getEmbeddingModelId()
    const existing = this.getVectorStmt.get(entityType, entityId, lookupModel)
    if (existing?.vector_json) {
      try {
        const parsed = JSON.parse(existing.vector_json)
        if (Array.isArray(parsed) && parsed.length > 0) return parsed
      } catch { /* fall through to embed */ }
    }
    const vector = await embedText(String(text).slice(0, 768))
    if (Array.isArray(vector) && vector.length > 0) {
      const activeModel = getEmbeddingModelId()
      const contentHash = hashEmbeddingInput(text)
      this.upsertVectorStmt.run(entityType, entityId, activeModel, vector.length, JSON.stringify(vector), contentHash)
      this._syncToVecTable(entityType, entityId, vector)
      this.noteVectorWrite(activeModel, vector.length)
    }
    return vector
  }

  appendEpisode(entry) {
    const clean = cleanMemoryText(entry.content)
    if (!clean) return null
    const ts = entry.ts || localNow()
    const dayKey = localDateStr(new Date(ts))
    const sourceRef = entry.sourceRef || null
    const episodeKind = entry.kind || 'message'
    this.insertEpisodeStmt.run(
      ts,
      dayKey,
      entry.backend || 'trib-memory',
      entry.channelId || null,
      entry.userId || null,
      entry.userName || null,
      entry.sessionId || null,
      entry.role,
      episodeKind,
      clean,
      sourceRef,
    )

    const episodeId = sourceRef ? this.getEpisodeBySourceStmt.get(sourceRef)?.id : null
    const finalEpisodeId = episodeId ?? this.db.prepare('SELECT last_insert_rowid() AS id').get().id
    if (finalEpisodeId) {
      if (episodeKind === 'message' || episodeKind === 'turn') {
        try {
          this.insertEpisodeFtsStmt.run(finalEpisodeId, clean)
        } catch { /* duplicate rowid import */ }
      }
      const shouldCandidate =
        (entry.role === 'user' && episodeKind === 'message') ||
        (entry.role === 'assistant' && episodeKind === 'message')
      if (shouldCandidate) {
        insertCandidateUnits(this.insertCandidateStmt, finalEpisodeId, ts, dayKey, entry.role, clean)
      }

      // Embedding handled by cycle1 after classification
    }
    return finalEpisodeId ?? null
  }

  _embedEpisodeAsync(episodeId, content) {
    const lookupModel = getEmbeddingModelId()
    const contentHash = hashEmbeddingInput(content)
    const existing = this.getVectorStmt.get('episode', episodeId, lookupModel)
    if (existing?.content_hash === contentHash) return
    const task = async () => {
      const vector = await embedText(content.slice(0, 768))
      if (!Array.isArray(vector) || vector.length === 0) return
      const activeModel = getEmbeddingModelId()
      this.upsertVectorStmt.run('episode', episodeId, activeModel, vector.length, JSON.stringify(vector), contentHash)
      this._syncToVecTable('episode', episodeId, vector)
      this.noteVectorWrite(activeModel, vector.length)
    }
    if (!this._embedQueue) this._embedQueue = Promise.resolve()
    this._embedQueue = this._embedQueue.then(task).catch(() => {})
  }

  async processPendingEmbeds() {
    // Legacy: pending_embeds table is no longer used.
    // Episodes without vectors are picked up by getEmbeddableItems() in the normal cycle.
    return 0
  }

  getHealthStatus() {
    const h = {
      status: 'ok',
      vec_enabled: Boolean(this.vecEnabled),
      vec_ready: false,
      embedding: { model_id: null, dims: null },
      reranker: { model_id: null, device: null },
      reindex_required: false,
      counts: { episodes: 0, classifications_active: 0, chunks_active: 0, vectors_total: 0, vectors_by_type: {} },
      pending_candidates: 0,
    }
    try { h.embedding.model_id = getEmbeddingModelId() } catch {}
    try { h.embedding.dims = getEmbeddingDims() } catch {}
    try { h.reranker.model_id = getRerankerModelId() } catch {}
    try { h.reranker.device = getRerankerDevice() } catch {}
    try { h.vec_ready = Boolean(this.vecEnabled && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_memory'").get()) } catch {}
    try { h.reindex_required = this.getMetaValue('embedding.reindex_required', '0') === '1' } catch {}
    try { h.counts.episodes = Number(this.db.prepare('SELECT COUNT(*) AS n FROM episodes').get()?.n ?? 0) } catch {}
    try { h.counts.classifications_active = Number(this.db.prepare("SELECT COUNT(*) AS n FROM classifications WHERE status='active'").get()?.n ?? 0) } catch {}
    try { h.counts.chunks_active = Number(this.db.prepare("SELECT COUNT(*) AS n FROM memory_chunks WHERE status='active'").get()?.n ?? 0) } catch {}
    try { h.counts.vectors_total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()?.n ?? 0) } catch {}
    try {
      for (const row of this.db.prepare('SELECT entity_type, COUNT(*) AS n FROM memory_vectors GROUP BY entity_type').all())
        h.counts.vectors_by_type[row.entity_type] = Number(row.n)
    } catch {}
    try { h.pending_candidates = Number(this.db.prepare("SELECT COUNT(*) AS n FROM memory_candidates WHERE status='pending'").get()?.n ?? 0) } catch {}
    if (h.reindex_required) h.status = 'degraded'
    if (h.vec_enabled && !h.vec_ready) h.status = 'degraded'
    return h
  }

  ingestTranscriptFile(transcriptPath) {
    if (!existsSync(transcriptPath)) return 0
    const prev = this._transcriptOffsets.get(transcriptPath) ?? { bytes: 0, lineIndex: 0 }
    let fd = null
    let lines
    try {
      const stat = statSync(transcriptPath)
      if (stat.size < prev.bytes) {
        // File was truncated/replaced — reset
        prev.bytes = 0
        prev.lineIndex = 0
      }
      if (stat.size <= prev.bytes) return 0
      fd = openSync(transcriptPath, 'r')
      const buf = Buffer.alloc(stat.size - prev.bytes)
      readSync(fd, buf, 0, buf.length, prev.bytes)
      prev.bytes = stat.size
      lines = buf.toString('utf8').split('\n').filter(Boolean)
    } catch { return 0 }
    finally { if (fd != null) closeSync(fd) }
    let count = 0
    let index = prev.lineIndex
    for (const line of lines) {
      index += 1
      try {
        const parsed = JSON.parse(line)
        const role = parsed.message?.role
        if (role !== 'user' && role !== 'assistant') continue
        const text = firstTextContent(parsed.message?.content)
        if (!text.trim()) continue
        const clean = cleanMemoryText(text)
        if (!clean || clean.includes('[Request interrupted by user]')) continue
        if (isTranscriptQuarantineContent(clean)) continue
        const rawTs = parsed.timestamp ?? parsed.ts ?? null
        const ts = rawTs ? toLocalTs(rawTs) : localNow()
        const sourceRef = `transcript:${resolve(transcriptPath)}:${index}:${role}`
        const id = this.appendEpisode({
          ts,
          backend: 'claude-session',
          channelId: null,
          userId: role === 'user' ? 'session:user' : 'session:assistant',
          userName: role,
          sessionId: null,
          role,
          kind: 'message',
          content: clean,
          sourceRef,
        })
        if (id) count += 1
      } catch { /* skip malformed lines */ }
    }
    prev.lineIndex = index
    this._transcriptOffsets.set(transcriptPath, prev)
    return count
  }

  ingestTranscriptFiles(paths) {
    let total = 0
    for (const filePath of paths) {
      total += this.ingestTranscriptFile(filePath)
    }
    return total
  }

  getEpisodesForDate(dayKey, options = {}) {
    const includeTranscripts = Boolean(options.includeTranscripts)
    return this.db.prepare(`
      SELECT id, ts, role, content
      FROM episodes
      WHERE day_key = ?
        AND kind IN (${includeTranscripts ? DEBUG_RECALL_EPISODE_KIND_SQL : RECALL_EPISODE_KIND_SQL})
      ORDER BY ts, id
    `).all(dayKey)
  }

  getEpisodeDayKey(episodeId) {
    return this.db.prepare(`
      SELECT day_key
      FROM episodes
      WHERE id = ?
    `).get(episodeId)?.day_key ?? null
  }

  async getEpisodeRecallRows(options = {}) {
    return getEpisodeRecallRowsImpl(this, options)
  }

  getRecallShortcutRows(kind = 'all', limit = 5, options = {}) {
    return getRecallShortcutRowsImpl(this, kind, limit, options)
  }

  async applyMetadataFilters(rows = [], filters = {}) {
    return applyMetadataFiltersImpl(this, rows, filters)
  }

  getEpisodesSince(timestamp) {
    return getEpisodesSinceImpl(this, timestamp)
  }

  countEpisodes() {
    return countEpisodesImpl(this)
  }

  getCandidatesForDate(dayKey) {
    return getCandidatesForDateImpl(this, dayKey)
  }

  getPendingCandidateDays(limit = 7, minCount = 1) {
    return getPendingCandidateDaysImpl(this, limit, minCount)
  }

  getDecayRows(kind = 'fact') {
    return getDecayRowsImpl(this, kind)
  }

  resetEmbeddingIndex(options = {}) {
    return resetEmbeddingIndexImpl(this, options)
  }

  vacuumDatabase() {
    return vacuumDatabaseImpl(this)
  }

  getRecentCandidateDays(limit = 7) {
    return getRecentCandidateDaysImpl(this, limit)
  }

  countPendingCandidates(dayKey = null) {
    return countPendingCandidatesImpl(this, dayKey)
  }

  rebuildCandidates() {
    return rebuildCandidatesImpl(this)
  }

  resetConsolidatedMemory() {
    return resetConsolidatedMemoryImpl(this)
  }

  resetConsolidatedMemoryForDays(dayKeys = []) {
    return resetConsolidatedMemoryForDaysImpl(this, dayKeys)
  }

  pruneConsolidatedMemoryOutsideDays(dayKeys = []) {
    return pruneConsolidatedMemoryOutsideDaysImpl(this, dayKeys)
  }

  markCandidateIdsConsolidated(candidateIds = []) {
    return markCandidateIdsConsolidatedImpl(this, candidateIds)
  }

  markCandidatesConsolidated(dayKey) {
    return markCandidatesConsolidatedImpl(this, dayKey)
  }

  upsertDocument(kind, docKey, content) {
    const clean = cleanMemoryText(content)
    if (!clean) return
    this.db.prepare(`
      INSERT INTO documents (kind, doc_key, content, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(kind, doc_key) DO UPDATE SET
        content = excluded.content,
        updated_at = unixepoch()
    `).run(kind, docKey, clean)
  }

  upsertClassifications(rows = [], seenAt = null, sourceEpisodeId = null) {
    const ts = seenAt || localNow()
    const dayKey = localDateStr(new Date(ts))
    for (const row of rows) {
      const episodeId = Number(row?.episode_id ?? sourceEpisodeId ?? 0)
      if (!Number.isFinite(episodeId) || episodeId <= 0) continue
      const classification = cleanMemoryText(row?.classification)
      const topic = cleanMemoryText(row?.topic)
      const element = cleanMemoryText(row?.element)
      const state = cleanMemoryText(row?.state)
      const importance = String(row?.importance ?? '').trim() || null
      const chunks = JSON.stringify(Array.isArray(row?.chunks) ? row.chunks : [])
      const confidence = Number(row?.confidence ?? 0.6)
      if (!classification || !topic || !element) continue
      this.upsertClassificationStmt.run(
        episodeId,
        ts,
        dayKey,
        classification,
        topic,
        element,
        state || null,
        importance,
        chunks,
        confidence,
      )
      const id = this.getClassificationByEpisodeStmt.get(episodeId)?.id
      if (!id) continue
      try { this.deleteClassificationFtsStmt.run(id) } catch {}
      try {
        this.insertClassificationFtsStmt.run(
          id,
          classification,
          topic,
          element,
          state || '',
        )
      } catch {}
    }
  }

  getClassificationRows(limit = 12) {
    return this.db.prepare(`
      SELECT c.id, c.episode_id, c.classification, c.topic, c.element, c.state,
             c.confidence, c.day_key, c.ts, c.updated_at, c.retrieval_count,
             e.content AS episode_content
      FROM classifications c
      LEFT JOIN episodes e ON e.id = c.episode_id
      WHERE c.status = 'active'
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT ?
    `).all(Math.max(1, Number(limit ?? 12)))
  }

  syncHistoryFromFiles() {
    ensureDir(this.historyDir)
  }

  backfillProject(workspacePath, options = {}) {
    const limit = Number(options.limit ?? 50)
    const sinceMs = Number.isFinite(Number(options.sinceMs)) ? Number(options.sinceMs) : null
    const projectDir = join(homedir(), '.claude', 'projects', workspaceToProjectSlug(workspacePath))
    if (!existsSync(projectDir)) return this.backfillAllProjects(options)
    const files = readdirSync(projectDir)
      .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'))
      .map(file => ({
        path: join(projectDir, file),
        mtime: statSync(join(projectDir, file)).mtimeMs,
      }))
      .filter(item => !sinceMs || item.mtime >= sinceMs)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map(item => item.path)
      .reverse()
    return this.ingestTranscriptFiles(files)
  }

  /**
   * Scan all project dirs under ~/.claude/projects/ for transcripts.
   * No slug-to-path conversion needed — reads directories directly.
   * Works on macOS, Windows, and WSL without path format issues.
   */
  backfillAllProjects(options = {}) {
    const limit = Number(options.limit ?? 50)
    const sinceMs = Number.isFinite(Number(options.sinceMs)) ? Number(options.sinceMs) : null
    const projectsRoot = join(homedir(), '.claude', 'projects')
    if (!existsSync(projectsRoot)) return 0
    const allFiles = []
    try {
      for (const d of readdirSync(projectsRoot)) {
        if (d.includes('tmp') || d.includes('cache') || d.includes('plugins')) continue
        const full = join(projectsRoot, d)
        try {
          for (const f of readdirSync(full)) {
            if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue
            const fp = join(full, f)
            const mtime = statSync(fp).mtimeMs
            if (sinceMs && mtime < sinceMs) continue
            allFiles.push({ path: fp, mtime })
          }
        } catch {}
      }
    } catch { return 0 }
    allFiles.sort((a, b) => b.mtime - a.mtime)
    const selected = allFiles.slice(0, limit).reverse().map(f => f.path)
    return this.ingestTranscriptFiles(selected)
  }

  buildContextText() {
    const parts = []

    // Core Memory: read from core_memory table (managed by cycle2)
    const coreItems = this.db.prepare(`
      SELECT topic, element, importance
      FROM core_memory
      WHERE status = 'active'
      ORDER BY final_score DESC, mention_count DESC
    `).all()

    if (coreItems.length > 0) {
      const lines = coreItems.map(row => {
        return `- ${row.topic} — ${row.element}`
      })
      parts.push(`## Core Memory\n${lines.join('\n')}`)
    }

    return parts.join('\n\n').trim()
  }

  // ── Proactive sources ────────────────────────────────────────────

  getProactiveSources(status = 'active') {
    return this.db.prepare(`
      SELECT * FROM proactive_sources WHERE status = ? ORDER BY score DESC
    `).all(status)
  }

  pickProactiveSource() {
    const sources = this.getProactiveSources('active')
    if (sources.length === 0) return null
    // Weighted random by score
    const total = sources.reduce((sum, s) => sum + s.score, 0)
    let r = Math.random() * total
    for (const s of sources) {
      r -= s.score
      if (r <= 0) return s
    }
    return sources[sources.length - 1]
  }

  updateProactiveScore(id, hit) {
    const delta = hit ? 0.05 : -0.03
    this.db.prepare(`
      UPDATE proactive_sources
      SET score = MAX(0.1, MIN(1.0, score + ?)),
          ${hit ? 'hit_count = hit_count + 1' : 'skip_count = skip_count + 1'},
          last_used = datetime('now'),
          updated_at = unixepoch()
      WHERE id = ? AND pinned = 0
    `).run(delta, id)
  }

  addProactiveSource(category, topic, query, pinned = false) {
    return this.db.prepare(`
      INSERT INTO proactive_sources (category, topic, query, pinned)
      VALUES (?, ?, ?, ?)
    `).run(category, topic, query, pinned ? 1 : 0)
  }

  removeProactiveSource(id, pinned = false) {
    if (pinned) {
      // User removal — mark as removed + pinned so it doesn't come back
      this.db.prepare(`UPDATE proactive_sources SET status = 'removed', pinned = 1, updated_at = unixepoch() WHERE id = ?`).run(id)
    } else {
      this.db.prepare(`DELETE FROM proactive_sources WHERE id = ? AND pinned = 0`).run(id)
    }
  }

  seedProactiveSources() {
    const count = this.db.prepare('SELECT COUNT(*) as n FROM proactive_sources').get().n
    if (count > 0) return
    const seeds = [
      ['memory', 'Recent work follow-up', 'recent work tasks decisions'],
      ['news', 'Tech & AI news', 'latest AI technology news'],
      ['work', 'Project status', 'project issues PRs build status'],
      ['weather', 'Weather', 'current weather forecast'],
      ['casual', 'Break & wellness', 'take a break productivity tips'],
    ]
    const stmt = this.db.prepare('INSERT INTO proactive_sources (category, topic, query) VALUES (?, ?, ?)')
    for (const [cat, topic, query] of seeds) stmt.run(cat, topic, query)
  }

  writeContextFile() {
    const contextPath = join(this.historyDir, 'context.md')
    ensureDir(this.historyDir)
    const content = this.buildContextText()
    writeFileSync(contextPath, `<!-- Auto-generated by memory store -->\n\n${content}\n`)
    return contextPath
  }

  syncChunksFromClassifications() {
    const rows = this.db.prepare(`
      SELECT id, episode_id, topic, importance, chunks
      FROM classifications
      WHERE chunks IS NOT NULL AND chunks != '[]' AND status = 'active'
    `).all()

    let synced = 0
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO memory_chunks (episode_id, classification_id, content, topic, importance, seq)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    for (const row of rows) {
      let chunks
      try { chunks = JSON.parse(row.chunks) } catch { continue }
      if (!Array.isArray(chunks) || chunks.length === 0) continue

      const existing = this.db.prepare('SELECT COUNT(*) as cnt FROM memory_chunks WHERE episode_id = ?').get(row.episode_id)
      if (existing?.cnt > 0) continue

      for (let seq = 0; seq < chunks.length; seq++) {
        const text = String(chunks[seq]).trim()
        if (!text) continue
        insert.run(row.episode_id, row.id, text, row.topic || '', row.importance || '', seq)
        const chunkId = this.db.prepare('SELECT last_insert_rowid() as id').get().id
        try {
          this.db.prepare('INSERT INTO memory_chunks_fts(rowid, content, topic) VALUES (?, ?, ?)').run(chunkId, text, row.topic || '')
        } catch {}
        synced++
      }
    }

    // Backfill missing FTS entries
    const missingFts = this.db.prepare(`
      SELECT mc.id, mc.content, mc.topic FROM memory_chunks mc
      WHERE mc.id NOT IN (SELECT rowid FROM memory_chunks_fts)
    `).all()
    for (const mc of missingFts) {
      try {
        this.db.prepare('INSERT INTO memory_chunks_fts(rowid, content, topic) VALUES (?, ?, ?)').run(mc.id, mc.content, mc.topic || '')
        synced++
      } catch {}
    }

    return synced
  }

  writeRecentFile(options = {}) {
    try {
      ensureDir(this.historyDir)
      const serverStartedAt = options.serverStartedAt
      let lines = []

      // Primary: chunk-based (latest 10)
      const timeFilter = serverStartedAt ? 'AND e.ts < ?' : ''
      const timeParams = serverStartedAt ? [serverStartedAt] : []
      const chunkRows = this.db.prepare(`
        SELECT mc.topic, mc.content, mc.importance
        FROM memory_chunks mc
        JOIN episodes e ON e.id = mc.episode_id
        WHERE mc.status = 'active'
          ${timeFilter}
        ORDER BY e.ts DESC, mc.seq ASC
        LIMIT 10
      `).all(...timeParams)

      if (chunkRows.length > 0) {
        lines = chunkRows.map(r => {
          const prefix = r.topic ? `${r.topic}: ` : ''
          return `- ${prefix}${r.content}`
        })
      } else {
        // Fallback: episode-based (when no chunks available)
        const episodeSql = `
          SELECT role, content FROM episodes
          WHERE kind = 'message'
            AND role IN ('user', 'assistant')
            AND content NOT LIKE 'You are%'
            AND LENGTH(content) >= 5
            ${timeFilter}
          ORDER BY ts DESC, id DESC
          LIMIT 10
        `
        const recentEpisodes = this.db.prepare(episodeSql).all(...timeParams).reverse()
        lines = recentEpisodes.map(r => `${r.role === 'user' ? 'u' : 'a'}: ${r.content}`)
      }

      const text = lines.length > 0 ? `## Recent\n${lines.join('\n')}\n` : ''
      writeFileSync(join(this.historyDir, 'recent.md'), text, 'utf8')
    } catch {}
  }

  appendRetrievalTrace(record = {}) {
    try {
      ensureDir(this.historyDir)
      const tracePath = join(this.historyDir, 'retrieval-trace.jsonl')
      appendFileSync(tracePath, `${JSON.stringify(record)}\n`, 'utf8')
    } catch (error) {
      logIgnoredError('appendRetrievalTrace', error)
    }
  }

  async warmupEmbeddings() {
    await warmupEmbeddingProvider()
  }

  getEmbeddableItems(options = {}) {
    const perTypeLimit = options.all
      ? 1000000000
      : Math.max(1, Number(options.perTypeLimit ?? 128))
    const items = []

    const classificationRows = this.db.prepare(`
      SELECT id, classification, topic, element, importance, state
      FROM classifications
      WHERE status = 'active'
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(Math.max(8, Math.floor(perTypeLimit / 2)))
    for (const row of classificationRows) {
      items.push({
        key: embeddingItemKey('classification', row.id),
        entityType: 'classification',
        entityId: row.id,
        subtype: row.classification,
        content: [row.element, row.topic, row.importance, row.state].filter(Boolean).join(' | '),
      })
    }

    const episodeLimit = Math.max(8, Math.floor(perTypeLimit / 2))
    const maxAgeDays = options.maxAgeDays ?? null
    const ageFilter = maxAgeDays ? `AND ts >= datetime('now', '-${Number(maxAgeDays)} days')` : ''
    const episodeRows = this.db.prepare(`
      SELECT id, role AS subtype, day_key AS ref, content
      FROM episodes
      WHERE kind IN (${RECALL_EPISODE_KIND_SQL})
        AND LENGTH(content) BETWEEN 10 AND 1500
        AND content NOT LIKE 'You are consolidating%'
        AND content NOT LIKE 'You are improving%'
        AND content NOT LIKE 'Answer using live%'
        AND content NOT LIKE 'Use the ai_search%'
        AND content NOT LIKE 'Say only%'
        ${ageFilter}
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `).all(episodeLimit)
    for (const row of episodeRows) {
      const cls = this.db.prepare('SELECT element FROM classifications WHERE episode_id = ?').get(row.id)
      const prefix = cls?.element ? cls.element + ' | ' : ''
      items.push({
        key: embeddingItemKey('episode', row.id),
        entityType: 'episode',
        entityId: row.id,
        subtype: row.subtype,
        ref: row.ref,
        content: prefix + row.content,
      })
    }

    // Chunks: embed each chunk independently
    try {
      const chunkRows = this.db.prepare(`
        SELECT id, content, topic FROM memory_chunks WHERE status = 'active'
        ORDER BY created_at DESC LIMIT ?
      `).all(perTypeLimit)
      for (const row of chunkRows) {
        const chunkContent = row.topic ? `${row.topic} | ${row.content}` : row.content
        items.push({
          key: embeddingItemKey('chunk', row.id),
          entityType: 'chunk',
          entityId: row.id,
          subtype: 'chunk',
          content: chunkContent,
        })
      }
    } catch { /* memory_chunks table may not exist yet */ }

    // Core memory: embed active + pending core_memory items
    try {
      const coreLimit = Math.max(8, Math.floor(perTypeLimit / 4))
      const coreRows = this.db.prepare(`
        SELECT id, topic, element, importance FROM core_memory
        WHERE status IN ('active', 'pending')
        ORDER BY final_score DESC, id DESC
        LIMIT ?
      `).all(coreLimit)
      for (const row of coreRows) {
        items.push({
          key: embeddingItemKey('core_memory', row.id),
          entityType: 'core_memory',
          entityId: row.id,
          subtype: row.importance || 'fact',
          content: [row.element, row.topic, row.importance].filter(Boolean).join(' | '),
        })
      }
    } catch { /* core_memory table may not exist yet */ }

    return items
  }

  async ensureEmbeddings(options = {}) {
    const candidates = this.getEmbeddableItems(options)
    const contextMap = options.contextMap instanceof Map ? options.contextMap : new Map()

    // Check config: when embedding.contextualize === false, use raw content without metadata prefixes
    let contextualizeLocal = true
    try {
      const cfg = JSON.parse(readFileSync(join(this.dataDir, 'config.json'), 'utf8'))
      if (cfg?.embedding?.contextualize === false) contextualizeLocal = false
    } catch {}

    // Batch-load existing content hashes to avoid per-item DB queries
    const lookupModel = getEmbeddingModelId()
    const existingHashes = new Map()
    try {
      const rows = this.db.prepare(
        `SELECT entity_type, entity_id, content_hash FROM memory_vectors WHERE model = ?`
      ).all(lookupModel)
      for (const r of rows) {
        existingHashes.set(`${r.entity_type}:${r.entity_id}`, r.content_hash)
      }
    } catch {}

    let updated = 0
    for (const item of candidates) {
      const contextText = contextMap.get(item.key)
      let embedInput
      if (contextText) {
        embedInput = cleanMemoryText(`${contextText}\n${item.content}`)
      } else if (contextualizeLocal) {
        embedInput = contextualizeEmbeddingInput(item)
      } else {
        embedInput = cleanMemoryText(item.content ?? '')
      }
      if (!embedInput) continue
      const contentHash = hashEmbeddingInput(embedInput)
      const existingHash = existingHashes.get(`${item.entityType}:${item.entityId}`)
      if (existingHash === contentHash) continue
      const vector = await embedText(embedInput)
      if (!Array.isArray(vector) || vector.length === 0) continue
      const activeModel = getEmbeddingModelId()
      this.upsertVectorStmt.run(
        item.entityType,
        item.entityId,
        activeModel,
        vector.length,
        JSON.stringify(vector),
        contentHash,
      )
      this._syncToVecTable(item.entityType, item.entityId, vector)
      this.noteVectorWrite(activeModel, vector.length)
      updated += 1
    }
    this._pruneOldEpisodeVectors()
    return updated
  }

  _syncToVecTable(entityType, entityId, vector) {
    if (!this.vecEnabled) return
    const rowid = this._vecRowId(entityType, entityId)
    try {
      const hex = vecToHex(vector)
      this.db.exec(`INSERT OR REPLACE INTO vec_memory(rowid, embedding) VALUES (${rowid}, X'${hex}')`)
    } catch { /* ignore */ }
  }

  _vecRowId(entityType, entityId) {
    // Pack entity type + id into a single integer rowid (100M ceiling per type)
    const typePrefix = { fact: 1, task: 2, signal: 3, episode: 4, proposition: 5, entity: 6, relation: 7, classification: 8, chunk: 9, core_memory: 10 }
    return (typePrefix[entityType] ?? 0) * 100000000 + Number(entityId)
  }

  _vecRowToEntity(rowid) {
    const typeMap = { 1: 'fact', 2: 'task', 3: 'signal', 4: 'episode', 5: 'proposition', 6: 'entity', 7: 'relation', 8: 'classification', 9: 'chunk', 10: 'core_memory' }
    const typeNum = Math.floor(rowid / 100000000)
    return { entityType: typeMap[typeNum] ?? 'unknown', entityId: rowid % 100000000 }
  }

  _pruneOldEpisodeVectors() {
    // TTL: remove episode vectors older than 30 days
    try {
      const cutoff = this.db.prepare(`
        SELECT id FROM episodes
        WHERE ts < datetime('now', '-30 days')
          AND id IN (SELECT entity_id FROM memory_vectors WHERE entity_type = 'episode')
      `).all()
      for (const { id } of cutoff) {
        this.db.prepare('DELETE FROM memory_vectors WHERE entity_type = ? AND entity_id = ?').run('episode', id)
        if (this.vecEnabled) {
          const rowid = this._vecRowId('episode', id)
          try { this.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
        }
      }
      if (cutoff.length > 0) {
        process.stderr.write(`[memory] pruned ${cutoff.length} old episode vectors\n`)
      }
    } catch { /* ignore */ }
  }

  async buildRecentFocusVector(options = {}) {
    const maxEpisodes = Math.max(1, Number(options.maxEpisodes ?? 8))
    const sinceDays = Math.max(1, Number(options.sinceDays ?? 3))
    const channelId = String(options.channelId ?? '').trim()
    const userId = String(options.userId ?? '').trim()
    let rows = []

    if (channelId) {
      rows = this.db.prepare(`
        SELECT id, content
        FROM episodes
        WHERE role = 'user'
          AND kind = 'message'
          AND channel_id = ?
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(channelId, `-${sinceDays} days`, maxEpisodes)
    }

    if (rows.length === 0 && userId) {
      rows = this.db.prepare(`
        SELECT id, content
        FROM episodes
        WHERE role = 'user'
          AND kind = 'message'
          AND user_id = ?
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(userId, `-${sinceDays} days`, maxEpisodes)
    }

    if (rows.length === 0) {
      rows = this.db.prepare(`
        SELECT id, content
        FROM episodes
        WHERE role = 'user'
          AND kind = 'message'
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(`-${sinceDays} days`, maxEpisodes)
    }

    if (rows.length === 0) return []
    const vectors = await Promise.all(
      rows.map(row => this.getStoredVector('episode', row.id, cleanMemoryText(row.content))),
    )
    return averageVectors(vectors)
  }

  async rankIntentSeedItems(rows, query = '', queryVector = null, options = {}) {
    if (!rows.length) return []
    const vector = query ? (queryVector ?? await embedText(query)) : null
    const tokens = new Set(tokenizeMemoryText(query))
    const minSimilarity = Number(options.minSimilarity ?? 0)

    const scored = await Promise.all(rows.map(async row => {
      const content = cleanMemoryText(row.content ?? '')
      const contentTokens = tokenizeMemoryText(`${row.subtype ?? ''} ${content}`)
      const overlapCount = contentTokens.reduce((count, token) => count + (tokens.has(token) ? 1 : 0), 0)
      const entityType = row.type ?? 'fact'
      const entityId = Number(row.entity_id ?? 0)
      const rowVector = (vector && entityId > 0)
        ? await this.getStoredVector(entityType, entityId, `${row.subtype ?? ''} ${content}`)
        : (vector ? await embedText(String(`${row.subtype ?? ''} ${content}`).slice(0, 768)) : [])
      const semanticSimilarity = vector
        ? cosineSimilarity(vector, rowVector)
        : 0
      return {
        ...row,
        semanticSimilarity,
        overlapCount,
        seedRank: semanticSimilarity * 4 + overlapCount * 2 + Number(row.quality_score ?? 0.5),
      }
    }))

    return scored
      .filter(item => item.overlapCount > 0 || item.semanticSimilarity >= minSimilarity || minSimilarity <= 0)
      .sort((a, b) => Number(b.seedRank) - Number(a.seedRank))
  }

  async searchRelevantHybrid(query, limit = 8, options = {}) {
    const clean = cleanMemoryText(query)
    if (!clean) return []

    // ── Temporal parsing: "yesterday", "March 30", "last week" → date range ──
    const temporal = options.temporal ?? (() => {
      const hint = parseTemporalHint(clean)
      if (!hint) return null
      return { start: hint.start, end: hint.end ?? hint.start, exact: hint.start === (hint.end ?? hint.start) }
    })()

    // ── Stage 1: base scores (keyword + embedding + time) ──
    const queryVector = options.queryVector ?? await embedText(clean)
    const variants = generateQueryVariants ? generateQueryVariants(clean) : [clean]
    const allQueries = [clean, ...variants.filter(v => v !== clean)].slice(0, 6) // max 6 variants (ko↔en)

    // Multi-variant sparse search: run FTS on each variant and merge
    let sparse = []
    {
      const seenSparse = new Set()
      for (const q of allQueries) {
        const sr = this.searchRelevantSparse(q, limit * 2)
        for (const r of sr) {
          const key = `${r.type}-${r.entity_id}`
          if (!seenSparse.has(key)) {
            seenSparse.add(key)
            sparse.push(r)
          }
        }
      }
    }
    let dense = await this.searchRelevantDense(clean, limit * 3, queryVector, null, {})

    // Temporal filter: prioritize in-range results, mix with out-of-range
    if (temporal?.start) {
      const inRange = (ts) => {
        if (!ts) return false
        const d = String(ts).slice(0, 10)
        return d >= temporal.start && d <= temporal.end
      }
      const boostInRange = (items) => {
        const inside = items.filter(r => inRange(r.source_ts))
        const outside = items.filter(r => !inRange(r.source_ts))
        return [...inside, ...outside]
      }
      sparse = boostInRange(sparse)
      dense = boostInRange(dense)
    }

    // Merge via RRF (Reciprocal Rank Fusion) — scale-independent
    // RRF score = 1/(k+rank_sparse) + 1/(k+rank_dense), k=60
    const K = 60
    const sparseRanks = new Map()
    const denseRanks = new Map()
    sparse.forEach((item, i) => {
      const key = `${item.type}:${item.entity_id}`
      if (!sparseRanks.has(key)) sparseRanks.set(key, i + 1)
    })
    dense.forEach((item, i) => {
      const key = `${item.type}:${item.entity_id}`
      if (!denseRanks.has(key)) denseRanks.set(key, i + 1)
    })

    const seen = new Map()
    for (const item of [...sparse, ...dense]) {
      const key = `${item.type}:${item.entity_id}`
      if (seen.has(key)) {
        // Preserve vector_json from dense items if present
        if (item.vector_json && !seen.get(key).vector_json) {
          seen.get(key).vector_json = item.vector_json
        }
        continue
      }
      const sparseRank = sparseRanks.get(key)
      const denseRank = denseRanks.get(key)
      const rrfSparse = sparseRank ? 1 / (K + sparseRank) : 0
      const rrfDense = denseRank ? 1 / (K + denseRank) : 0
      const baseScore = rrfSparse + rrfDense
      seen.set(key, { ...item, keyword_score: rrfSparse, embedding_score: rrfDense, base_score: baseScore })
    }

    // ── Stage 2: apply retrieval scoring ──
    const { computeFinalScore, getScoringConfig } = await import('./memory-score-utils.mjs')
    const scoringConfig = getScoringConfig(options.tuning ?? this.getRetrievalTuning())

    const scored = []
    for (const [, item] of seen) {
      const finalScore = computeFinalScore(item.base_score, item, clean, { config: scoringConfig, queryVector })
      scored.push({ ...item, weighted_score: finalScore })
    }

    // ── Importance keyword boost: boost classifications matching query intent ──
    const IMPORTANCE_KEYWORDS = {
      '규칙': 'rule', '정책': 'rule', '목표': 'goal', '요청': 'directive', '지시': 'directive',
      '선호': 'preference', '결정': 'decision', '확정': 'decision', '사건': 'incident', '사고': 'incident',
    }
    const queryImportance = Object.entries(IMPORTANCE_KEYWORDS).find(([k]) => clean.includes(k))?.[1]
    if (queryImportance) {
      for (const item of scored) {
        if (item.type === 'classification' && String(item.importance || '').includes(queryImportance)) {
          item.weighted_score *= 2.0
        }
      }
    }

    scored.sort((a, b) => b.weighted_score - a.weighted_score)

    // ── Stage 3: smart fallback — semantic (chunks + classifications) first, episodes as fallback ──
    const semanticResults = scored.filter(item => item.type === 'chunk' || item.type === 'classification')
    const episodeResults = scored.filter(item => item.type === 'episode')
    const fallbackThreshold = Math.ceil(limit / 2)

    let merged
    if (semanticResults.length >= fallbackThreshold) {
      // Enough semantic results — use them, fill remaining with episodes
      const remaining = limit - semanticResults.length
      merged = [...semanticResults, ...episodeResults.slice(0, Math.max(0, remaining))]
    } else {
      // Not enough semantic results — fallback: fill with episodes
      const episodeSlots = limit - semanticResults.length
      merged = [...semanticResults, ...episodeResults.slice(0, episodeSlots)]
    }

    // Re-sort merged results by weighted_score (type boost already applied in computeFinalScore)
    merged.sort((a, b) => b.weighted_score - a.weighted_score)

    // Cap classifications within merged set
    const maxClassifications = Math.min(limit, Math.max(2, Math.ceil(merged.length * 0.3)))
    let classCount = 0
    const capped = []
    for (const item of merged) {
      if (item.type === 'classification') {
        if (classCount < maxClassifications) {
          capped.push(item)
          classCount++
        }
      } else {
        capped.push(item)
      }
    }

    // overFetch: pull extra candidates through MMR so reranker can promote buried hits
    const tuning = options.tuning ?? this.getRetrievalTuning()
    const overFetchN = tuning?.reranker?.overFetch ?? 15
    const overFetchLimit = Math.max(limit, Math.min(limit + overFetchN, capped.length))
    let finalResults = applyMMR(capped.slice(0, overFetchLimit))

    // ── Stage 4: rerank with cross-encoder (skipped when sort=date) ──
    if (!options.skipReranker && tuning.reranker?.enabled && finalResults.length >= 3) {
      try {
        const reranked = await jsRerank(clean, finalResults.slice(0, overFetchLimit), overFetchLimit)
        if (reranked.length > 0) {
          finalResults = reranked.slice(0, limit)
        }
      } catch {}
    } else {
      finalResults = finalResults.slice(0, limit)
    }

    if (options.recordRetrieval !== false) this.recordRetrieval(finalResults)

    if (options.debug) {
      return {
        results: finalResults,
        debug: { sparse: sparse.length, dense: dense.length, scored: scored.length },
      }
    }
    return finalResults
  }

  searchRelevantSparse(query, limit = 8) {
    const ftsQuery = buildFtsQuery(query)
    const shortTokens = getShortTokensForLike(query)
    if (!ftsQuery && shortTokens.length === 0) return []
    const results = []
    const runFts = Boolean(ftsQuery)

    if (runFts) {
      try {
      const classificationHits = this.db.prepare(`
        SELECT 'classification' AS type, c.classification AS subtype, CAST(c.id AS TEXT) AS ref,
               trim(c.element || ' | ' || c.topic || CASE WHEN c.importance IS NOT NULL AND c.importance != '' THEN ' | ' || c.importance ELSE '' END || CASE WHEN c.state IS NOT NULL AND c.state != '' THEN ' | ' || c.state ELSE '' END) AS content,
               bm25(classifications_fts) AS score, c.updated_at AS updated_at, c.id AS entity_id,
               c.confidence AS quality_score, c.importance AS importance, c.retrieval_count AS retrieval_count,
               e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend
        FROM classifications_fts
        JOIN classifications c ON c.id = classifications_fts.rowid
        LEFT JOIN episodes e ON e.id = c.episode_id
        WHERE classifications_fts MATCH ?
          AND c.status = 'active'
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
        results.push(...classificationHits)
      } catch (error) { logIgnoredError('searchRelevantSparse classifications fts', error) }
    }

    if (runFts) {
      try {
      const episodeHits = this.db.prepare(`
        SELECT 'episode' AS type, e.role AS subtype, CAST(e.id AS TEXT) AS ref,
               e.content AS content, bm25(episodes_fts) AS score,
               e.created_at AS updated_at, e.id AS entity_id, 0 AS retrieval_count,
               NULL AS quality_score,
               e.source_ref AS source_ref,
               e.ts AS source_ts,
               e.kind AS source_kind,
               e.backend AS source_backend,
               c.topic AS classification_topic,
               c.element AS classification_element,
               c.chunks AS classification_chunks
        FROM episodes_fts
        JOIN episodes e ON e.id = episodes_fts.rowid
        LEFT JOIN classifications c ON c.episode_id = e.id AND c.status = 'active'
        WHERE episodes_fts MATCH ?
          AND e.kind IN (${RECALL_EPISODE_KIND_SQL})
          AND e.content NOT LIKE 'You are consolidating%'
          AND e.content NOT LIKE 'You are improving%'
          AND e.content NOT LIKE 'You are analyzing%'
          AND e.content NOT LIKE 'Answer using live%'
          AND e.content NOT LIKE 'Use the ai_search%'
          AND e.content NOT LIKE 'Say only%'
          AND e.content NOT LIKE 'Compress these summaries%'
          AND e.content NOT LIKE 'Summarize the conversation%'
          AND LENGTH(e.content) >= 10
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
        results.push(...episodeHits)
      } catch (error) { logIgnoredError('searchRelevantSparse episodes fts', error) }
    }

    // Chunk FTS search
    if (runFts) {
      try {
        const chunkHits = this.db.prepare(`
          SELECT 'chunk' AS type, 'chunk' AS subtype, CAST(mc.id AS TEXT) AS ref,
                 mc.content AS content, bm25(memory_chunks_fts) AS score,
                 mc.created_at AS updated_at, mc.id AS entity_id, 0 AS retrieval_count,
                 NULL AS quality_score, mc.importance AS importance,
                 NULL AS source_ref, e.ts AS source_ts, e.kind AS source_kind, NULL AS source_backend,
                 mc.topic AS classification_topic, mc.content AS classification_element,
                 NULL AS classification_chunks, mc.episode_id AS chunk_episode_id
          FROM memory_chunks_fts
          JOIN memory_chunks mc ON mc.id = memory_chunks_fts.rowid
          LEFT JOIN episodes e ON e.id = mc.episode_id
          WHERE memory_chunks_fts MATCH ?
            AND mc.status NOT IN ('archived', 'demoted')
          ORDER BY score
          LIMIT ?
        `).all(ftsQuery, limit)
        results.push(...chunkHits)
      } catch (error) { logIgnoredError('searchRelevantSparse chunks fts', error) }
    }

    // LIKE supplement for 2-char Korean tokens that trigram can't index
    // Always run when short tokens exist — FTS misses these entirely
    if (shortTokens.length > 0) {
      const seen = new Set(results.map(r => `${r.type}:${r.entity_id}`))
      try {
        const likeClassifications = this.db.prepare(`
          SELECT 'classification' AS type, c.classification AS subtype, CAST(c.id AS TEXT) AS ref,
                 trim(c.element || ' | ' || c.topic || CASE WHEN c.importance IS NOT NULL AND c.importance != '' THEN ' | ' || c.importance ELSE '' END || CASE WHEN c.state IS NOT NULL AND c.state != '' THEN ' | ' || c.state ELSE '' END) AS content,
                 0 AS score, c.updated_at AS updated_at, c.id AS entity_id,
                 c.confidence AS quality_score, c.importance AS importance, c.retrieval_count AS retrieval_count,
                 e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend
          FROM classifications c
          LEFT JOIN episodes e ON e.id = c.episode_id
          WHERE c.status = 'active'
            AND (${shortTokens.map(() => '(c.classification LIKE ? OR c.topic LIKE ? OR c.element LIKE ? OR c.state LIKE ?)').join(' OR ')})
          LIMIT ?
        `).all(...shortTokens.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`]), Math.min(limit, 4))
        for (const hit of likeClassifications) {
          if (seen.has(`classification:${hit.entity_id}`)) continue
          hit.score = shortTokenMatchScore(hit.content, shortTokens)
          results.push(hit)
          seen.add(`classification:${hit.entity_id}`)
        }
      } catch (error) { logIgnoredError('searchRelevantSparse classifications like', error) }
      try {
        const likeEpisodes = this.db.prepare(`
          SELECT 'episode' AS type, e.role AS subtype, CAST(e.id AS TEXT) AS ref,
                 e.content AS content, 0 AS score, e.created_at AS updated_at, e.id AS entity_id,
                 0 AS quality_score, 0 AS retrieval_count,
                 e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend
          FROM episodes e
          WHERE e.kind IN (${RECALL_EPISODE_KIND_SQL})
            AND (${shortTokens.map(() => 'e.content LIKE ?').join(' OR ')})
          LIMIT ?
        `).all(...shortTokens.map(t => `%${t}%`), Math.min(limit, 4))
        for (const hit of likeEpisodes) {
          if (seen.has(`episode:${hit.entity_id}`)) continue
          hit.score = shortTokenMatchScore(hit.content, shortTokens)
          results.push(hit)
          seen.add(`episode:${hit.entity_id}`)
        }
      } catch (error) { logIgnoredError('searchRelevantSparse episodes like', error) }
    }

    return results
  }

  async searchRelevantDense(query, limit = 8, queryVector = null, focusVector = null, _options = {}) {
    const clean = cleanMemoryText(query)
    if (!clean) return []
    const vector = queryVector ?? await embedText(clean)
    if (!Array.isArray(vector) || vector.length === 0) return []
    const model = getEmbeddingModelId()
    const expectedDims = getEmbeddingDims()
    const vectorModel = this.getMetaValue('embedding.vector_model', '')
    const vectorDims = Number(this.getMetaValue('embedding.vector_dims', '0')) || 0
    const reindexRequired = this.getMetaValue('embedding.reindex_required', '0') === '1'
    const reindexReason = this.getMetaValue('embedding.reindex_reason', '')
    const hasCurrentModelVectors = Boolean(this.hasVectorModelStmt.get(model)?.ok)
    if (reindexRequired) {
      process.stderr.write(`[memory] dense retrieval disabled: embeddings require reindex (${reindexReason || 'provider/model switch'})\n`)
      return []
    }
    if (vectorModel && vectorModel !== model && !hasCurrentModelVectors) {
      process.stderr.write(`[memory] dense retrieval disabled: current model=${model} indexed model=${vectorModel}; rebuild embeddings required\n`)
      return []
    }
    if (expectedDims && vector.length !== expectedDims) {
      process.stderr.write(`[memory] dense retrieval disabled: query vector dims=${vector.length} expected=${expectedDims}\n`)
      return []
    }
    if (vectorDims && vector.length !== vectorDims && hasCurrentModelVectors) {
      process.stderr.write(`[memory] dense retrieval disabled: query vector dims=${vector.length} indexed dims=${vectorDims}\n`)
      return []
    }

    // sqlite-vec KNN path
    if (this.vecEnabled) {
      try {
        const hex = vecToHex(vector)
        const knnRows = this.vecReadDb.prepare(`
          SELECT rowid, distance FROM vec_memory WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT ?
        `).all(limit * 3)

        const results = []
        for (const knn of knnRows) {
          const { entityType, entityId } = this._vecRowToEntity(knn.rowid)
          if (entityType !== 'classification' && entityType !== 'episode' && entityType !== 'chunk') continue
          const meta = this._getEntityMeta(entityType, entityId, model, {})
          if (!meta) continue
          const similarity = 1 - knn.distance  // L2 distance → approximate similarity
          const focusSimilarity = Array.isArray(focusVector) ? (() => {
            try {
              const rv = JSON.parse(meta.vector_json)
              return rv.length === focusVector.length ? cosineSimilarity(focusVector, rv) : 0
            } catch { return 0 }
          })() : 0
          results.push({
            ...meta,
            ref: String(entityId),
            score: -similarity,
            focus_similarity: focusSimilarity,
          })
        }
        return results.sort((a, b) => Number(a.score) - Number(b.score)).slice(0, limit)
      } catch (e) {
        process.stderr.write(`[memory] vec KNN failed, falling back: ${e.message}\n`)
      }
    }

    // Fallback: JS cosine scan
    let chunkRows = []
    try { chunkRows = this.listDenseChunkRowsStmt.all(model) } catch { /* memory_chunks table may not exist */ }
    const rows = [
      ...this.listDenseClassificationRowsStmt.all(model),
      ...this.listDenseEpisodeRowsStmt.all(model),
      ...chunkRows,
    ]

    return rows
      .map(row => {
        try {
          const rowVector = JSON.parse(row.vector_json)
          const similarity = cosineSimilarity(vector, rowVector)
          const focusSimilarity =
            Array.isArray(focusVector) && focusVector.length === rowVector.length
              ? cosineSimilarity(focusVector, rowVector)
              : 0
          return {
            ...row,
            ref: String(row.entity_id),
            score: -similarity,
            focus_similarity: focusSimilarity,
          }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.score) - Number(b.score))
      .slice(0, limit)
  }

  _getEntityMeta(entityType, entityId, model, _options = {}) {
    try {
      if (entityType === 'classification') {
        return this.db.prepare(`
          SELECT 'classification' AS type, c.classification AS subtype, c.id AS entity_id,
                 trim(c.element || ' | ' || c.topic || CASE WHEN c.importance IS NOT NULL AND c.importance != '' THEN ' | ' || c.importance ELSE '' END || CASE WHEN c.state IS NOT NULL AND c.state != '' THEN ' | ' || c.state ELSE '' END) AS content,
                 c.updated_at AS updated_at, c.retrieval_count AS retrieval_count,
                 c.confidence AS quality_score, c.importance AS importance,
                 e.source_ref AS source_ref, e.ts AS source_ts,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json
          FROM classifications c
          JOIN memory_vectors mv ON mv.entity_type = 'classification' AND mv.entity_id = c.id AND mv.model = ?
          LEFT JOIN episodes e ON e.id = c.episode_id
          WHERE c.id = ? AND c.status = 'active'
        `).get(model, entityId)
      }
      if (entityType === 'episode') {
        return this.db.prepare(`
          SELECT 'episode' AS type, e.role AS subtype, e.id AS entity_id, e.content,
                 e.created_at AS updated_at, 0 AS retrieval_count,
                 e.source_ref AS source_ref, e.ts AS source_ts,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json,
                 c.topic AS classification_topic,
                 c.element AS classification_element,
               c.chunks AS classification_chunks
          FROM episodes e JOIN memory_vectors mv ON mv.entity_type = 'episode' AND mv.entity_id = e.id AND mv.model = ?
          LEFT JOIN classifications c ON c.episode_id = e.id AND c.status = 'active'
          WHERE e.id = ?
            AND e.kind IN (${RECALL_EPISODE_KIND_SQL})
        `).get(model, entityId)
      }
      if (entityType === 'chunk') {
        return this.db.prepare(`
          SELECT 'chunk' AS type, 'chunk' AS subtype, mc.id AS entity_id,
                 mc.content, mc.created_at AS updated_at, 0 AS retrieval_count,
                 mc.importance AS importance,
                 NULL AS source_ref, e.ts AS source_ts,
                 e.kind AS source_kind, NULL AS source_backend,
                 mv.vector_json,
                 mc.topic AS classification_topic, mc.content AS classification_element,
                 NULL AS classification_chunks, mc.episode_id AS chunk_episode_id
          FROM memory_chunks mc
          JOIN memory_vectors mv ON mv.entity_type = 'chunk' AND mv.entity_id = mc.id AND mv.model = ?
          LEFT JOIN episodes e ON e.id = mc.episode_id
          WHERE mc.id = ? AND mc.status NOT IN ('archived', 'demoted')
        `).get(model, entityId)
      }
    } catch {}
    return null
  }

  recordRetrieval(results = []) {
    const now = localNow()
    const seen = new Set()
    const bumpedClassificationIds = new Set()
    for (const item of results) {
      const entityId = Number(item?.entity_id ?? item?.id)
      const dedupeKey = `${String(item?.type ?? '')}:${entityId}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      if (item.type === 'classification') {
        this.bumpClassificationRetrievalStmt.run(now, entityId)
        bumpedClassificationIds.add(entityId)
      } else if (!Number.isFinite(entityId) || entityId <= 0) {
        continue
      }
    }
    // Bump mention_count for core_memory items linked to retrieved classifications
    if (bumpedClassificationIds.size > 0) {
      try {
        const bumpCoreStmt = this.db.prepare(
          `UPDATE core_memory SET mention_count = mention_count + 1, last_mentioned_at = ? WHERE classification_id = ? AND status IN ('active', 'pending', 'demoted')`
        )
        for (const clsId of bumpedClassificationIds) {
          bumpCoreStmt.run(now, clsId)
        }
      } catch { /* core_memory table may not exist yet */ }
    }
  }

}

export function getMemoryStore(dataDir) {
  const key = resolve(dataDir)
  const existing = stores.get(key)
  if (existing) return existing
  const store = new MemoryStore(key)
  stores.set(key, store)
  return store
}
