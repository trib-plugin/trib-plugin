## Cycle tasks (cycle1, cycle2)

These tasks process raw `entries` rows from `memory.sqlite` and emit synthesized chunks for storage as `is_root` rows.

### cycle1 — chunker + classifier

Read the entries provided in the user message, group contiguous/related entries into chunks, and emit classification metadata per chunk.

#### Output format

```json
{
  "chunks": [
    {
      "member_ids": [<int>, <int>, ...],
      "element": "<5-10 word subject label>",
      "category": "<one of 8 categories>",
      "summary": "<3-sentence refined synthesis>"
    }
  ]
}
```

#### Rules

- `member_ids` must be a subset of the input `id` values. Do NOT invent ids.
- Every chunk must have at least one member id.
- Do NOT emit chunks for small talk, acknowledgements, or pleasantries (`ok`, `thanks`, `네`, `ㄱㄱ`, `ㅇㅋ`, `해봐`). They simply do not appear.
- Do NOT emit a root id. The calling code selects the root deterministically (earliest ts, then smallest id) from `member_ids`.
- `element` is a short label (5-10 words) including the subject. Not a single keyword.
- `summary` is exactly 3 sentences in fixed order: (1) context/background, (2) cause/finding/analysis, (3) decision/outcome. Each ends with a period.
- `category` must be exactly one of the 8 (see memory-schema section).

#### Member grouping guidelines

- Prefer tight chunks: 2-5 related entries per chunk is the sweet spot. Large chunks dilute the summary.
- Consecutive entries from the same topic are the strongest grouping signal. A topic shift breaks the chunk.
- Include both the question/statement and its resolution in the same chunk when they arrive together.
- If two entries disagree or supersede each other, the later one usually wins the `summary` framing — but `member_ids` still includes both.
- A single user message with 2-3 distinct asks should split into separate chunks.

#### Summary quality

- 3-sentence structure (context / cause / outcome) required. Do not collapse to one sentence — use neutral phrasing for missing pieces.
- Avoid speculative outcomes. If the decision is not explicit, say so ("No final decision was stated" or equivalent).
- Keep technical identifiers (file paths, API names, version numbers) verbatim.

#### Common mistakes to avoid

- Do NOT merge unrelated topics into one chunk just because they are adjacent.
- Do NOT create a single-member chunk for noise or a reaction. Only single-member when the entry carries substantive content.
- Do NOT paraphrase so aggressively that source meaning is lost.
- Do NOT inflate short factual statements into verbose sentences. Thin content → still 3 sentences but brief.
- Do NOT use `decision` for things the user merely mentioned. A decision requires explicit agreement or a clear choice.
- Do NOT mix member ids from different conversation topics. Coherence > chunk count.

### cycle2 — root promotion / re-scoring

Operates on existing `is_root` entries. Re-evaluates them against current state and may update `score`, `category`, `summary`, or `status` (active vs archived).

The user message provides the list of root candidates and their full chunk context. Output spec is task-specific and provided in the user message.
