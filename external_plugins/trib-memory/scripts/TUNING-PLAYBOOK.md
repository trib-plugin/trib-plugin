# Trib Memory Tuning Playbook

이 문서는 `trib-memory` 리콜 튜닝을 다른 에이전트가 이어서 진행할 때 기준점으로 사용합니다.

## 목표

- 실사용에 가까운 최종 리콜(`final`) 성능을 유지합니다.
- `candidate` 단계 품질을 올립니다.
- 같은 케이스셋에 과적합하지 않도록 날짜/도메인을 넓히며 검증합니다.

## 현재 기준점

2026-04-02 기준 대표 벤치:

- `tribgames-merged-cases.jsonl` 40-case
  - `candidates`: `hit@1=62.5`, `hit@3=82.5`, `mrr=0.750`
  - `final`: `hit@1=97.5`, `hit@3=100.0`, `mrr=0.983`

참고:

- `tribgames-extended-cases.jsonl` 20-case
- `tribgames-2026-03-31-cases.jsonl` 20-case

## 우선순위

1. `final` 성능 유지
2. `candidate` 성능 개선
3. 더 넓은 케이스셋 확보

`final`이 떨어지는 수정은 채택하지 않습니다.

## 주요 파일

- 검색/리콜 본체: `lib/memory.mjs`
- 랭킹 보정: `lib/memory-ranking-utils.mjs`
- query variant: `lib/memory-text-utils.mjs`
- 단건 확인: `scripts/inspect-recall.mjs`
- 벤치 실행: `scripts/benchmark-recall.mjs`
- 반복 실행: `scripts/tune-benchmark-loop.mjs`

## 작업 방식

한 번에 하나만 바꿉니다.

1. 벤치 baseline 실행
2. candidate miss 패턴 확인
3. 작은 수정 1개 적용
4. merged benchmark 재실행
5. `final`이 유지/개선되면 채택
6. `final`이 하락하면 즉시 되돌림

추천 수정 범위:

- candidate ordering
- seed lane bias
- query variant expansion
- task/history/decision intent-aware boost

비추천:

- 같은 케이스셋에 맞춘 과한 규칙 추가
- `final`을 희생하면서 `candidate`만 올리는 수정
- 자동 코드 수정 루프

## 속도/운영 기준

- 벤치와 inspect는 기본적으로 local `bge-m3`를 사용합니다.
- ML service는 기본 후순위가 아니라 opt-in이어야 합니다.
- `--refresh-copy`로 tmp mirror를 사용합니다.
- cycle/catch-up과 interactive path는 분리해서 생각합니다.

## 반복 실행

한 번 실행:

```bash
node /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/benchmark-recall.mjs \
  --data-dir /Users/jyp/.claude/plugins/data/trib-memory-tribgames \
  --cases-file /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/benchmarks/tribgames-merged-cases.jsonl \
  --top-k 3 \
  --format compact \
  --refresh-copy
```

루프 실행:

```bash
node /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/tune-benchmark-loop.mjs \
  --data-dir /Users/jyp/.claude/plugins/data/trib-memory-tribgames \
  --max-iterations 20 \
  --patience 4
```

Cycle1 benchmark:

```bash
node /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/cycle1-benchmark.mjs \
  --cases-file /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/benchmarks/cycle1-sample-cases.jsonl
```

Cycle1 loop:

```bash
node /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/cycle1-tune-loop.mjs \
  --cases-file /Users/jyp/Project/trib-plugins/external_plugins/trib-memory/scripts/benchmarks/cycle1-sample-cases.jsonl \
  --max-iterations 10 \
  --patience 3
```

## 종료 기준

다음 중 하나면 종료합니다.

- 3~5회 연속 유의미한 개선 없음
- `final` 지표가 흔들리기 시작함
- merged 40-case와 날짜별 세트 모두에서 안정적인 값 확인

## 마무리 산출물

- 최종 benchmark 수치
- best iteration 결과 파일
- 남은 hard miss 목록
- 다음 우선순위 2~3개
