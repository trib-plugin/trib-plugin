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

Items:
{{ROWS}}
