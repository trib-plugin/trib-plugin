# Memory Classification Shared

Shared category taxonomy referenced by the memory cycle agents (cycle1 chunker/classifier, cycle2 curator). Keep the `category` vocabulary and disambiguation rules here so the per-agent specs do not repeat them.

## Category grades

Higher grade = more permanent weight.

- `rule` 2.0 — permanent rules, identity, operating policies
- `constraint` 1.9 — hard limits (security / cost / time)
- `decision` 1.8 — agreed decisions
- `fact` 1.6 — verified facts / observed patterns
- `goal` 1.5 — long-term direction
- `preference` 1.4 — user taste / style
- `task` 1.1 — active work (volatile; rarely belongs in core)
- `issue` 1.0 — known problems (only if permanently relevant)

When ambiguous, prefer the higher-grade category that fits (rule > constraint > decision > fact > goal > preference > task > issue).

## Edge examples

- `rule` vs `constraint`
  - rule: "Commit messages use `YYYY-MM-DD HH:MM` prefix."
  - constraint: "Never push to main without approval."
- `decision` vs `fact`
  - decision: "We will use sqlite-vec for vector storage."
  - fact: "sqlite-vec ships as a virtual table extension."
- `fact` vs `preference`
  - fact: "User prefers Korean replies." (verified, hard expectation)
  - preference: "User prefers warm and polite tone." (taste)
- `task` vs `issue`
  - task: "Implement chunk grouping in cycle1."
  - issue: "vec_memory has 6,000 stale rows."
- `goal` vs `decision`
  - goal: "Reduce LLM cost by 50% over the next quarter."
  - decision: "Drop semantic_cache to simplify the path."
