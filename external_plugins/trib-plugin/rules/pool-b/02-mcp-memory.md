## Memory (trib-memory)
- CRITICAL: invoke `mcp__plugin_trib-plugin_trib-plugin__recall` at session start and before any reference to prior context.
- Order: `recall` (past context) → `search` (external info) → codebase (Grep/Glob/Read). Never skip `recall` when past context may apply.
- When in doubt, call `recall` first — cost is near zero, missing context is expensive. For multi-angle lookups pass an array to `query`.
