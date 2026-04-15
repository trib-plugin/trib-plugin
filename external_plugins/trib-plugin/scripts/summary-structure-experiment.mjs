#!/usr/bin/env node
/**
 * Summary sentence-structure experiment.
 * Same entries, 10 different structure specs in the prompt rule.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { callLLM, resolveMaintenancePreset } from '../src/shared/llm/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const TEMPLATE_PATH = join(ROOT, 'defaults', 'memory-chunk-prompt.md')
const baseTemplate = readFileSync(TEMPLATE_PATH, 'utf8')

const SAMPLE_ENTRIES = `- id:1001 ts:1776253100000 role:user content:사이클1이 왜 초기에 안 돌았지? 쿨타임이?
- id:1002 ts:1776253130000 role:assistant content:쿨다운 아니라 startup catch-up이 기본 off라서 그렇습니다. memory-ops-policy.mjs의 DEFAULT_OPS_POLICY.startup.cycle1CatchUp.mode='off'. 이유는 MCP 서버 기동 직후 5초 뒤 inline embedding 돌리면 사용자 입력 직후 lag 체감되어서 off로 고정. scheduler는 정상적으로 60초 주기로 체크해서 interval 도달 시 cycle1 돌림.
- id:1003 ts:1776253160000 role:user content:근데 백필은?
- id:1004 ts:1776253200000 role:assistant content:backfill도 startup 기본 off입니다. DEFAULT_OPS_POLICY.startup.backfill.mode='off'. unclassified 142개 쌓여 있는데 startup auto 처리는 안 되고, 수동으로 memory backfill action 호출하거나 Config UI에서 mode를 light/full로 바꿔야 합니다.
- id:1005 ts:1776253240000 role:user content:백필 리미트는 왜 저렇게 잡혀있지 컨피그 설정이랑 싱크 못 맞추나
- id:1006 ts:1776253280000 role:assistant content:지적 정확합니다. 두 경로가 따로 놉니다. Startup auto-backfill은 policy를 참조하지만 수동 memory backfill tool은 limit 인자만 받고 config 완전 무시. 기본값도 80 vs 100으로 불일치. v4 설계 대비 수동 경로가 window/scope 무지원.
- id:1007 ts:1776253320000 role:user content:흠 수동백필은 그냥 1일치를 한번에 가져와서 단번에 채운다 이런 의미였거든
- id:1008 ts:1776253360000 role:assistant content:원래 의도면 현재 구현이 의미론 자체가 어긋납니다. 의도: window로 시간 범위 자르고 그 안 모든 transcript 흡수. 현재 구현: limit만 받아서 mtime 역순 N개 파일 선택. 시간 개념 자체가 없음. tool 핸들러 재구성 제안: window 기반 sinceMs 필터 + scope + limit은 sanity cap으로만.`

const VARIANTS = [
  {
    name: 'S01_QADO4sent',
    rule: '`summary` MUST be exactly 4 sentences, in this order: (1) what the user asked or raised; (2) what was analyzed or confirmed; (3) what was decided or agreed; (4) the resulting outcome or next action. Each sentence ends with a period.',
  },
  {
    name: 'S02_narrative_chrono',
    rule: '`summary` is a single paragraph narrative in past tense, written in chronological order: the user\'s issue, the investigation or analysis, and the final resolution. Use connective words like "이어서", "그 결과".',
  },
  {
    name: 'S03_korean_svo_3to4',
    rule: '`summary` is 3 to 4 Korean sentences, each in clear Subject-Verb-Object past-tense form (who-did-what). No bullets, no passive voice.',
  },
  {
    name: 'S04_topic_first',
    rule: '`summary` starts with a single-sentence topic headline that mirrors `element`. The following 1-2 sentences expand the details (cause, decision, outcome).',
  },
  {
    name: 'S05_context_cause_outcome',
    rule: '`summary` is exactly 3 sentences in this fixed order: (1) context/background, (2) cause or key finding, (3) decision or outcome.',
  },
  {
    name: 'S06_concrete_actors',
    rule: '`summary` names concrete actors explicitly ("사용자", "assistant", "스케줄러" 등). Each sentence must start with or contain an actor noun. No vague nouns ("they", "it"). Keep it 2-3 sentences.',
  },
  {
    name: 'S07_reported_speech',
    rule: '`summary` is written in Korean reported speech, 1 or 2 sentences. Template: "사용자가 X를 지적/요청하자 assistant가 Y를 확인/수행했고, 그 결과 Z로 정리됐다."',
  },
  {
    name: 'S08_labeled_parts',
    rule: '`summary` is semi-structured prose with labeled parts inline: "[문제] ... [원인] ... [결정] ... [결과] ...". Each label appears once. No newlines; join parts with spaces.',
  },
  {
    name: 'S09_cause_effect_pair',
    rule: '`summary` is exactly 2 sentences: the first states the cause or observation, the second states the effect, decision, or outcome.',
  },
  {
    name: 'S10_dense_one_sentence',
    rule: '`summary` is ONE dense Korean sentence that covers who + what + why + outcome, chained with commas and connective clauses.',
  },
]

function extractJsonObject(text) {
  if (!text) return null
  const s = String(text).trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end < 0 || end <= start) return null
  const candidate = s.slice(start, end + 1)
  try { return JSON.parse(candidate) } catch {}
  const noFence = candidate.replace(/```(?:json)?/g, '').trim()
  try { return JSON.parse(noFence) } catch {}
  return null
}

function buildPrompt(variant) {
  const modified = baseTemplate.replace(
    /- `summary` is a self-contained synthesis of what the members collectively established\. Include who decided what, why, and the outcome\. 1 to 3 sentences\./,
    `- ${variant.rule}`,
  )
  return modified.replace('{{ENTRIES}}', SAMPLE_ENTRIES)
}

async function run() {
  const preset = resolveMaintenancePreset('cycle1')
  console.log(`[exp] preset=${JSON.stringify(preset).slice(0, 200)}`)

  const results = []
  for (const variant of VARIANTS) {
    process.stderr.write(`[exp] running ${variant.name}...\n`)
    const prompt = buildPrompt(variant)
    const t0 = Date.now()
    let raw = ''
    try {
      raw = await callLLM(prompt, preset, { mode: 'maintenance', timeout: 120000 })
    } catch (err) {
      results.push({ variant: variant.name, error: err.message, elapsedMs: Date.now() - t0 })
      continue
    }
    const elapsed = Date.now() - t0
    const parsed = extractJsonObject(raw)
    const chunks = Array.isArray(parsed?.chunks) ? parsed.chunks : []
    results.push({
      variant: variant.name,
      elapsedMs: elapsed,
      chunkCount: chunks.length,
      summaries: chunks.map(c => ({
        elem: String(c.element ?? ''),
        cat: String(c.category ?? ''),
        summary: String(c.summary ?? ''),
        len: String(c.summary ?? '').length,
        sentenceCount: String(c.summary ?? '').split(/[.!?。]\s*/).filter(s => s.trim()).length,
      })),
    })
  }

  console.log('\n========== RESULTS ==========')
  for (const r of results) {
    console.log(`\n--- ${r.variant} (elapsed=${r.elapsedMs}ms chunks=${r.chunkCount ?? 'err'}) ---`)
    if (r.error) { console.log(`  ERROR: ${r.error}`); continue }
    for (let i = 0; i < r.chunkCount; i++) {
      const s = r.summaries[i]
      console.log(`  [${i + 1}] cat=${s.cat} len=${s.len} sentences=${s.sentenceCount}`)
      console.log(`      elem: ${s.elem}`)
      console.log(`      summary: ${s.summary}`)
    }
  }

  console.log('\n========== STRUCTURE STATS ==========')
  console.log('variant                     chunks  avg_len  avg_sent')
  for (const r of results) {
    const lens = (r.summaries || []).map(s => s.len)
    const sents = (r.summaries || []).map(s => s.sentenceCount)
    const avgLen = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0
    const avgSent = sents.length ? (sents.reduce((a, b) => a + b, 0) / sents.length).toFixed(1) : 0
    console.log(`${r.variant.padEnd(27)} ${String(r.chunkCount ?? 0).padStart(3)}     ${String(avgLen).padStart(4)}     ${avgSent}`)
  }
}

run().catch(err => {
  process.stderr.write(`[exp] fatal: ${err.message}\n`)
  process.exit(1)
})
