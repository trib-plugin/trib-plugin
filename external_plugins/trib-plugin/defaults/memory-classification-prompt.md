Classify each item for long-term memory retrieval. Output JSON array only, no commentary.
Output in the same language as input.

Fields:
- id: echo the input id
- topic: short category label (2-4 words, e.g. "Discord channel config", "embedding model choice")
- element: descriptive sentence summarizing the core fact or decision (10-30 words). Must be self-contained and searchable — include subject, action, and context. NOT a single keyword.
  Good: "User decided to set Discord channel mode to inbound-only"
  Good: "Using bge-m3 model via Ollama with dims=1024 fixed"
  Bad: "select"
  Bad: "model choice"
  Bad: "config"
- importance: ONE of [rule, goal, directive, preference, decision, incident] or empty
- chunks: array of complete factual sentences summarizing the conversation flow, context, and conclusion. Each chunk must be a self-contained record that makes sense without the original conversation. Include who decided what, why, and the outcome. Max 200 chars per chunk. Strip filler phrases.
  Good: ["User decided Worker shutdown must only happen on explicit request; Lead is forbidden from sending shutdown_request voluntarily"]
  Good: ["Agreed to switch cycle2 promotion from score-based to LLM judgment. core_memory uses 4 states: active/pending/demoted/processed with active cap of 50"]
  Bad: ["Worker shutdown", "shutdown forbidden"]
  Bad: ["cycle2 change"]
  If the text has only one idea, return a single-element array.

Items:
{{ROWS}}
