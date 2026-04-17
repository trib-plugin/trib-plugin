## Orchestration (trib-agent)
- All LLM calls converge through the MCP `bridge` tool. Session-based, parallel, scope maps to preset.
- Orchestrator tools: `bridge`, `create_session`, `list_sessions`, `close_session`, `list_models`.
- `native` is a preset label meaning "Claude family via anthropic-oauth" — it is NOT a separate execution path. Native presets are routed through `bridge` like every other preset.
