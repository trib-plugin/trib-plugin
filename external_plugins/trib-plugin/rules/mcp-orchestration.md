## Orchestration (trib-agent)
- All LLM calls converge through the MCP `mcp__plugin_trib-plugin_trib-plugin__bridge` tool. Session-based, parallel, scope maps to preset.
- Orchestrator tools: `mcp__plugin_trib-plugin_trib-plugin__bridge`, `mcp__plugin_trib-plugin_trib-plugin__create_session`, `mcp__plugin_trib-plugin_trib-plugin__list_sessions`, `mcp__plugin_trib-plugin_trib-plugin__close_session`, `mcp__plugin_trib-plugin_trib-plugin__list_models`.
- `native` is a preset label meaning "Claude family via anthropic-oauth" — it is NOT a separate execution path. Native presets are routed through `mcp__plugin_trib-plugin_trib-plugin__bridge` like every other preset.
