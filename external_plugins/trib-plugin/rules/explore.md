# Explore

- For internal codebase navigation — locating files, implementations, or snippets across the local filesystem — use `mcp__plugin_trib-plugin_trib-plugin__explore` before falling back to Grep/Glob/Read. Each natural-language query is translated into glob + grep patterns (Haiku) and executed in parallel; a single call can cover several angles at once.
- Scope: local filesystem only. Not for external web (use `search`) or past context (use `recall`). Read directly when the exact file path is known.
- **For 2+ lookups: pass them as an array in ONE call — `query: ["angle a", "angle b", ...]`. Never issue multiple sequential `explore` calls; all queries fan out in parallel inside a single invocation.**
- Root control: the `cwd` argument is the authoritative search root. Absolute path or `~` expansion supported. When omitted, the launch workspace is used — pass `cwd: "~/.claude/..."` explicitly to target the plugin install tree or other directories outside the workspace. No silent fan-out between roots.
- **`explore` is async by default** — returns an `async_...` handle immediately; poll `mcp__plugin_trib-plugin_trib-plugin__session_result` to collect the merged answer. Pass `wait:true` only when the next action cannot start without the explore result inline.
