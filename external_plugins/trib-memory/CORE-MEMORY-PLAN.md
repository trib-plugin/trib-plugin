# Core Memory Management Plan

## Goal
Context.md should contain only the most critical, curated information — not everything.

## Promotion Criteria (what belongs in core memory)
- Repeatedly corrected rules (user pointed out multiple times)
- User identity: personal info, family, relationships
- Top-priority work rules (broad, universal — not task-specific)
- Critical incidents or decisions
- Long-term plans and goals
- Strong user preferences

## Demotion Criteria (what gets removed)
- Task-specific small rules (e.g., "do X when working on Y") — demote if frequency drops
- Stale items: no retrieval for extended period
- Superseded: replaced by newer, contradicting classification

## Importance Levels
- **core**: Always in context.md — identity, universal rules, repeated corrections
- **active**: In context.md while relevant — ongoing plans, recent decisions
- **archive**: Searchable only — old events, completed tasks, low-frequency items

## Mechanism
- Cycle1 LLM assigns importance level during classification
- Periodic re-evaluation: check retrieval_count trends, demote if frequency drops
- retrieval_count + recency + user emphasis = dynamic score
- Only core + active items appear in context.md

## TODO
- [ ] Add importance_level field to classifications table
- [ ] Update cycle1 prompt to assign importance level
- [ ] Update buildContextText() to filter by importance
- [ ] Add periodic demotion cycle (cycle2 or separate)
- [ ] Consider user pin/unpin mechanism for manual override
