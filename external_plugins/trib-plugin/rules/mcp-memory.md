## Memory (trib-memory)
- CRITICAL: invoke the `mcp__plugin_trib-plugin_trib-plugin__search_memories` tool at session start and before any reference to prior context.
- Order: `mcp__plugin_trib-plugin_trib-plugin__search_memories` (past context) → `mcp__plugin_trib-plugin_trib-plugin__search` (external info) → codebase (Grep/Glob/Read). Never skip `mcp__plugin_trib-plugin_trib-plugin__search_memories` when past context may apply.
- When in doubt, call `mcp__plugin_trib-plugin_trib-plugin__search_memories` first — cost is near zero, missing context is expensive.
