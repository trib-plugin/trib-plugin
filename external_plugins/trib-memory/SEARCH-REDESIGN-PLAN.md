# Search Redesign Plan

## 목표
search_memories를 직관적인 파라미터와 chunk 중심 시멘틱 결과를 가진 스마트 검색 도구로 리디자인.

## 파라미터

| 파라미터 | 타입 | 설명 | 기본값 |
|----------|------|------|--------|
| `query` | string (optional) | 검색 텍스트. 생략 시 최근 항목 반환. | - |
| `period` | string (optional) | `last`, `24h`, `3d`, `7d`, `30d`, `all`, 날짜 `2026-04-05`, 범위 `2026-04-01~2026-04-05` | query 있으면 `30d`, 없으면 제한 없음 |
| `sort` | string | `date` (최신순, 리랭커 스킵) 또는 `importance` (최종 스코어순, 리랭커 실행) | period="last" → `date`, 그 외 → `importance` |
| `limit` | number | 최대 결과 수 | 20 |
| `offset` | number | 건너뛸 결과 수 | 0 |

### period 기본값 규칙
- **query 있음 + period 없음** → 기본 `30d` (성능 + 관련성)
- **query 없음 + period 없음** → 최근 20개 (limit 기준)
- **period 명시** → 해당 기간 그대로
- **period="all"** → 전체 히스토리 (제한 없음)

## 검색 단위

**Chunk가 기본 검색 및 반환 단위.**
- Chunk: LLM이 정제한 시멘틱 세그먼트. `memory_chunks` 테이블에 FTS + 벡터 검색 지원.
- Episode: 원본 대화. chunk가 부족할 때만 폴백으로 사용.

## 검색 우선순위 (스마트 폴백)

1. **Chunks** — 시멘틱 세그먼트 (최고 품질)
2. **Classifications** — 태그된 규칙, 결정, 목표, 인시던트
3. **Episodes** — 원본 대화 (폴백 전용)

### 폴백 임계값
- 시멘틱 결과 (chunks + classifications) < `ceil(limit / 2)` → 에피소드 폴백 실행
- 에피소드는 남은 슬롯만큼 채움

### 스코어링
- Chunk 결과는 에피소드 대비 스코어링 부스트 적용
- 혼합 결과에서 chunk가 항상 상위에 노출됨

### 흐름
```
입력 (query + period + sort + limit + offset)
  → 1차: chunks + classifications 검색 (시멘틱)
  → 시멘틱 결과 >= ceil(limit/2)? → 반환
  → 부족? → 2차: episodes 검색 (폴백)
  → 병합: 시멘틱 결과 우선, 에피소드로 나머지 채움
  → offset + limit 적용
```

## 사용 예시

- `query="reranker config"` → chunk 단위 시멘틱 검색 (기본 30일)
- `query="reranker", period="all"` → 전체 히스토리에서 검색
- `period="last"` → 지난 세션 chunk 20개
- `period="24h"` → 최근 24시간
- `period="2026-04-01~2026-04-05"` → 날짜 범위
- `query="reranker", period="3d"` → 3일 내 reranker 관련
- 파라미터 없음 → 최근 chunk 20개
- `sort="importance"` → 중요도순
- `offset=20, limit=20` → 2페이지

## 마이그레이션 (깔끔한 전환)

하위 호환 없음. 옛 파라미터 제거, 호출부 일괄 수정.

| 제거 | 대체 |
|------|------|
| `session` | `period` |
| `date` | `period` |
| `sort="relevance"` | 제거 (시멘틱 검색 자체가 관련도 기반) |
| `sort="asc"` | 제거 |
| `context` | 제거 |
| `queries=[...]` (배치) | 제거 |

## TODO
- [x] session/date를 period로 통합 (범위 지정 + all 포함)
- [x] period 기본값 규칙 구현 (query 유무에 따라 30d / 제한 없음)
- [x] offset 파라미터 추가
- [x] importance 정렬 추가 (confidence + retrieval_count + 리랭커 연동)
- [x] 스마트 폴백 구현: 임계값 ceil(limit/2)
- [x] chunk 스코어링 부스트 추가 (computeFinalScore에서 chunk=1.35x, classification=1.15x)
- [x] 도구 스키마 및 description 업데이트
- [x] MCP instructions 업데이트
- [x] 옛 파라미터 제거 (session, date, context, queries, sort=relevance/asc)
- [x] sort 기본값 규칙 (period="last" → date, 그 외 → importance)
- [x] sort=date 시 리랭커 스킵, sort=importance 시 리랭커 실행
- [x] browse 모드 importance 정렬 실질적 구현
- [x] 호출부 일괄 마이그레이션
