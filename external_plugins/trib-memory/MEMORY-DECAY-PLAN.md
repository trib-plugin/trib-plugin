# Memory Decay & Importance Plan

## Overview

Memory decay is not uniform. Some memories should persist indefinitely (rules, decisions),
while others fade naturally (one-off questions, resolved incidents).

This plan defines how trib-memory determines what to remember and how long.

## Tags

cycle1 outputs importance tags alongside topic/element/state.
Tags describe the **nature of the memory**, not its emotional content.

### Tag Definitions

| Tag | Meaning | Examples |
|-----|---------|---------|
| rule | Policy, constraint, prohibition | "절대 -p 쓰지 마", "커밋에 Claude 서명 금지" |
| directive | Strong user request, command, emphasis | "무조건 이렇게 가자", "이건 꼭 기억해" |
| decision | Agreement, confirmed direction | "3필드로 간다", "올라마 디폴트로" |
| preference | Taste, style, personal choice | "재영님으로 불러줘", "존댓말 써" |
| incident | Something that happened, outage, change | "디스코드 메시지 안 옴", "서비스 SIGKILL" |
| interest | Tracked topic, recurring across sessions | Determined by day_count, not LLM |
| transient | One-off question, confirmation, check | "이거 맞아?", "확인해봐" |

### Tag Properties

**Long-term (no decay, supersede only):**
- rule, directive, decision, preference

**Short-term (power-law decay):**
- incident: halfLife 60 days
- interest: halfLife 45 days (boosted by day_count)
- transient: halfLife 7 days

## Decay Model

### Power-Law Curve

```
time_factor = max(floor, 1 / (1 + age / halfLife) ^ alpha)
```

- alpha: 0.3 (gentle slope)
- floor: 0.2 (never fully forgotten in search)

### Long-Term Override

If any tag is long-term (rule/directive/decision/preference):
- time_factor = 1.0 always
- Only removed by supersede (newer memory on same topic replaces it)

### Retrieval Boost

```
effective_halfLife = halfLife * (1 + 0.1 * log(retrieval_count + 1))
```

Frequently retrieved memories decay slower.

### Day-Count Interest Detection

```
day_count = number of distinct day_keys where this element appears
```

- day_count >= 3 → auto-tag `interest` (if not already tagged)
- day_count amplifies halfLife: `halfLife * (1 + 0.2 * day_count)`

Not raw mention frequency — cross-session recurrence is the signal.

## Context.md Promotion

### Immediate Promotion Signal

When cycle1 produces a long-term tag (rule/directive/decision/preference):
- Check for duplicate in context.md (same element + topic)
- If new → append to context.md
- If duplicate → merge (keep newer version)
- If contradicts existing → supersede (replace, mark old as deprecated)

### Supersede Logic

When a new memory contradicts an existing long-term memory:
1. Same element + same topic + different content → supersede
2. Mark old entry with `superseded_by` reference
3. Replace in context.md

Example:
- Old: "절대 -p 쓰지 마" (rule)
- New: "이제 -p 써도 돼" (rule, same element)
- Result: old deprecated, new promoted

## Cycle Integration

### cycle1 (every 5 min)
- Extract: topic, element, state, tags[]
- Long-term tag detected → immediate context.md promotion signal

### cycle2 (daily or threshold)
- Duplicate detection across classifications
- Merge similar entries
- Supersede contradictions
- Validate long-term entries still hold

### cycle3 (weekly)
- Rebuild context.md from validated long-term classifications
- Prune deprecated entries
- Update day_count for interest detection

## Prompt Addition

cycle1 prompt gets one more column:

```
case_id,text,topic,element,state,tags
```

tags: comma-separated from [rule, directive, decision, preference, incident, transient].
Empty if none clearly apply. Multiple allowed.

`interest` is NOT output by LLM — derived from day_count automatically.

## Score Integration

```
final_score = (base_rrf + semantic_bonus) * state_factor * time_factor * lang_factor
```

time_factor is now tag-aware:
- Long-term tags → 1.0
- Short-term tags → power-law with tag-specific halfLife
- No tags → default halfLife (30 days)

## Open Questions

1. How aggressive should supersede be? Conservative (require high similarity) vs liberal?
2. Should long-term entries ever expire? Maybe after 1 year with 0 retrieval?
3. Day-count interest: what threshold? 3 days? 5 days?
4. Should context.md have a max size? Prune lowest-importance long-term entries?
