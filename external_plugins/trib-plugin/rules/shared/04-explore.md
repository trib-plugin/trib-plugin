# Explore

- `explore` — internal codebase navigation. Each natural-language query is translated into glob + grep patterns and executed in parallel; one call can cover several angles.
- Read directly when the exact file path is known; skip `explore`.
- Root control: the `cwd` argument is the authoritative search root. Absolute path or `~` expansion supported. When omitted, the launch workspace is used — pass `cwd: "~/.claude/..."` explicitly to target the plugin install tree or other directories outside the workspace. No silent fan-out between roots.
