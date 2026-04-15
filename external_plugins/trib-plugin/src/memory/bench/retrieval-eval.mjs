/**
 * Retrieval Evaluation Benchmark (entries model).
 *
 * Isolated test set: inserts synthetic entries (role='assistant', pre-classified roots) → embeds →
 * queries → measures Hit@K, MRR.
 *
 * Usage: node retrieval-eval.mjs
 *   --use-shared-data: use production DATA_DIR (default: tmpdir sandbox)
 */

import { DatabaseSync } from 'node:sqlite'
import * as sqliteVec from 'sqlite-vec'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { mkdirSync, unlinkSync } from 'fs'
import { init as initSchema } from '../lib/memory.mjs'
import { searchRelevantHybrid } from '../lib/memory-recall-store.mjs'
import {
  embedText,
  getEmbeddingModelId,
  getEmbeddingDims,
} from '../lib/embedding-provider.mjs'
import { computeEntryScore } from '../lib/memory-score.mjs'

const _USE_SHARED = process.argv.includes('--use-shared-data')
const _SHARED_DIR = process.env.CLAUDE_PLUGIN_DATA
  || join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin')
const _BENCH_DIR = join(tmpdir(), 'trib-plugin-bench-data')
const DATA_DIR = _USE_SHARED ? _SHARED_DIR : _BENCH_DIR
if (_USE_SHARED) {
  process.stderr.write(`[bench] WARNING: using shared production DATA_DIR=${DATA_DIR}\n`)
}

const BENCH_TAG = '__bench__'

const BENCH_SET = [
  { id: 'B01',
    content: '프로젝트 커밋 포맷은 YYYY-MM-DD HH:MM + 설명이다. Claude 서명은 넣지 않는다.',
    element: 'commit format rule',
    category: 'rule',
    summary: 'Commit format: YYYY-MM-DD HH:MM + description, no Claude signatures.',
    queries: ['커밋 메시지 형식', 'commit format convention'] },
  { id: 'B02',
    content: '플러그인은 ~/.claude/plugins/marketplaces/ 소스에서 편집하고 캐시는 직접 수정하지 않는다. 변경 후 버전 bump 하고 /reload-plugins로 동기화.',
    element: 'plugin workflow rule',
    category: 'rule',
    summary: 'Edit source in marketplaces, never edit cache. Bump version + reload-plugins after changes.',
    queries: ['플러그인 수정 방법', 'how to edit plugins'] },
  { id: 'B03',
    content: '메모리 candidate 테이블을 제거하고 classified 플래그로 대체했다. Cycle1이 직접 episodes에서 읽는다.',
    element: 'memory architecture fact',
    category: 'fact',
    summary: 'Removed memory_candidates table, replaced with classified flag on episodes.',
    queries: ['메모리 파이프라인 구조 변경', 'candidate table removal'] },
  { id: 'B04',
    content: '임베딩은 classification에만 건다. episode 원본에는 임베딩하지 않는다. 검색은 classification 벡터 우선, episode FTS 폴백.',
    element: 'embedding strategy',
    category: 'fact',
    summary: 'Embed classifications only; search uses classification vectors first with episode FTS fallback.',
    queries: ['임베딩 대상', 'what gets embedded'] },
  { id: 'B05',
    content: 'BGE-M3 모델을 ONNX로 로컬 실행. q8 양자화, 4 intra-op 스레드. CPU 부하의 주원인.',
    element: 'embedding model config',
    category: 'fact',
    summary: 'BGE-M3 via ONNX local, q8 quantization, 4 intra-op threads.',
    queries: ['로컬 임베딩 모델 사양', 'ONNX embedding config'] },
  { id: 'B06',
    content: 'transcript offset을 meta 테이블에 영속화한다. 세션 재시작 시 중복 ingest를 방지.',
    element: 'transcript offset persistence',
    category: 'fact',
    summary: 'Transcript offsets persisted to meta DB; prevents duplicate ingest on restart.',
    queries: ['세션 재시작 중복 방지', 'offset persistence'] },
  { id: 'B07',
    content: '작업 흐름은 Plan → Execute → Verify → Ship → Retro. 실제 작업에만 적용하고, Q&A나 대화에서는 phase를 언급하지 않는다.',
    element: 'workflow cycle rule',
    category: 'rule',
    summary: 'Plan → Execute → Verify → Ship → Retro cycle; applies to actual work only, silent in Q&A.',
    queries: ['작업 프로세스 순서', 'development workflow phases'] },
  { id: 'B08',
    content: '팀은 세션마다 main-<random4hex> 이름으로 새로 생성한다. 에이전트는 세션과 함께 종료되므로 stale member 방지.',
    element: 'team naming rule',
    category: 'rule',
    summary: 'Session-unique team name main-<random4hex>; agents die with session to prevent stale members.',
    queries: ['팀 네이밍 규칙', 'session team naming'] },
  { id: 'B09',
    content: '메모리 청크 요약은 S05 스타일 3문장 (context/cause/outcome) 구조로 작성한다. 첫 문장은 맥락, 둘째 문장은 원인이나 핵심 발견, 셋째 문장은 결정 또는 결과를 담는다.',
    element: 'chunk summary S05 structure rule',
    category: 'rule',
    summary: 'Chunk summaries follow S05 structure: 3 sentences in fixed order — context, cause/finding, decision/outcome.',
    queries: ['청크 요약 구조', 'summary 3 sentence rule', 'S05 context cause outcome'] },
  { id: 'B10',
    content: 'RRF (Reciprocal Rank Fusion) 합산이 이미 구현되어 있다. score = 1/(k+rank_sparse) + 1/(k+rank_dense), k=60.',
    element: 'RRF hybrid search',
    category: 'fact',
    summary: 'RRF hybrid search: score = 1/(k+rank_sparse) + 1/(k+rank_dense), k=60.',
    queries: ['하이브리드 검색 알고리즘', 'reciprocal rank fusion'] },
  { id: 'B11',
    content: '시간 감쇠 함수: decay = 1 / (1 + ageDays/30)^0.3. 오래된 메모리의 relevance를 점진적으로 낮춘다.',
    element: 'time decay formula',
    category: 'fact',
    summary: 'decay = 1/(1+ageDays/30)^0.3; gradually reduces old memory relevance.',
    queries: ['메모리 시간 감쇠', 'time decay formula'] },
  { id: 'B12',
    content: 'Bridge 에이전트는 thin pipe. haiku에서 실행되고 외부 LLM으로 포워딩만 한다. 세션 ID를 :bridge_<role>_<hash>로 명시해야 한다.',
    element: 'bridge agent pattern',
    category: 'rule',
    summary: 'Bridge agents are thin pipes on haiku forwarding to external LLM; explicit session id :bridge_<role>_<hash>.',
    queries: ['브릿지 에이전트 사용법', 'bridge agent pattern'] },
  { id: 'B13',
    content: '외부 정보 조회는 search 도구를 사용한다. WebSearch/WebFetch는 사용하지 않는다. 2개 이상 조회 시 batch 사용.',
    element: 'external search tool rule',
    category: 'rule',
    summary: 'Use search tool for external info, not WebSearch/WebFetch; batch for 2+ lookups.',
    queries: ['외부 검색 방법', 'web search tool preference'] },
  { id: 'B14',
    content: '모든 .md 파일은 영어로 작성한다. 한국어 금지. 대화 답변만 한국어로.',
    element: 'writing language rule',
    category: 'rule',
    summary: 'All .md files in English, no Korean; conversation replies in Korean.',
    queries: ['마크다운 언어 규칙', 'documentation language policy'] },
  { id: 'B15',
    content: 'Cycle1은 10분 간격. Cycle2는 1시간 간격, 최대 50 candidates. 둘 다 GPT5.4 preset 사용.',
    element: 'memory cycle config',
    category: 'fact',
    summary: 'cycle1 10m interval; cycle2 1h interval with maxCandidates 50; both use GPT5.4.',
    queries: ['메모리 사이클 설정값', 'cycle interval configuration'] },
  { id: 'B16',
    content: '코드 변경 전 반드시 유저 승인을 받아야 한다. 빌드/푸시/배포도 명시적 요청 없이 하지 않는다.',
    element: 'approval required rule',
    category: 'constraint',
    summary: 'No code changes before user approval; no build/push/deploy without explicit request.',
    queries: ['코드수정전에뭐해야되', '승인없이 커밋해도돼?', 'when can I push code'] },
  { id: 'B17',
    content: '재영님은 박재영이다. 공손하고 따뜻한 어투를 사용하고, 존댓말로 대화한다. 단답하지 않는다.',
    element: 'user identity and tone',
    category: 'preference',
    summary: 'User is 박재영 (재영님); warm polite tone, 존댓말, no terse replies.',
    queries: ['유저이름이뭐야', '말투 규칙', 'how should I address the user'] },
  { id: 'B18',
    content: 'GamerScroll 또는 AIScroll 관련 작업은 GamerScroll/GAMERSCROLL.md를 먼저 읽어야 한다.',
    element: 'project guide rule',
    category: 'rule',
    summary: 'GamerScroll/AIScroll tasks require reading GamerScroll/GAMERSCROLL.md first.',
    queries: ['겜스크롤 작업할때 뭐부터', 'AIScroll 가이드', '프로젝트별 가이드 문서'] },
  { id: 'B19',
    content: 'Worker 결과물은 반드시 Read로 검증해야 한다. lead가 직접 작업하지 않고, 팀을 통해 실행한다.',
    element: 'lead verification rule',
    category: 'rule',
    summary: 'Lead must Read-verify every worker output; never execute task work directly.',
    queries: ['워커가 한거 어떻게확인해', 'lead responsibilities', '리드가 직접코딩해도되나'] },
  { id: 'B20',
    content: 'stand-down 메시지를 보낸 후 바로 새 작업을 보내면 메시지가 충돌한다. 새 작업 메시지에 Previous stand-down retracted 명시 필요.',
    element: 'stand-down retract rule',
    category: 'rule',
    summary: 'After stand-down, new task must retract it explicitly ("Previous stand-down retracted") to avoid conflict.',
    queries: ['워커한테 작업취소했다가 다시시킬때', 'message ordering conflict', 'stand-down 철회'] },
  { id: 'B21',
    content: '메모리 검색은 search_memories를 쓴다. period last로 직전 세션, 24h 또는 7d 등 상대 기간, all로 전체 검색.',
    element: 'memory retrieval options',
    category: 'fact',
    summary: 'search_memories for past context; period: "last" (prev session), "24h"/"7d" relative, "all" unlimited.',
    queries: ['지난세션 기억 어떻게불러와', 'memory search period options', '과거대화 검색방법'] },
  { id: 'B22',
    content: 'opus-max는 worker용 opus 프리셋이고, GPT5.4는 bridge용 프리셋이다. worker는 Worker 타입, bridge는 Bridge 타입으로 spawn한다.',
    element: 'model presets',
    category: 'fact',
    summary: 'opus-max: worker/opus preset. GPT5.4: bridge preset. Spawn Worker for workers, Bridge for bridges.',
    queries: ['오푸스맥스가 뭐야', 'which preset for debugging', '모델 프리셋 목록'] },
  { id: 'B23',
    content: 'webhook receiver가 활성화되어 있다. 들어오는 webhook 이벤트를 지시대로 처리한다.',
    element: 'webhook receiver active',
    category: 'fact',
    summary: 'Webhook receiver active; process incoming webhook events as instructed.',
    queries: ['웹훅 수신 설정', 'incoming webhook handling', '자동화 기능 뭐있어'] },
  { id: 'B24',
    content: '스케줄은 대화처럼 자연스럽게 한다. execute 모드(idle)에서는 바로 실행, ask-first 모드(active)에서는 자연스럽게 제안. 거부 시 30분 defer 또는 skip_today.',
    element: 'schedule behavior rule',
    category: 'rule',
    summary: 'Schedule is conversational. Execute mode: start immediately. Ask-first: suggest naturally. Rejection: defer 30min or skip_today.',
    queries: ['스케줄 실행 방식', '예약작업 거부하면 어떻게돼', 'scheduled task rejection handling'] },
  { id: 'B25',
    content: '대규모 작업은 worker를 최대 3명 병렬로 올린다. worker, worker-2, worker-3. 3명 초과는 lead 컨텍스트 부담으로 비효율.',
    element: 'parallel worker limit',
    category: 'rule',
    summary: 'Large tasks: up to 3 parallel workers (worker, worker-2, worker-3); more is counterproductive.',
    queries: ['워커 몇명까지돼', 'parallel agent limit', '큰작업 어떻게분배해'] },
]

function calcMetrics(results) {
  let hit1 = 0, hit5 = 0, rrSum = 0
  const details = []
  for (const r of results) {
    const rank = r.rank
    const h1 = rank === 1 ? 1 : 0
    const h5 = rank >= 1 && rank <= 5 ? 1 : 0
    const rr = rank > 0 ? 1 / rank : 0
    hit1 += h1
    hit5 += h5
    rrSum += rr
    details.push({ id: r.id, query: r.query, rank, h1, h5, rr: rr.toFixed(3) })
  }
  const n = results.length
  return {
    n,
    hit_at_1: (hit1 / n).toFixed(3),
    hit_at_5: (hit5 / n).toFixed(3),
    mrr: (rrSum / n).toFixed(3),
    details,
  }
}

function openBenchDb() {
  mkdirSync(DATA_DIR, { recursive: true })
  const dbPath = join(DATA_DIR, 'memory.sqlite')
  if (!_USE_SHARED) { try { unlinkSync(dbPath) } catch {} }
  const db = new DatabaseSync(dbPath, { allowExtension: true })
  sqliteVec.load(db)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  const dims = Number(getEmbeddingDims())
  const needInit = !db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='entries'`).get()
  if (needInit) initSchema(db, dims)
  return db
}

async function run() {
  const startTime = Date.now()
  process.stderr.write(`[bench] starting retrieval eval\n`)

  const db = openBenchDb()
  const model = getEmbeddingModelId()
  const insertedIds = []

  try {
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO entries(ts, role, content, source_ref, session_id)
      VALUES (?, 'assistant', ?, ?, NULL)
    `)
    const promoteStmt = db.prepare(`
      UPDATE entries
      SET chunk_root = ?, is_root = 1, element = ?, category = ?, summary = ?,
          status = 'active', score = ?, last_seen_at = ?, embedding = ?, summary_hash = ?
      WHERE id = ?
    `)

    const baseTs = Date.now() - 1000
    let idx = 0
    for (const item of BENCH_SET) {
      const sourceRef = `${BENCH_TAG}${item.id}`
      try { db.prepare(`DELETE FROM entries WHERE source_ref = ?`).run(sourceRef) } catch {}

      const ts = baseTs + idx++
      insertStmt.run(ts, item.content, sourceRef)
      const row = db.prepare(`SELECT id FROM entries WHERE source_ref = ?`).get(sourceRef)
      if (!row) { process.stderr.write(`[bench] failed to insert ${item.id}\n`); continue }
      const entryId = Number(row.id)

      let vector = null
      try { vector = await embedText((item.summary || item.element).slice(0, 768)) } catch {}

      let embeddingBlob = null
      if (Array.isArray(vector) && vector.length > 0) {
        embeddingBlob = Buffer.alloc(vector.length * 4)
        for (let i = 0; i < vector.length; i++) embeddingBlob.writeFloatLE(vector[i], i * 4)
      }

      const score = computeEntryScore(item.category, ts, ts)
      db.exec('BEGIN')
      try {
        promoteStmt.run(entryId, item.element, item.category, item.summary, score, ts, embeddingBlob, null, entryId)
        if (embeddingBlob) {
          db.prepare(`INSERT OR REPLACE INTO vec_entries(rowid, embedding) VALUES (?, ?)`)
            .run(BigInt(entryId), embeddingBlob)
        }
        db.exec('COMMIT')
      } catch (e) {
        try { db.exec('ROLLBACK') } catch {}
        process.stderr.write(`[bench] promote failed for ${item.id}: ${e.message}\n`)
        continue
      }
      insertedIds.push(entryId)
    }
    process.stderr.write(`[bench] inserted ${insertedIds.length} entries\n`)

    const allResults = []
    for (const item of BENCH_SET) {
      const expectedSourceRef = `${BENCH_TAG}${item.id}`
      const expectedEntryId = insertedIds[BENCH_SET.indexOf(item)]
      for (const query of item.queries) {
        let queryVector = null
        try { queryVector = await embedText(query.slice(0, 768)) } catch {}
        const results = await searchRelevantHybrid(db, query, {
          limit: 10,
          queryVector,
          writeBackMemberHits: false,
        })

        let rank = 0
        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          if (Number(r.id) === expectedEntryId) { rank = i + 1; break }
          // Also match by source_ref when available (root always has source_ref from insert)
          const rSourceRow = db.prepare(`SELECT source_ref FROM entries WHERE id = ?`).get(r.id)
          if (rSourceRow?.source_ref === expectedSourceRef) { rank = i + 1; break }
        }
        allResults.push({ id: item.id, query, rank })
      }
    }

    const metrics = calcMetrics(allResults)

    console.log('\n══════════════════════════════════════════')
    console.log('  Retrieval Evaluation Report')
    console.log('══════════════════════════════════════════')
    console.log(`  Dataset:   ${BENCH_SET.length} items, ${allResults.length} queries`)
    console.log(`  Model:     ${model}`)
    console.log('──────────────────────────────────────────')
    console.log(`  Hit@1:     ${metrics.hit_at_1}`)
    console.log(`  Hit@5:     ${metrics.hit_at_5}`)
    console.log(`  MRR:       ${metrics.mrr}`)
    console.log('──────────────────────────────────────────')
    console.log('  Detail:')
    for (const d of metrics.details) {
      const status = d.rank === 1 ? 'OK' : d.rank > 0 ? `@${d.rank}` : 'MISS'
      console.log(`    ${d.id} [${status}] ${d.query}`)
    }
    console.log('──────────────────────────────────────────')
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`  Time:      ${elapsed}s`)
    console.log('══════════════════════════════════════════\n')

    return metrics
  } finally {
    process.stderr.write(`[bench] cleaning up...\n`)
    for (const id of insertedIds) {
      try { db.prepare(`DELETE FROM entries WHERE id = ?`).run(id) } catch {}
    }
    try { db.close() } catch {}
    process.stderr.write(`[bench] cleanup done\n`)
  }
}

async function main() {
  await run()
}

const _invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false
    return import.meta.url === pathToFileURL(process.argv[1]).href
  } catch { return false }
})()
if (_invokedDirectly) {
  main().catch(e => {
    console.error('Bench failed:', e.message)
    process.exit(1)
  })
}
