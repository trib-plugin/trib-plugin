#!/usr/bin/env node
/**
 * Summary length experiment.
 * Run cycle1 chunk prompt with 10 different max-char caps against the same
 * input entries. Measures actual output length + quality per variant.
 *
 * Usage: node scripts/summary-length-experiment.mjs
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
  { name: 'v01_max80',   rule: '`summary` must be at most 80 characters total.' },
  { name: 'v02_max150',  rule: '`summary` must be at most 150 characters total.' },
  { name: 'v03_max250',  rule: '`summary` must be at most 250 characters total.' },
  { name: 'v04_max350',  rule: '`summary` must be at most 350 characters total.' },
  { name: 'v05_max500',  rule: '`summary` must be at most 500 characters total.' },
  { name: 'v06_max700',  rule: '`summary` must be at most 700 characters total.' },
  { name: 'v07_max1000', rule: '`summary` must be at most 1000 characters total.' },
  { name: 'v08_baseline_1to3sent', rule: '`summary` is a self-contained synthesis. 1 to 3 sentences.' },
  { name: 'v09_1paragraph', rule: '`summary` is a self-contained synthesis of roughly one paragraph.' },
  { name: 'v10_nolimit', rule: '`summary` is a self-contained synthesis as long as needed to capture who decided what, why, and outcome.' },
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
  const modifiedRules = baseTemplate.replace(
    /- `summary` is a self-contained synthesis of what the members collectively established\. Include who decided what, why, and the outcome\. 1 to 3 sentences\./,
    `- ${variant.rule} Include who decided what, why, and the outcome.`,
  )
  return modifiedRules.replace('{{ENTRIES}}', SAMPLE_ENTRIES)
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
    const summaries = chunks.map(c => String(c.summary ?? ''))
    const elements = chunks.map(c => String(c.element ?? ''))
    const cats = chunks.map(c => String(c.category ?? ''))
    const sumLens = summaries.map(s => s.length)
    results.push({
      variant: variant.name,
      elapsedMs: elapsed,
      chunkCount: chunks.length,
      elements,
      categories: cats,
      summaries,
      sumLens,
      rawLen: raw.length,
    })
  }

  console.log('\n========== RESULTS ==========')
  for (const r of results) {
    console.log(`\n--- ${r.variant} (elapsed=${r.elapsedMs}ms chunks=${r.chunkCount ?? 'err'}) ---`)
    if (r.error) { console.log(`  ERROR: ${r.error}`); continue }
    for (let i = 0; i < r.chunkCount; i++) {
      console.log(`  [${i + 1}] cat=${r.categories[i]} elem="${r.elements[i]}"`)
      console.log(`      sumLen=${r.sumLens[i]}  summary=${r.summaries[i]}`)
    }
  }

  console.log('\n========== LENGTH STATS ==========')
  console.log('variant               chunks  lens')
  for (const r of results) {
    const lens = r.sumLens || []
    const avg = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0
    console.log(`${r.variant.padEnd(22)} ${String(r.chunkCount ?? 0).padStart(3)}     ${lens.join(', ')}  avg=${avg}`)
  }
}

run().catch(err => {
  process.stderr.write(`[exp] fatal: ${err.message}\n`)
  process.exit(1)
})
