# Common Permission Manual

## Permission Types

| Level | Scope | Description |
|-------|-------|-------------|
| `read` | Information gathering only | File/code read, external search, memory recall, explore, skill inspection, channel observation. `bash` / `write` / `edit` are rejected at call time. |
| `read-write` | Read + state change | All read tools plus file mutation, Bash, memory writes, skill execution, channel/agent control, task management |
| `full` | Unrestricted | All read-write tools plus destructive operations (force-push, deploy, schema change) after confirmation |

## Dispatch Protocol

Every Pool B / Pool C session is built from four prompt regions mapped to Anthropic's 4 cache breakpoints so every role shares as much warm prefix as possible:

- **BP1 — tools.** The full MCP + builtin tool array. Bit-identical across all roles. Sorted deterministically so the cache prefix never shifts.
- **BP2 — systemBase.** Shared Pool B bridge rules (this folder), CLAUDE.md common sections, user agent configs, user name. Bit-identical across every role in the same provider, cached at 1h.
- **BP3 — systemRole.** Role-specific invariant: permission, `role` label, agent-role body (from `agents/{role}.md`), Pool C role snippet (from `rules/pool-c/`). One cache shard per hidden role; Pool B roles with the same permission share their shard. Cached at 1h.
- **BP4 — messages-tail.** Sliding 5m BP over the most recent user / tool_result message. Covers tier3 reminders (cwd, skills, project-context) and the running tool loop so iter 2+ tool_results are cache-read instead of uncached input.

Agents MUST restrict tool invocations to their declared permission level. The tool schema is always the full set — there is no schema-level deny. `bash` / `write` / `edit` are blocked at call time for `permission=read` sessions (`READ_BLOCKED_TOOLS` runtime guard); `recall` / `search` / `explore` / `bridge` are blocked only when the caller itself is a hidden role (recursion break in `ai-wrapped-dispatch`). If any other denied tool seems necessary, stop and report back.

`role` determines the agent md file loaded from `agents/{role}.md`. If no file exists, the inline description from the profile is used instead.

`permission` is authoritative — the systemRole block echoes it, but the permission manual (this document) is the canonical source.
