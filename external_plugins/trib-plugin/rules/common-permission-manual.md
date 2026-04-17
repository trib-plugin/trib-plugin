# Common Permission Manual

## Permission Types

| Level | Scope | Description |
|-------|-------|-------------|
| `read` | Information gathering only | File/code read, external search, memory recall, skill inspection, channel observation |
| `read-write` | Read + state change | All read tools plus file mutation, Bash, memory writes, skill execution, channel/agent control, task management |
| `full` | Unrestricted | All read-write tools plus destructive operations (force-push, deploy, schema change) after confirmation |

## Dispatch Protocol

1. Every one-shot LLM dispatch receives a **4-field input**: `{ role, permission, desc, task }`.
2. The **identity block** (`role` + `permission` + `desc`) is rendered once per role and cached with `cache_control` at the provider-specific TTL.
3. The **task block** is the volatile user message appended after the cached identity.
4. Agents MUST restrict tool invocations to their declared permission level. If a denied tool is necessary, stop and report back instead of invoking it.
5. `role` determines the agent md file loaded from `agents/{role}.md`. If no file exists, `desc` (inline description from the profile) is used instead.
6. `permission` is authoritative — the agent's Tier 3 system-reminder echoes it, but the permission manual (this document) is the canonical source.
