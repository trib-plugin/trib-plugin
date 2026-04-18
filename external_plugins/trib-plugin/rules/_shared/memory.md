# Memory

- When past facts, work, or decisions need to be looked up, always use `mcp__plugin_trib-plugin_trib-plugin__recall` first — before codebase search (Grep/Glob/Read). Accepts natural language; an internal agent searches the memory store and returns a synthesized answer.
- **For 2+ lookups: pass them as an array in ONE call — `query: ["angle a", "angle b", ...]`. Never issue multiple sequential `recall` calls; the internal agent fans out in parallel inside a single invocation.**
- Only save to memory when the user explicitly requests it. Never proactively suggest or offer to save.
- Storage is automatic. Only retrieval is manual. Never write to MEMORY.md or access sqlite directly.
