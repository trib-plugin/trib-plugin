## Explore (trib-explore)
- CRITICAL: prefer `mcp__plugin_trib-plugin_trib-plugin__explore` for internal codebase/file lookups when multiple angles are involved. Grep/Glob remain useful only for a single narrow pattern when the target shape is already known.
- Scope: local filesystem only. Not for external web (use `mcp__plugin_trib-plugin_trib-plugin__search`) or past context (use `mcp__plugin_trib-plugin_trib-plugin__recall`).
- Order: recall → search → explore (codebase). Read directly when the exact file path is known.
- For multi-angle lookups pass an array to `query`. Override `cwd` (absolute path, `~` expansion accepted, forward slashes on Windows/WSL) to narrow the search root when needed.
