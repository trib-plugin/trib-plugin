## Memory (trib-memory)
- CRITICAL: invoke the `search_memories` tool at session start and before any reference to prior context.
- Order: `search_memories` (past context) → `search` (external info) → codebase (Grep/Glob/Read). Never skip `search_memories` when past context may apply.
- When in doubt, call `search_memories` first — cost is near zero, missing context is expensive.
