# trib-memory

`trib-memory`는 장기 메모리를 위한 MCP 플러그인입니다.  
핵심은 `raw episode 저장 -> cycle1 구조화 -> passive hint 주입 -> explicit recall` 흐름입니다.

## 핵심 구성

- `lib/memory.mjs`
  메모리 저장/검색 본체
- `lib/memory-cycle.mjs`
  cycle1/2/3 관리
- `lib/memory-candidate-utils.mjs`
  candidate 생성/정렬
- `lib/memory-query-cues.mjs`
  질의 cue 판정
- `services/memory-service.mjs`
  MCP/HTTP 진입점

## 현재 방향

- embedding 기본값은 local `bge-m3`
- benchmark/inspect도 동일하게 local-first
- retrieval 튜닝은 `candidate -> combined -> exact -> verified -> final` 단계 기준
- cycle1은 별도 benchmark/tune loop로 관리
- live 운영은 `memory.runtime.startup` / `memory.runtime.scheduler` 설정으로 startup backfill, cycle catch-up, embedding catch-up, 주기 체크를 제어합니다.

## 운영 사이클 설정

`config.json`의 `memory.runtime` 아래에서 다음을 조절할 수 있습니다.

- `startup.backfill`
  - `mode`: `if-empty | always | off`
  - `window`: `none | 7d | 30d | all`
  - `scope`: `workspace | all`
  - `limit`: 읽을 transcript 파일 수
- `startup.embeddings`
  - `mode`: `off | light | full`
  - `warmup`: 시작 시 warmup 여부
  - `perTypeLimit`, `fullPerTypeLimit`
- `startup.cycle1CatchUp`, `startup.cycle2CatchUp`
  - `mode`: `off | light | full`
  - `delayMs`
- `scheduler.checkIntervalMs`
  - 주기 체크 간격

`memory.cycle1`, `memory.cycle2` 아래에서는 실행 비용을 더 줄일 수 있습니다.

- `cycle1.maxCandidatesPerBatch`, `cycle1.maxBatches`
- `cycle1.embeddingRefresh.perTypeLimit`, `cycle1.embeddingRefresh.contextualizeItems`
- `cycle2.maxDays`
- `cycle2.embeddingRefresh.perTypeLimit`, `cycle2.embeddingRefresh.contextualizeItems`

기본값은 기존 동작을 크게 바꾸지 않도록 잡혀 있습니다.

## 주요 스크립트

### Retrieval benchmark

```bash
node /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/benchmark-recall.mjs \
  --data-dir /Users/jyp/.claude/plugins/data/trib-memory-tribgames \
  --cases-file /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/benchmarks/tribgames-merged-cases.jsonl \
  --top-k 3 \
  --format compact \
  --refresh-copy
```

### Retrieval inspect

```bash
node /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/inspect-recall.mjs \
  --data-dir /Users/jyp/.claude/plugins/data/trib-memory-tribgames \
  --queries "현재 작업||메모리 저장 구조" \
  --timerange 2026-04-01 \
  --until-stage final \
  --format compact \
  --refresh-copy
```

### Retrieval tune loop

```bash
node /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/tune-benchmark-loop.mjs \
  --data-dir /Users/jyp/.claude/plugins/data/trib-memory-tribgames \
  --max-iterations 20 \
  --patience 4
```

### Cycle1 benchmark

```bash
node /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/cycle1-benchmark.mjs \
  --cases-file /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/benchmarks/cycle1-sample-cases.jsonl
```

### Cycle1 extended benchmark

```bash
node /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/cycle1-benchmark.mjs \
  --cases-file /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/benchmarks/cycle1-extended-cases.jsonl
```

### Cycle1 tune loop

```bash
node /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/cycle1-tune-loop.mjs \
  --cases-file /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/benchmarks/cycle1-sample-cases.jsonl \
  --max-iterations 10 \
  --patience 3
```

### Reranker latency compare

```bash
node /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/measure-reranker-latency.mjs \
  --models Xenova/bge-reranker-large \
  --pairs-file /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/benchmarks/reranker-latency-sample.jsonl
```

## benchmark 세트

- `scripts/benchmarks/tribgames-starter-cases.jsonl`
- `scripts/benchmarks/tribgames-extended-cases.jsonl`
- `scripts/benchmarks/tribgames-2026-03-31-cases.jsonl`
- `scripts/benchmarks/tribgames-merged-cases.jsonl`
- `scripts/benchmarks/cycle1-sample-cases.jsonl`
- `scripts/benchmarks/cycle1-extended-cases.jsonl`
- `scripts/benchmarks/reranker-latency-sample.jsonl`

## 참고 문서

- 구조 설명: [RAG-INJECTION.md](./RAG-INJECTION.md)
- 튜닝 플레이북: [scripts/TUNING-PLAYBOOK.md](./scripts/TUNING-PLAYBOOK.md)

## 메모

- `node_modules`, `scripts/results`, `services/__pycache__`는 커밋 대상이 아닙니다.
- benchmark/loop는 실사용과 최대한 같은 플로우를 유지하되, local-first로 실행합니다.
