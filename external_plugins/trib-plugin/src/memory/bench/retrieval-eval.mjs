/**
 * Retrieval Evaluation Benchmark
 *
 * Isolated test set: inserts synthetic episodes → classifies → embeds → queries → measures Hit@K, MRR
 * Usage: node retrieval-eval.mjs [--full-pipeline]
 *   --full-pipeline: run cycle1 LLM classification (slow, realistic)
 *   --reranker: enable cross-encoder reranker (bge-reranker-base)
 *   default: manual classification + embedding (fast, isolates retrieval)
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { MemoryStore } from '../lib/memory.mjs'
import { embedText, getEmbeddingModelId } from '../lib/embedding-provider.mjs'
import { cleanMemoryText } from '../lib/memory-extraction.mjs'
import { hashEmbeddingInput } from '../lib/memory-vector-utils.mjs'

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA
  || join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin')

const BENCH_TAG = '__bench__'
const BENCH_TS = '2099-01-01T00:00:00.000Z'
const BENCH_DAY = '2099-01-01'

// ── Test Dataset ──

const BENCH_SET = [
  {
    id: 'B01',
    episode: '프로젝트 커밋 포맷은 YYYY-MM-DD HH:MM + 설명이다. Claude 서명은 넣지 않는다.',
    classification: { topic: 'project rule', element: 'commit format: YYYY-MM-DD HH:MM + description, no Claude signatures', importance: 'rule' },
    queries: ['커밋 메시지 형식', 'commit format convention'],
  },
  {
    id: 'B02',
    episode: '플러그인은 ~/.claude/plugins/marketplaces/ 소스에서 편집하고 캐시는 직접 수정하지 않는다. 변경 후 버전 bump 하고 /reload-plugins로 동기화.',
    classification: { topic: 'plugin workflow', element: 'edit source in marketplaces, never edit cache. bump version + reload-plugins after changes', importance: 'rule' },
    queries: ['플러그인 수정 방법', 'how to edit plugins'],
  },
  {
    id: 'B03',
    episode: 'memory_candidates 테이블을 제거했다. 에피소드에 classified 플래그를 추가하고 Cycle1이 직접 episodes[classified=0]에서 읽는다.',
    classification: { topic: 'memory architecture', element: 'removed memory_candidates table, added classified flag to episodes, Cycle1 reads directly from unclassified episodes', importance: 'fact' },
    queries: ['메모리 파이프라인 구조 변경', 'candidate table removal'],
  },
  {
    id: 'B04',
    episode: '임베딩은 classification에만 건다. episode 원본에는 임베딩하지 않는다. 검색은 classification 벡터 우선, episode FTS 폴백.',
    classification: { topic: 'embedding strategy', element: 'embed classifications only, not raw episodes. search: classification vectors first, episode FTS fallback', importance: 'fact' },
    queries: ['임베딩 대상', 'what gets embedded'],
  },
  {
    id: 'B05',
    episode: 'BGE-M3 모델을 ONNX로 로컬 실행. q8 양자화, 4 intra-op 스레드. CPU 부하의 주원인.',
    classification: { topic: 'embedding model', element: 'BGE-M3 via ONNX local, q8 quantization, 4 intra-op threads', importance: 'fact' },
    queries: ['로컬 임베딩 모델 사양', 'ONNX embedding config'],
  },
  {
    id: 'B06',
    episode: 'transcript offset을 memory_meta 테이블에 영속화한다. 세션 재시작 시 중복 ingest를 방지.',
    classification: { topic: 'memory bugfix', element: 'transcript offsets persisted to memory_meta DB, prevents duplicate ingest on restart', importance: 'fact' },
    queries: ['세션 재시작 중복 방지', 'offset persistence'],
  },
  {
    id: 'B07',
    episode: '작업 흐름은 Plan → Execute → Verify → Ship → Retro. 실제 작업에만 적용하고, Q&A나 대화에서는 phase를 언급하지 않는다.',
    classification: { topic: 'workflow', element: 'Plan → Execute → Verify → Ship → Retro cycle. applies to actual work only, silent about phase in Q&A', importance: 'rule' },
    queries: ['작업 프로세스 순서', 'development workflow phases'],
  },
  {
    id: 'B08',
    episode: '팀은 세션마다 main-<random4hex> 이름으로 새로 생성한다. 에이전트는 세션과 함께 종료되므로 stale member 방지.',
    classification: { topic: 'team management', element: 'session-unique team name main-<random4hex>, agents die with session to prevent stale members', importance: 'rule' },
    queries: ['팀 네이밍 규칙', 'session team naming'],
  },
  {
    id: 'B09',
    episode: 'reranker는 Xenova/bge-reranker-base 모델이 코드에 구현되어 있지만 현재 비활성화 상태 (features.reranker: false).',
    classification: { topic: 'reranker status', element: 'bge-reranker-base implemented but disabled (features.reranker: false)', importance: 'fact' },
    queries: ['reranker 활성화 여부', 'cross-encoder reranker status'],
  },
  {
    id: 'B10',
    episode: 'RRF (Reciprocal Rank Fusion) 합산이 이미 구현되어 있다. score = 1/(k+rank_sparse) + 1/(k+rank_dense), k=60.',
    classification: { topic: 'search algorithm', element: 'RRF hybrid search implemented: score = 1/(k+rank_sparse) + 1/(k+rank_dense), k=60', importance: 'fact' },
    queries: ['하이브리드 검색 알고리즘', 'reciprocal rank fusion'],
  },
  {
    id: 'B11',
    episode: '시간 감쇠 함수: decay = 1 / (1 + ageDays/30)^0.3. 오래된 메모리의 relevance를 점진적으로 낮춘다.',
    classification: { topic: 'time decay', element: 'decay formula: 1/(1+ageDays/30)^0.3, gradually reduces old memory relevance', importance: 'fact' },
    queries: ['메모리 시간 감쇠', 'time decay formula'],
  },
  {
    id: 'B12',
    episode: 'Bridge 에이전트는 thin pipe. haiku에서 실행되고 외부 LLM으로 포워딩만 한다. 세션 ID를 :bridge_<role>_<hash>로 명시해야 한다.',
    classification: { topic: 'bridge agent', element: 'Bridge agents are thin pipes on haiku, forward to external LLM. explicit session id: :bridge_<role>_<hash>', importance: 'rule' },
    queries: ['브릿지 에이전트 사용법', 'bridge agent pattern'],
  },
  {
    id: 'B13',
    episode: '검색은 search 도구를 사용한다. WebSearch/WebFetch는 사용하지 않는다. 2개 이상 조회 시 batch 사용.',
    classification: { topic: 'search rule', element: 'use search tool for external info, not WebSearch/WebFetch. use batch for 2+ lookups', importance: 'rule' },
    queries: ['외부 검색 방법', 'web search tool preference'],
  },
  {
    id: 'B14',
    episode: '모든 .md 파일은 영어로 작성한다. 한국어 금지. 대화 답변만 한국어로.',
    classification: { topic: 'writing rule', element: 'all .md files in English, no Korean. conversation replies in Korean', importance: 'rule' },
    queries: ['마크다운 언어 규칙', 'documentation language policy'],
  },
  {
    id: 'B15',
    episode: 'Cycle1은 10분 간격, 배치 50개. Cycle2는 매일 03:00. 둘 다 gpt-5.4-mini preset 사용.',
    classification: { topic: 'memory cycle config', element: 'cycle1: 10m interval, batch 50. cycle2: daily 03:00. both use gpt-5.4-mini', importance: 'fact' },
    queries: ['메모리 사이클 설정값', 'cycle interval configuration'],
  },

  // ── Real-world patterns: typos, slang, vague, cross-language ──

  {
    id: 'B16',
    episode: '코드 변경 전 반드시 유저 승인을 받아야 한다. 빌드/푸시/배포도 명시적 요청 없이 하지 않는다.',
    classification: { topic: 'non-negotiable rule', element: 'no code changes before user approval, no build/push/deploy without explicit request', importance: 'rule' },
    queries: [
      '코드수정전에뭐해야되',        // no spaces, casual
      '승인없이 커밋해도돼?',         // question form
      'when can I push code',         // English indirect
    ],
  },
  {
    id: 'B17',
    episode: '재영님은 박재영이다. 공손하고 따뜻한 어투를 사용하고, 존댓말로 대화한다. 단답하지 않는다.',
    classification: { topic: 'user identity & tone', element: 'user is 박재영 (재영님). warm polite tone, 존댓말, no terse replies', importance: 'preference' },
    queries: [
      '유저이름이뭐야',              // casual typo-style
      '말투 규칙',                    // very short
      'how should I address the user', // English
    ],
  },
  {
    id: 'B18',
    episode: 'GamerScroll 또는 AIScroll 관련 작업은 GamerScroll/GAMERSCROLL.md를 먼저 읽어야 한다.',
    classification: { topic: 'project guide', element: 'GamerScroll/AIScroll tasks require reading GamerScroll/GAMERSCROLL.md first', importance: 'rule' },
    queries: [
      '겜스크롤 작업할때 뭐부터',     // slang abbreviation
      'AIScroll 가이드',
      '프로젝트별 가이드 문서',
    ],
  },
  {
    id: 'B19',
    episode: 'Worker 결과물은 반드시 Read로 검증해야 한다. lead가 직접 작업하지 않고, 팀을 통해 실행한다.',
    classification: { topic: 'lead duties', element: 'lead must Read-verify every worker output, never execute task work directly', importance: 'rule' },
    queries: [
      '워커가 한거 어떻게확인해',     // casual
      'lead responsibilities',
      '리드가 직접코딩해도되나',       // negation query
    ],
  },
  {
    id: 'B20',
    episode: 'stand-down 메시지를 보낸 후 바로 새 작업을 보내면 메시지가 충돌한다. 새 작업 메시지에 "Previous stand-down retracted" 명시 필요.',
    classification: { topic: 'message discipline', element: 'after stand-down, new task must explicitly retract it ("Previous stand-down retracted") to avoid message conflict', importance: 'rule' },
    queries: [
      '워커한테 작업취소했다가 다시시킬때',
      'message ordering conflict',
      'stand-down 철회',
    ],
  },
  {
    id: 'B21',
    episode: '메모리 검색은 search_memories를 쓴다. period "last"로 직전 세션, "24h"/"7d" 등 상대 기간, "all"로 전체 검색.',
    classification: { topic: 'memory retrieval', element: 'search_memories for past context. period: "last" (prev session), "24h"/"7d" relative, "all" unlimited', importance: 'fact' },
    queries: [
      '지난세션 기억 어떻게불러와',   // natural question
      'memory search period options',
      '과거대화 검색방법',
    ],
  },
  {
    id: 'B22',
    episode: 'opus-max는 worker용 opus 프리셋이고, GPT5.4는 bridge용 프리셋이다. worker는 Worker 타입, bridge는 Bridge 타입으로 spawn한다.',
    classification: { topic: 'model presets', element: 'opus-max: worker/opus preset. GPT5.4: bridge preset. spawn with Worker type for workers, Bridge type for bridges', importance: 'fact' },
    queries: [
      '오푸스맥스가 뭐야',            // Korean phonetic
      'which preset for debugging',   // indirect (debugger → GPT5.4)
      '모델 프리셋 목록',
    ],
  },
  {
    id: 'B23',
    episode: 'webhook receiver가 활성화되어 있다. 들어오는 webhook 이벤트를 지시대로 처리한다.',
    classification: { topic: 'automation', element: 'webhook receiver active, process incoming webhook events as instructed', importance: 'fact' },
    queries: [
      '웹훅 수신 설정',
      'incoming webhook handling',
      '자동화 기능 뭐있어',           // vague
    ],
  },
  {
    id: 'B24',
    episode: '스케줄은 대화처럼 자연스럽게 한다. execute 모드(idle)에서는 바로 실행, ask-first 모드(active)에서는 자연스럽게 제안. 거부 시 30분 defer 또는 skip_today.',
    classification: { topic: 'schedule behavior', element: 'schedule is conversational. execute mode: start immediately. ask-first mode: suggest naturally. rejection: defer 30min or skip_today', importance: 'rule' },
    queries: [
      '스케줄 실행 방식',
      '예약작업 거부하면 어떻게돼',    // follow-up style
      'scheduled task rejection handling',
    ],
  },
  {
    id: 'B25',
    episode: '대규모 작업은 worker를 최대 3명 병렬로 올린다. worker, worker-2, worker-3. 3명 초과는 lead 컨텍스트 부담으로 비효율.',
    classification: { topic: 'parallel workers', element: 'large tasks: up to 3 parallel workers (worker, worker-2, worker-3). more than 3 is counterproductive due to lead context overhead', importance: 'rule' },
    queries: [
      '워커 몇명까지돼',              // very casual
      'parallel agent limit',
      '큰작업 어떻게분배해',
    ],
  },
]

// ── Evaluation Logic ──

function calcMetrics(results) {
  let hit1 = 0, hit5 = 0, rrSum = 0
  const details = []

  for (const r of results) {
    const rank = r.rank // 0 = not found, 1-based otherwise
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

// ── Main ──

async function run() {
  const startTime = Date.now()
  const fullPipeline = process.argv.includes('--full-pipeline')
  const useReranker = process.argv.includes('--reranker')

  process.stderr.write(`[bench] starting retrieval eval (${fullPipeline ? 'full-pipeline' : 'manual-classify'}, reranker=${useReranker})\n`)

  // 1. Init store
  const store = new MemoryStore(DATA_DIR)
  const model = getEmbeddingModelId()
  const insertedEpisodeIds = []
  const insertedClassificationIds = []

  try {
    // 2. Insert bench episodes
    for (const item of BENCH_SET) {
      const sourceRef = `${BENCH_TAG}${item.id}`
      // Clean up any previous bench data with same source_ref
      store.db.prepare(`DELETE FROM episodes WHERE source_ref = ?`).run(sourceRef)

      // Insert directly to control day_key (appendEpisode computes day_key from ts)
      store.insertEpisodeStmt.run(
        BENCH_TS, BENCH_DAY, 'bench', null, null, null, null,
        'assistant', 'message', item.episode, sourceRef,
      )
      const episodeId = store.getEpisodeBySourceStmt.get(sourceRef)?.id
      if (!episodeId) { process.stderr.write(`[bench] failed to insert ${item.id}\n`); continue }
      try { store.insertEpisodeFtsStmt.run(episodeId, item.episode) } catch {}
      insertedEpisodeIds.push(episodeId)

      if (!fullPipeline) {
        // Manual classification
        const cls = item.classification
        store.upsertClassificationStmt.run(
          episodeId,
          new Date().toISOString(),
          BENCH_DAY,
          cls.topic,
          cls.topic,
          cls.element,
          null, // state
          cls.importance,
          '[]', // chunks
          0.9, // confidence
        )

        // Get classification id
        const clsRow = store.db.prepare(
          `SELECT id FROM classifications WHERE episode_id = ? ORDER BY id DESC LIMIT 1`
        ).get(episodeId)
        if (clsRow) {
          insertedClassificationIds.push(clsRow.id)

          // Generate embedding for classification
          const embedContent = `${cls.topic} | ${cls.element}`
          const vector = await embedText(embedContent.slice(0, 768))
          if (Array.isArray(vector) && vector.length > 0) {
            const contentHash = hashEmbeddingInput(embedContent)
            store.upsertVectorStmt.run('classification', clsRow.id, model, vector.length, JSON.stringify(vector), contentHash)
            store._syncToVecTable('classification', clsRow.id, vector)
          }
        }

        // Mark episode as classified
        store.db.prepare(`UPDATE episodes SET classified = 1 WHERE id = ?`).run(episodeId)
      }
    }

    process.stderr.write(`[bench] inserted ${insertedEpisodeIds.length} episodes\n`)

    if (fullPipeline) {
      process.stderr.write(`[bench] running cycle1 for classification...\n`)
      const { runCycle1 } = await import('../lib/memory-cycle.mjs')
      await runCycle1(process.cwd(), null, { maxItems: 50, maxAgeDays: 365 })
      process.stderr.write(`[bench] cycle1 complete\n`)
    }

    // 3. Run queries and measure (full hybrid pipeline: sparse + dense + RRF + optional reranker)
    const allResults = []

    for (const item of BENCH_SET) {
      for (const query of item.queries) {
        let queryVector = null
        try { queryVector = await embedText(query.slice(0, 768)) } catch {}

        const tuningOverride = useReranker
          ? { reranker: { enabled: true, overFetch: 15 } }
          : undefined
        const results = await store.searchRelevantHybrid(query, 10, {
          temporal: { start: BENCH_DAY, end: BENCH_DAY },
          queryVector,
          skipReranker: !useReranker,
          tuning: tuningOverride,
          recordRetrieval: false,
        })

        // Find rank by matching episode_id or source_ref
        const expectedSourceRef = `${BENCH_TAG}${item.id}`
        const expectedEpisodeId = insertedEpisodeIds[BENCH_SET.indexOf(item)]
        let rank = 0
        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          const epId = Number(r.entity_id ?? r.episode_id ?? 0)
          if (r.source_ref === expectedSourceRef || epId === expectedEpisodeId) {
            rank = i + 1
            break
          }
        }

        allResults.push({ id: item.id, query, rank })
      }
    }

    // 4. Calculate metrics
    const metrics = calcMetrics(allResults)

    // 5. Print report
    console.log('\n══════════════════════════════════════════')
    console.log('  Retrieval Evaluation Report')
    console.log('══════════════════════════════════════════')
    console.log(`  Dataset:   ${BENCH_SET.length} items, ${allResults.length} queries`)
    console.log(`  Mode:      ${fullPipeline ? 'full-pipeline' : 'manual-classify'}`)
    console.log(`  Reranker:  ${useReranker ? 'ON' : 'OFF'}`)
    console.log(`  Model:     ${model}`)
    console.log('──────────────────────────────────────────')
    console.log(`  Hit@1:     ${metrics.hit_at_1}`)
    console.log(`  Hit@5:     ${metrics.hit_at_5}`)
    console.log(`  MRR:       ${metrics.mrr}`)
    console.log('──────────────────────────────────────────')
    console.log('  Detail:')
    for (const d of metrics.details) {
      const status = d.rank === 1 ? '✓' : d.rank > 0 ? `@${d.rank}` : '✗'
      console.log(`    ${d.id} [${status}] ${d.query}`)
    }
    console.log('──────────────────────────────────────────')
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`  Time:      ${elapsed}s`)
    console.log('══════════════════════════════════════════\n')

    return metrics

  } finally {
    // 6. Cleanup bench data
    process.stderr.write(`[bench] cleaning up...\n`)
    for (const id of insertedClassificationIds) {
      store.db.prepare(`DELETE FROM classifications WHERE id = ?`).run(id)
      store.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'classification' AND entity_id = ?`).run(id)
      try { store._removeFromVecTable('classification', id) } catch {}
    }
    for (const id of insertedEpisodeIds) {
      store.db.prepare(`DELETE FROM episodes WHERE id = ?`).run(id)
      try { store.db.prepare(`DELETE FROM episodes_fts WHERE rowid = ?`).run(id) } catch {}
    }
    process.stderr.write(`[bench] cleanup done\n`)
  }
}

run().catch(e => {
  console.error('Bench failed:', e.message)
  process.exit(1)
})
