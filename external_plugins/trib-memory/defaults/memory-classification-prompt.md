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
- chunks: array of 1-3 self-contained semantic chunks extracted from the text. Each chunk is a meaningful unit of information (a fact, decision, or action) that can stand alone. Strip filler phrases ("죄송합니다", "바로 하겠습니다", "네,"). Max 60 chars per chunk.
  Good: ["채널 모드 감지: --channels 플래그로 notifications/claude/channel 수신 여부 판단", "서버는 직접 감지 불가, notification 응답으로 간접 감지"]
  Bad: ["채널 모드", "감지"]
  If the text has only one idea, return a single-element array.

Items:
{{ROWS}}
