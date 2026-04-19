# Cache Shared-Prefix Refactor (v0.6.191 – v0.6.193)

## Goal

Maximize Anthropic prompt-cache hit rate across every Pool B / Pool C
bridge invocation while keeping runtime behaviour unchanged. The
high-level principle: **one monolithic cached prefix that every agent
call shares — role, permission, agent-type differences live in the
variable tail (messages), never in the cached prefix**.

## Prior State (v0.6.189 baseline)

System layout for every Pool B / Pool C bridge call:

```
system: [
  Claude Code prefix         (gated models only, no BP)
  systemBase                 (BP2, 1h — bridgeRules monolithic)
  systemRole                 (BP3, 1h — role-specific: # role, # permission, agent-role, agent-snippet)
]
tools: [... 32 MCP tools ...] (BP1, 1h — cache_control on tools[last])
messages: [
  user <system-reminder>tier3Reminder</system-reminder>   (possible BP4)
  assistant "Understood"
  user <actual query>
  ...
]
```

Problems:
1. `systemRole` varied per role/permission, so each role had its own BP3
   cache shard. Cross-role reuse was zero.
2. Tools schema held 14 Lead-only tools (Discord channel ops, session
   lifecycle, schedule/config admin, nested bridge dispatch) that Pool
   B/C agents never used but still occupied the BP1 prefix.
3. `pool-b/01-agent.md` carried team-coordination / workflow-phase
   meta-content that applies to Lead, not to a single-turn agent.

Observed: ~15.6 KB tokens per bridge call (measured), ~60% of it in the
"always cached but role-variant" middle.

## Failed Attempt (v0.6.190)

Removed tools[last] BP assuming that "first system block covers the
tools prefix via Anthropic prefix semantics." The assumption was right
in spirit but wrong in execution:

- `CLAUDE_CODE_SYSTEM_PREFIX` (system[0] for gated models) carries no
  cache_control — it's the OAuth routing sentinel, must remain an
  unmarked block or the server falls to the standard pool and 429s.
- The actual cache anchor is `systemBase` (system[1]), which *does*
  cover tools via prefix semantics — but only when systemBase exists
  and has `cache_control`. For non-gated paths (Haiku) the layout
  differs and the assumption broke.

Reverted in v0.6.191.

## Final Design (v0.6.191 – v0.6.193)

### BP layout

```
BP1 (1h) — tools[last] cache_control
  tools schema, now trimmed to 17 bridge-safe tools

BP2 (1h) — systemBase last block cache_control
  pool-b/01-agent.md (slim, ~4.6KB)
  _shared/{memory,search,explore,lsp}.md
  pool-b/{02-mcp-memory,03-mcp-search,04-mcp-explore}.md
  user CLAUDE.md common sections (Lead-only H1s filtered out)
  User: <name>
  — bit-identical across every bridge role + permission

BP3 (1h, conditional) — tier3 <system-reminder> message
  role marker (moved from systemRole)
  permission info (moved from systemRole)
  agent-role template (moved from systemRole)
  agent-snippet (Pool C hidden-role specific, moved from systemRole)
  task-brief, skills hint, project-context, memory-context
  — per-call variance but consumed via the messages-tail BP once warm

BP4 (5m) — messages tail
  most recent assistant + tool_result turns
```

### Key structural changes

1. **`systemRole` disabled entirely.** `composeSystemPrompt` now
   returns `systemRole = ''`. Role-identifying content moves into
   `tier3Reminder` which is injected as a user `<system-reminder>`
   message.
2. **`cwd` injection removed.** Tools resolve working directory
   internally (bash uses process cwd, explore/read/grep take args,
   absolute paths are unambiguous).
3. **Bridge-unsafe tools stripped.** Sessions created with
   `opts.owner === 'bridge'` filter out 15 tools that Pool B/C agents
   never use (Discord ops, session lifecycle, schedule admin, nested
   bridge dispatch).
4. **`pool-b/01-agent.md` slimmed 62%.** Dropped sections covering
   team coordination, bridge routing internals, workflow-phase
   examples, anti-patterns duplicated by §2/§3/§4.

### Cross-pool sharing

Pool A (Lead) has its own systemBase via `buildInjectionContent` and
cannot share with Pool B/C — it carries User Profile / Bot Persona and
Lead-specific directives.

Pool B and Pool C both go through `createSession`, which calls
`buildBridgeInjectionContent` (`_buildBridgeRules`) for systemBase. With
`systemRole = ''` and the tools schema identical (bridge-safe filter
applies to both), **Pool B and Pool C land on the same cache shard**.
A warm explorer call speeds up the next worker call and vice versa.

### Stripped tools (bridge sessions only)

```
Discord / channel    reply, react, edit_message, download_attachment,
                     fetch, activate_channel_bridge
Session lifecycle    create_session, close_session, list_sessions,
                     list_models
Schedule / config    schedule_status, trigger_schedule,
                     schedule_control, reload_config
Role delegation      bridge
```

15 tools, ~10.3 KB removed from the cached tool schema.

### Kept tools (bridge sessions)

```
File / code          read, multi_read, write, edit, multi_edit,
                     batch_edit, glob, grep
Shell                bash
Codebase symbols     lsp_definition, lsp_references, lsp_symbols
Info retrieval       recall, search, explore
Async collection     session_result
Memory               memory
```

17 tools. Agents retain the full actual-work surface; only the Lead
administrative surface is hidden.

## Runtime Enforcement (unchanged)

Permission filtering at call time (loop.mjs `READ_BLOCKED_TOOLS`) is
untouched. A `read` permission session still gets `bash` / `write` /
`edit` rejected with a clear error. Moving role/permission into
`tier3Reminder` does not weaken safety; it only changes where the
model reads the policy from.

## Migration Summary

| Version | Change                                                        | BP1 delta |
|---------|---------------------------------------------------------------|-----------|
| 0.6.190 | (failed) tools BP removed unconditionally — reverted          | n/a       |
| 0.6.191 | systemRole disabled, cwd removed, tools BP dropped (kept)     | ~0        |
| 0.6.192 | pool-b/01-agent.md slimmed + bridge-unsafe tools stripped     | -17.9 KB  |
| 0.6.193 | `bridge` tool added to strip list                             | -1.2 KB   |

Expected effective BP1 per call: **~15.6k → ~11k tokens (~30%
reduction)**, with cache_read rate close to 100% once warm (1h TTL).

## Measurements

Early empirical check (same role, consecutive calls):

```
call 1: claude-opus-4-7 · 15.6k in (cache 15.6k) · 1.9s    (v0.6.191)
call 2: claude-opus-4-7 · 15.6k in (cache 15.6k) · 1.8s    (v0.6.191)
```

100% cache hit, sub-2-second turnaround, confirms systemBase BP covers
the tools prefix (refuting the reviewer concern that removing the
separate tools BP would break caching).

Post-v0.6.193 target: ~11k in, cache ~11k. Verification pending a
reload + bridge call.

## File Inventory

```
src/agent/orchestrator/context/collect.mjs
  composeSystemPrompt — systemRole force-disabled, role content
  migrates to tier3Parts, cwd dropped

src/agent/orchestrator/session/manager.mjs
  createSession — bridge-safe tool filter (opts.owner === 'bridge')

src/agent/orchestrator/providers/anthropic-oauth.mjs
  _doSend — tools[last] cache_control removed, systemBase BP covers
  tools prefix via Anthropic prefix semantics

src/agent/orchestrator/providers/anthropic.mjs
  _doSend — same tools BP removal, aligned with anthropic-oauth

rules/pool-b/01-agent.md
  Slimmed to tool-focused sections only

.claude-plugin/plugin.json
  0.6.190 → 0.6.193 (three bumps)
```

## Future Work

- **Measurement harness.** Thread `cache_creation_input_tokens` and
  `cache_read_input_tokens` into bridge-trace so hit-rate regressions
  are visible without ad-hoc probing.
- **Pool A shared layer.** Pool A and Pool B currently share nothing at
  the cache level. A subset of `_shared/{memory,search,explore,lsp}.md`
  could be hoisted into a cross-pool preamble if Pool A's systemBase is
  refactored to place those at a fixed byte offset.
- **`pool-b/01-agent.md` second pass.** The slim version is still
  ~4.6 KB. A further pass could trim §2 / §3 duplication with
  `# Project Instructions` from user CLAUDE.md.
- **Dynamic bridge-safe list.** Today the deny list is hard-coded.
  Surface it via config so users can opt specific tools back into the
  bridge surface when a custom workflow needs them.
