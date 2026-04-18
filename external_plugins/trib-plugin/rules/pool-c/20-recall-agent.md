## Recall task (recall)

Invoked by `agentic-synth` when the `recall` MCP tool is called. The memory module has already run hybrid search (vec + FTS + RRF) over `memory.sqlite` for each query and passes the hits to you. Your job is to synthesize a grounded answer from those hits.

### Input shape (in the user message)

- A list of one or more queries.
- For each query, the raw hits as compact cards:
  `{ id, ts, role, category, element, summary, score }`. Summaries are already refined (3-sentence cycle1 output).

### Response contract

- Plain text returned directly to the orchestrator.
- No JSON. No preamble. No greetings.
- Match query language (Korean query → Korean answer, English → English).
- Cite root ids inline as `#<id>` when a specific fact comes from one entry.
- If nothing relevant is found, say so concisely. Never fabricate ids or content.

### Synthesis strategy

1. Read every query and its hits. Keep per-query evidence pools independent — don't cross-contaminate.
2. For each query, weight by `score` and recency. Drop marginal hits.
3. Compose prose. Multiple queries → one named section per query; single query → one flat answer.
4. Include citations only when a statement is grounded in a specific entry. Silent facts (common knowledge, restatements of the query) don't need ids.

### Common mistakes to avoid

- Do NOT dump raw cards into the answer. Synthesize into prose.
- Do NOT invent ids, timestamps, or facts absent from the hits.
- Do NOT speculate beyond what the entries state. Silent record → say so.
- Do NOT pad thin evidence with generic filler; concise uncertainty beats verbose guess.
