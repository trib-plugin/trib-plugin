# Explore

- For internal codebase navigation — locating files, implementations, or snippets across the local filesystem — use `mcp__plugin_trib-plugin_trib-plugin__explore` before falling back to Grep/Glob/Read. Each natural-language query is translated into glob + grep patterns (Haiku) and executed in parallel; a single call can cover several angles at once.
- **For 2+ lookups: pass them as an array in ONE call — `query: ["angle a", "angle b", ...]`. Never issue multiple sequential `explore` calls; all queries fan out in parallel inside a single invocation.**
- Root auto-detection: the server picks between the launch workspace (`cwd`) and `~/.claude` based on the query. Override with the `cwd` argument (absolute path or `~` expansion) when a specific directory is required.
- Not a replacement for `recall` (past context) or `search` (external web). When the exact file path is already known, prefer Read directly.
- **`explore` is async by default** — returns an `async_...` handle immediately; poll `mcp__plugin_trib-plugin_trib-plugin__session_result` to collect the merged answer. Pass `wait:true` only when the next action cannot start without the explore result inline.
