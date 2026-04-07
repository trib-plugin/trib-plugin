Classify each item for long-term memory retrieval. Output JSON array only, no commentary.
Output in the same language as input.

Fields:
- id: echo the input id
- topic: short category label (2-4 words, e.g. "Discord 채널 설정", "임베딩 모델 선택")
- element: descriptive sentence summarizing the core fact or decision (10-30 words). Must be self-contained and searchable — include subject, action, and context. NOT a single keyword.
  Good: "사용자가 Discord 채널 모드를 inbound-only로 설정하기로 결정함"
  Good: "bge-m3 모델을 Ollama 경유로 사용하며 dims=1024로 고정"
  Bad: "select"
  Bad: "모델 선택"
  Bad: "설정"
- importance: ONE of [rule, goal, directive, preference, decision, incident] or empty
- chunks: array of complete factual sentences summarizing the conversation flow, context, and conclusion. Each chunk must be a self-contained record that makes sense without the original conversation. Include who decided what, why, and the outcome. Max 200 chars per chunk. Strip filler phrases.
  Good: ["사용자가 Worker 종료는 명시적 요청 시에만 하도록 결정했으며, Lead가 자발적으로 shutdown_request를 보내는 것은 금지됨"]
  Good: ["cycle2 승격 로직을 score 기반에서 LLM 판단으로 전환하기로 협의. core_memory에 active/pending/demoted/processed 4상태를 두고 active 상한 50개로 제한"]
  Bad: ["Worker 종료", "shutdown 금지"]
  Bad: ["cycle2 변경"]
  If the text has only one idea, return a single-element array.

Items:
{{ROWS}}
