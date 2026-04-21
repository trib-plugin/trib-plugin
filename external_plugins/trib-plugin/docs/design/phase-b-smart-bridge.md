# Smart Bridge Phase B — Design Spec v1.3 _(ARCHIVED)_

> **⚠ ARCHIVED — 2026-04-21**
>
> This document is kept as a historical design record of the Phase B
> Smart Bridge rollout. Several names and mechanisms described below
> (`maintenance-llm.mjs`, `system-bridge.mjs`, `ttl-learner.mjs`,
> `POOL_C_TOOL_KEEP`, `opts.allowedTools`, `PERMISSION_DENY`,
> `findOrCreateSession`, `resetStatelessSession`, `isSessionStale`, the
> worker-lifecycle respawn triggers) have since been removed or replaced
> during subsequent cleanup passes. Do **not** treat this file as a
> description of current behaviour.
>
> For the current state read the code:
> - Schema deny list: `BRIDGE_DENY_TOOLS` in `src/agent/orchestrator/session/manager.mjs`
> - Role normalisation: `src/agent/orchestrator/smart-bridge/index.mjs`
> - Pool C hidden roles: `src/agent/orchestrator/internal-roles.mjs`
> - Cache strategy: `src/agent/orchestrator/smart-bridge/cache-strategy.mjs`
> - Synthetic tool defs: `src/agent/orchestrator/synthetic-tools.mjs`
> - Runtime permission guard: `READ_BLOCKED_TOOLS` in `src/agent/orchestrator/session/loop.mjs`
>
> Everything below is the original spec, preserved verbatim for provenance.

---

> **Status**: Spec finalized (pending Ship 0 empirical validation)
> **Design period**: 2026-04-16 evening → 2026-04-17
> **Supersedes**: v1.2 (same file, now replaced in its entirety)
> **Reviewed by**: Opus independent reviewer + GPT5.4 cross-reviewer (both 2026-04-17 KST)
> **Purpose**: Authoritative architectural specification for Phase B implementation.

This revision incorporates the full prior-session transcript review, both independent reviewers' findings, and the subsequent clarifications from the design owner. It replaces v1.2 in full.

---

## Revision History

| Version | Summary |
|---------|---------|
| v1.0 | Initial draft (2026-04-17 00:45 KST) |
| v1.2 | Tier model, role slots, provider-aware cache policy |
| **v1.3** | Post cross-review. See changes listed in §0.2. |

### 0.1 Observed baseline (2026-04-17)

Pre-implementation measurements from live plugin data:

- `cache-registry.json`: `maintenance-light` hit 0 / miss 1, `tester-runtime` hit 0 / miss 2
- `llm-usage.jsonl`: 995 entries, **zero** events with `cacheReadTokens > 0` or `cacheWriteTokens > 0`
- `llm-maintenance.jsonl`: file does not exist (the v0.6.42 log-split announcement appears incomplete)

These baseline values confirm the cross-reviewer's concern: "Pool B permanently warm" is **an aspirational state, not an established fact**. Ship 0 must validate or invalidate the assumption before later ships proceed.

### 0.2 Changes from v1.2

1. **§6.3 vs §7.2 contradiction resolved** — Worker messages tail does **not** carry `cache_control`; the O(N²) argument in §6.3 is now framed around that policy, not against it.
2. **§6.3 numeric error fixed** — 200-turn cumulative cost corrected (`$217` → `$189.25`); unit-cost assumptions now explicit.
3. **Pool B terminology split** — "logical Pool B" (the unified injection contract) vs "per-provider / per-model cache shard" (physical reality). The warm-keeper guarantee only applies to Anthropic shards.
4. **Cache assumption expressions downgraded** — Anthropic TTL-refresh-on-hit, minimum cacheable prefix, and OpenAI `prompt_cache_key` durability are now framed as Ship 0 validation targets, not established facts.
5. **Cycle1 SPOF mitigation** — health-check, retry, and simultaneous-cold-spawn singleflight policy added.
6. **Mid-session policies explicit** — cwd change and PROJECT.md add/edit during a Worker's lifetime are now explicitly addressed.
7. **Gemini maintenance eligibility** — TTL raised to 1h, matching the 10 min cycle comfortably. Gemini is now a supported maintenance shard alongside Anthropic and OpenAI.
8. **Supervisor plan dropped** — the v1.0 §6.7 "Supervisor Hook" is removed. The concept already exists implicitly as `router.mjs` Layer 2 LLM routing (identified during review), and that itself is being removed (see §10).
9. **`router.mjs` Layer 2 removed** — rule-based routing only.
10. **Native Agent tool path discontinued for Worker** — all agent spawning (Worker / Sub / Maintenance) goes through the Bridge MCP (`create_session` + `bridge_send`).
11. **`agents/Worker.md` and `agents/Bridge.md` both removed** — no longer needed once the native Agent path is retired.
12. **CLAUDE.md User Rules update** — `worker → opus-max (Native)` becomes `worker → opus-max (Bridge)`.
13. **`/bridge` slash command** — user-facing terminal UX preserved; the CLI internally routes through `bridge-llm.mjs` for observability / cache sharing.
14. **Sub "stateless + pooled reuse" clarified** — prefix-handle reuse only; no transcript carry-over between calls.
15. **OAuth one-liner phrasing tightened** — scoped to the current OAuth routing implementation, not a general Anthropic API rule.
16. **Ship plan re-shuffled** — Ship 1.5 (Hermes auto-generation) deferred to Phase C; Ship 2 split into 2a / 2b; Ship 6 empty number removed.

---

## 1. Vision & Scope

### 1.1 Vision
Unify every non-Claude-Code LLM call under Smart Bridge as a single dispatcher. Consolidate observability, maximise cache efficiency where the provider supports it, and keep role / project variance out of the shared prefix.

### 1.2 Goal priority
1. **Observability consolidation** — unified usage / cache / cost tracking by category
2. **Cache efficiency where feasible** — permanent Pool B (Anthropic shard) warm via cycle1; other shards behave per their native mechanism
3. **Role-specific injection without prefix churn** — immutable prefix, variance only in Tier 3 (messages)

### 1.3 Scope

| Role | Included? | Notes |
|------|-----------|-------|
| Worker (stateful) | ✓ | Task-scoped session |
| Sub: reviewer / tester / debugger / researcher | ✓ | Stateless; prefix-handle reuse |
| Maintenance: cycle1 / cycle2 / search | ✓ | Stateless, recurring |
| Scheduler | ✓ | Stateless, recurring |
| Webhook | ✓ | Stateless, one-shot |
| Claude Code CLI itself (Lead) | ✗ | Structurally unreachable; Pool A |
| native `Agent` tool | ✗ | Path discontinued in this revision — use Bridge MCP instead |

All non-Lead agent spawning goes through `create_session` + `bridge_send` (MCP). No `Agent(subagent_type: ...)` spawning for Worker / Sub.

---

## 2. Cache Pool Structure

### 2.1 Logical model (design-time abstraction)

```
Workspace (Anthropic workspace per user)
├── Pool A — Claude Code CLI (Lead)
│   Assembled by CC. Plugin does not interfere.
│   Loaded: CC base system, CLAUDE.md full, rules/*.md (all 5), agents/ frontmatter.
│
└── Pool B — Smart Bridge (unified injection contract)
    Assembled by the plugin. All Pool B roles present the same logical payload:
      Tier 1 (tools) + Tier 2 (system) = bit-identical across roles
    Role / project / session variance appears only in Tier 3 (messages).
```

The invariant is expressed in *what the plugin sends to the provider*. Whether the provider then stores that payload as one cache entry or many is a physical-layer question (§2.2).

### 2.2 Physical reality (provider / model shard)

Each provider caches independently, and within a provider, caches are sharded by model and, for OpenAI, by `prompt_cache_key`. Thus:

- **Anthropic**: one shard per workspace + model. Haiku and Sonnet are separate shards. Within a single model, the logical Pool B is one physical cache entry.
- **OpenAI**: one shard per `prompt_cache_key`. Role-scoped stable keys (recommended) keep Worker, Sub, etc. within one shard; per-spawn keys fragment them.
- **Gemini**: explicit `cachedContents` object keyed by content fingerprint. 1h fixed TTL. One object per prefix shape.

"Permanently warm via cycle1" applies to the **Anthropic shard only**. OpenAI and Gemini behave per their own TTL and warming model.

### 2.3 Cache keeper (Anthropic shard)

cycle1 runs every ~10 min, re-touching the Pool B Anthropic prefix. Anthropic refreshes the TTL to its configured value on each cache hit (**pending Ship 0 confirmation**), keeping the Anthropic shard warm indefinitely during active hours.

### 2.4 Single-point-of-failure mitigation

Cycle1 failure for > 30 min lets the Anthropic shard go cold; the next Worker or Sub call pays the write premium (2× input). Phase B mitigations:

- **Health-check**: observability ping compares now vs `cache-registry.json[profile].expiresAt`; if the keeper is overdue by > 5 min the orchestrator emits a warning.
- **Auto-restart**: an overdue keeper triggers an unscheduled cycle1 run (best-effort; rate-limited to once per 5 min to avoid tight loops).
- **Simultaneous cold-spawn singleflight**: if two Workers / Subs arrive while the shard is cold, the first call acquires a short-lived in-process lock; the second waits (bounded timeout) for the first to finish the cache write, then reads warm. Prevents duplicate write premiums.

Details and metrics in Ship 5 (observability).

---

## 3. Tier Block Composition

### 3.1 Terminology (authoritative)

- **Tier 1 block** = `tools` array → BP_1. Most stable (plugin-version invariant).
- **Tier 2 block** = `system` main body → BP_2. Plugin / project lifetime invariant.
- **Tier 3 block** = `messages` entirety. Session-level variable.

### 3.2 Tier 1 — `tools` (BP_1)

```
tools: [
  ...core tools              // Read, Write, Edit, Bash, Grep, Glob — name-sorted
  ...enabled MCP tools       // name-sorted
  skills_list                // existing 3-tool split preserved
  skill_view
  skill_execute
  ← cache_control { ttl: '1h' } on last tool   // BP_1 breakpoint
]
```

**Invalidates BP_1**: skill add / remove / rename, skill description edit, MCP catalogue change.
**Does NOT invalidate BP_1**: skill body edit (body returned via `skill_view` / `skill_execute` tool_result; body never appears in tool schema).

### 3.3 Tier 2 — `system` main body (BP_2)

```
system: [
  { type: 'text', text: '<OAuth single-line prefix>' },
    // No cache_control. This is a constraint of the current Anthropic OAuth
    // routing implementation (validated 2026-04-16 17:05 KST on the
    // anthropic-oauth path) — not a general Anthropic API rule.

  { type: 'text',
    text:
      '<MCP instructions>\n\n' +
      '<Common MD>\n\n' +
      '<rules/memory.md>\n\n' +
      '<rules/search.md>\n\n' +
      '<CLAUDE.md common sections — Core Rules, Writing, Non-negotiable, tone, name>\n\n' +
      '<profile.json rendered as "User: <name> (<title>)">',
    cache_control: { ttl: '1h' }    // BP_2 breakpoint
  }
]
```

**Excluded from Pool B Tier 2** (these live only in Pool A via CC auto-load):
- `rules/channels.md` (Lead-only: reply, channels)
- `rules/team.md` (Lead-only: TeamCreate, agent operation)
- `rules/user-workflow.md` (Lead-only: role → preset mapping)
- CLAUDE.md Lead-only sections: `## Workflow`, `## User Rules`, `# Team`, `# Models`, `# Memory ops`, `# Channels`

**Invalidates BP_2**: Common MD edit, rules/memory.md or rules/search.md edit, CLAUDE.md common block edit, profile.json edit.

### 3.4 Tier 3 — `messages`

```
messages: [
  // Role-specific system-reminder — no cache_control
  { role: 'user',
    content: '<system-reminder>\n<role-specific slots>\n</system-reminder>'
  },
  { role: 'assistant', content: 'Understood.' },

  // Actual request
  { role: 'user', content: <actual request> }
]
```

**Messages tail carries NO `cache_control`.** Worker is designed to resume via close + fresh spawn, not via message-layer cache reuse. The O(N²) cost argument in §6.3 is therefore framed *against* continuing the same session past its close triggers; messages-tail caching is not the alternative being traded against.

### 3.5 Optional experimental-skills pre-block (deferred)

The Phase B design no longer allocates space for a Hermes-style experimental skills manifest in Tier 3. Skill metadata stays in the Stable tool description (part of BP_1). Auto-generated / promotion pipelines are deferred to Phase C (§11).

---

## 4. Role-Specific Tier 3 Slots

### 4.1 Worker
```
# role
worker

# agent-role
[Worker role description — sourced from rules/roles/worker.md once authored;
 body of the decommissioned agents/Worker.md may be the migration source]

# skills
Call `skills_list` to discover available skills.

# project-context
[cwd's PROJECT.md content, if present]
```

### 4.2 Sub (reviewer / tester / debugger / researcher)
```
# role
reviewer        // or tester / debugger / researcher

# agent-role
[Role description, if authored — optional]

# task-brief
[Lead-issued task description — the ONLY channel for historical context]

# skills
Call `skills_list` to discover available skills.

# project-context
[cwd's PROJECT.md content, if present]
```

### 4.3 Maintenance (cycle1 / cycle2 / search)
```
# role
cycle1          // or cycle2 / search

# maintenance-prompt
[cycle1.md body]
```

Maintenance is project-independent memory curation — no `# project-context`.

### 4.4 Recap policy

**Recap is Pool A only** (Lead). Claude Code's SessionStart hook injects it for Lead. Every Pool B role excludes recap. If a sub-agent needs historical context, Lead extracts the relevant items into `task-brief`.

### 4.5 Sub pool reuse semantics

"Stateless + pooled reuse" means:
- **Prefix-handle reuse**: the provider-side cache shard identified by (provider, model, `prompt_cache_key`) is shared across Sub invocations so each call rides warm.
- **No transcript carry-over**: each Sub call starts with an empty `messages` except for the current `<system-reminder>` + request. Previous `task-brief` values never leak into a subsequent reviewer call.

Implementation: pool holds at most one live session per Sub role × provider combination; the session is reset (messages cleared) between dispatches rather than destroyed, preserving the session-level cache handle where the provider cares about that (OpenAI `prompt_cache_key`, Anthropic prefix hash).

---

## 5. Project MD System

### 5.1 File locations

- **Common MD** → `~/.claude/plugins/data/trib-plugin-trib-plugin/common.md` (plugin-managed, Tier 2)
- **Project MD** → `<cwd>/PROJECT.md` (committed to the project's own repo, Tier 3)

### 5.2 Runtime behaviour

On Pool B session start:
1. cwd = `process.cwd()`
2. Read Common MD → Tier 2 payload (always; bit-identical across roles)
3. Read `<cwd>/PROJECT.md` if present → Tier 3 `# project-context` slot
4. If absent, omit the slot

### 5.3 Mid-session policies

The following are **explicit design decisions**, not implicit emergent behaviour.

| Event | Policy |
|-------|--------|
| PROJECT.md added or edited while a Worker session is alive | The live Worker continues with the snapshot it had at spawn. The change takes effect on the next `close + spawn`. |
| cwd changes within a single Lead turn (e.g., user switches project) | New Pool B spawns after the cwd change pick up the new cwd's PROJECT.md. Live Worker stays on the original cwd's snapshot until closed. This matches the general "snapshot-at-spawn" rule. |
| Common MD edited | Any session already alive continues with its snapshot; next spawn picks up the new content. BP_2 prefix hash changes for spawns post-edit, which breaks shard sharing between old and new sessions until the old ones close. |

### 5.4 UI (Ship 7)

Config UI — General tab:
- **Common MD**: single large textarea.
- **Project MDs**: CRUD list (path field + textarea + delete). Pattern mirrors the existing Schedule / Webhook UI.
- setup-server endpoints: `/md/common GET/POST`, `/md/project GET/POST/DELETE`.
- Filesystem is the source of truth; UI is a convenience. Direct editor edits are respected.

### 5.5 CLAUDE.md `## Project Guides` removal

Remove `## Project Guides` from `~/.claude/CLAUDE.md`. Migrate its contents to the relevant project's `PROJECT.md`. CLAUDE.md becomes project-neutral.

---

## 6. Worker Context Management

### 6.1 Policy — close + respawn only

No trim. No self-compact. Only **close + fresh spawn** when any of these fires:

1. **Idle ≥ 5 min** — `session.lastUsedAt` is updated on each completed `bridge_send` turn. If a new `bridge_send` arrives after the window expires, the orchestrator closes the old session and spawns a new one for this turn. `lastUsedAt` does not tick during long-running tool executions; a Worker running a 10 min bash is NOT considered idle.
2. **Session total tokens ≥ threshold** — evaluated against the `usage.total_tokens` of the latest response. Close schedules on next turn.
3. **Workflow enters Ship stage** — Lead explicitly calls `close_session` as a consequence of user-approved Ship transition.

Next `bridge_send` after a close spawns a fresh session; it rides the warm Pool B prefix from its first call.

### 6.2 Token thresholds (defaults, `agent-config.json` overridable)

| Model                        | soft   | hard   |
|------------------------------|--------|--------|
| Opus 4.7 (1M extended)       | 400 k  | 500 k  |
| Opus 4.7 (200 k standard)    | 150 k  | 180 k  |
| Sonnet (200 k)               | 150 k  | 180 k  |
| Haiku (200 k)                | 100 k  | 150 k  |

- **soft** — schedule close on the next idle window
- **hard** — close immediately before the next turn

### 6.3 Arithmetic — why close beats extending

Unit-cost assumptions (all per 1M tokens, Anthropic Opus, October 2025 pricing):

| Rate | $/1M |
|------|------|
| Input (new) | $15 |
| Cache read (10 % of input) | $1.50 |
| Cache write 1 h (2× input) | $30 |
| Output | $75 |

Per-turn model for a Worker *without* messages-tail cache (current §7.2 policy):

```
turn(N) cost = system_cache_read + new_input + output + (previous messages as NEW input on each turn)

 = 15k × $1.50/1M           (Tier 2 cache read)
 + 3k  × $15/1M             (this turn's new user + tool results)
 + 2k  × $75/1M             (this turn's output)
 + (N − 1) × 5k × $15/1M    (ALL previous turns re-sent as full-priced input,
                             because messages tail has no cache_control)

 = $0.0225 + $0.045 + $0.15 + (N − 1) × $0.075
 = $0.2175 + (N − 1) × $0.075
```

Cumulative cost over N turns continuing the same session (no close):

| N | cumulative |
|---|-----------|
| 10 | $6.19 |
| 20 | $18.58 |
| 50 | $96.19 |
| 100 | $378.52 |
| 200 | $1 510.77 |

Note this is **much steeper** than the v1.2 figures. v1.2 (incorrectly) assumed messages-tail cache_read at $1.50/1M per prior turn, which is not the policy. The correct per-turn growth rate against full-priced re-sent messages is $0.075 / turn, ten times that.

Close + respawn every 10 turns:

```
cost per chunk = sum over turns 1..10 of turn(N) cost
               = 10 × $0.2175 + $0.075 × (0+1+2+...+9)
               = $2.175 + $3.375
               = $5.55

plus a one-off per-chunk re-brief (~2 k new input): + $0.03
chunk total ≈ $5.58

100 turns / 10 chunks ≈ $55.80
```

**Chunked is cheaper by a factor of ~7×** at 100 turns under the current (no messages-tail cache) policy. Short chunks win decisively on pure arithmetic; the practical balance against task continuity is what pushes us towards 10–30 turns per chunk in reality.

*All these numbers depend on unit-cost assumptions that may change. Ship 0 re-measures and this section should be regenerated from those measurements before Ship 2b commits behaviour to production.*

### 6.4 Trigger rationale

- **5 min idle** — aligns naturally with the 5 min TTL ceiling on messages-layer caches (if we ever enable them) and matches typical user context-switch latency.
- **Token thresholds** — 75–80 % of model window leaves headroom for the final response and any Lead-level summary.
- **Workflow Ship transition** — the Lead already has an explicit decision point; piggyback on it rather than inventing another signal.

---

## 7. Cache Control Policy

### 7.1 Universal rule

Every Pool B call sets `cache_control: { ttl: '1h' }` on both BP_1 (last tool) and BP_2 (static rules block). Hit / miss is server-side.

- **Hit** → read price (~ 10 % of input); no write premium.
- **Miss** → write premium (2×) once, then read for subsequent identical-prefix calls within TTL.
- **TTL refresh on hit** — *expected per Anthropic documentation, validated by Ship 0*. If the refresh does not occur as expected, cycle1 cadence needs re-tuning (cycle every ~50 min instead of ~10 min) and the "permanently warm" claim is downgraded to "warm during a 1 h sliding window".

### 7.2 Messages tail

No `cache_control` on Worker or Sub messages tails. Worker relies on close + respawn; Sub is stateless. The design accepts full-priced re-sent messages in exchange for a predictable Tier 1 + Tier 2 cache behaviour.

### 7.3 Minimum cacheable prefix — **Ship 0 validation target**

| Model                     | Minimum documented | Our observed state |
|---------------------------|--------------------|--------------------|
| Opus 4.7 / 4.6, Haiku 4.5 | 4096 tokens        | Not directly measured |
| Sonnet 4.6                | 2048               | Not directly measured |

The 4096 / 2048 figures are treated as **hypotheses until Ship 0 confirms them**. The live `cache-registry.json` (hit 0 / miss 3) does not yet tell us whether caches are being created at all; Ship 0 instruments the call path to report `cache_creation_input_tokens` and `cache_read_input_tokens` explicitly.

Current Pool B Tier 2 payload estimate: 3,350 – 6,550 tokens. If it falls under 4096 for Haiku:
- **Option A**: expand Common MD and `rules/memory.md` / `rules/search.md` with meaningful content (checklists, examples)
- **Option B**: move maintenance preset from Haiku 4.5 to Sonnet 4.6 (2048 threshold, 3× per-token cost; ~144 calls/day × extra $ — compute real delta in Ship 0)

Decision deferred to Ship 0 measurements.

---

## 8. Skill System

### 8.1 Existing 3-tool split — preserved

`collect.mjs:buildSkillToolDefs` already exposes three tools:

- `skills_list` — catalogue (name + short description)
- `skill_view` — full body without executing
- `skill_execute` — load body, inject, execute

This is retained. The v1.0 "1-tool with `<available_skills>` embedded" proposal was a regression and is not adopted.

### 8.2 Auto-generation (Hermes-style learning loop) — deferred to Phase C

Automatic skill authoring from Worker traces is interesting but orthogonal to Phase B's cache / dispatch goals. Deferred.

Consequence: the Tier 3 "experimental skills pre-block" planned in v1.2 is not part of Phase B. BP_1 carries the full (curated / manually authored) skill catalogue; promotion flow is out of scope.

### 8.3 Cache impact

- Skill add / rename / remove / description edit → BP_1 invalidated. Skill metadata churn should therefore stay low (discrete planned updates, not per-session).
- Skill body edit → no BP_1 impact (body never appears in tool schema).

---

## 9. Provider-Specific Cache Logic

Existing provider adapters already implement distinct cache mechanisms. Phase B unifies the Smart Bridge routing layer on top; each adapter retains its native approach.

| Provider            | Mechanism                                                 | Implementation                              | Phase B policy |
|---------------------|-----------------------------------------------------------|---------------------------------------------|----------------|
| Anthropic (Claude)  | Explicit `cache_control` with ephemeral TTL               | `anthropic-oauth.mjs`                       | Primary warm shard. Worker / Sub / Maintenance all supported. |
| OpenAI (GPT)        | Automatic prefix cache + `prompt_cache_key` session tag   | `openai-oauth.mjs`, `openai-compat.mjs`     | Role-scoped stable key (Option A). Cache persistence across close + spawn is a **best-effort**, not a guarantee. |
| Google (Gemini)     | Explicit cache object via `GoogleAICacheManager`          | `gemini.mjs`                                | Maintenance-eligible (1h TTL covers the 10 min cycle). Worker / Sub / Maintenance all supported. |

### 9.1 Ship 0 deliverables

Before Ship 1 begins:

1. Instrument the three adapters to log `cache_creation_input_tokens`, `cache_read_input_tokens`, and provider-specific equivalents, then re-populate `llm-usage.jsonl` / `llm-maintenance.jsonl`.
2. Confirm or refute Anthropic TTL refresh on hit.
3. Measure actual Pool B Tier 2 payload token count; decide Option A vs B from §7.3.
4. Finalise OpenAI `prompt_cache_key` scheme (**Option A recommended**: role-scoped stable key, e.g. `user-<hash>-worker`, persists across close + spawn).
5. Confirm that `llm-maintenance.jsonl` gets written; if not, land the log-split work that was attempted in v0.6.42 but is currently missing on disk.
6. Measure actual cache hit rate across providers with an identical Pool B prefix.

Ship 1 is gated on these six items.

---

## 10. Slash Commands & `/bridge` Integration

### 10.1 Slash command inventory (`commands/*.md`)

| Command | Current behaviour | Phase B disposition |
|---------|------------------|---------------------|
| `/trib-plugin:bridge <scope> <prompt>` | `bin/bridge` CLI direct execution → stdout | **UX preserved; internals route via `bridge-llm.mjs`** (see §10.2) |
| `/trib-plugin:clear` | Session clear | Unchanged |
| `/trib-plugin:config` | Open Config UI | Unchanged |
| `/trib-plugin:model` | Model picker | Unchanged |
| `/trib-plugin:new` | New session | Unchanged |
| `/trib-plugin:resume` | Resume session | Unchanged |
| `/trib-plugin:review` | Review request | Unchanged |
| `/trib-plugin:security` | Security review | Unchanged |

### 10.2 `/bridge` command

**Current flow**: user types `/trib-plugin:bridge <role> <prompt>` → Claude Code runs `node bin/bridge ARGS` → the CLI calls a provider adapter directly → stdout streams to the user's terminal without Lead interpretation.

**Phase B flow** (same user experience, unified internals):

```
/trib-plugin:bridge <role> <prompt>
  → bin/bridge CLI
  → bridge-llm.mjs (shared Smart Bridge helper, introduced in Ship 2a)
    → provider adapter (unchanged)
  → stdout to user (Lead not invoked)
  → llm-usage.jsonl receives the call record
```

Effects:
- **User UX**: identical — terminal raw output, no Lead summarisation.
- **Observability**: the call is recorded alongside every other Bridge call.
- **Cache**: Pool B Tier 1 + Tier 2 are shared with other Bridge calls, so `/bridge reviewer ...` rides the same warm prefix as a programmatic reviewer spawn.

### 10.3 `/bridge raw` mode — to be decided

Some users may want `/bridge` to **skip the Pool B prefix** entirely (minimal system prompt, "speak to the model directly"). Proposed syntax: `/bridge raw <prompt>`. Decision deferred to Ship 2a implementation; default remains shared-prefix.

---

## 11. Decommissioned Items

These concepts were discussed in prior revisions and the current session. v1.3 explicitly removes or defers each.

| Item                                             | Status                        | Rationale |
|--------------------------------------------------|-------------------------------|-----------|
| Supervisor plan (v1.0 §6.7)                      | Removed                       | Never implemented under that name. The functional equivalent exists as `router.mjs` Layer 2, which itself is being removed (see below). |
| `router.mjs` Layer 2 LLM routing                 | **Remove in Ship 4**          | Rule-based routing is sufficient given the current profile set. Decision latency and cost of the LLM hop don't pay back. |
| "Supervisor calls LLM on every bridge invocation" | Removed                       | Already withdrawn within this design session. |
| "Auto /clear when embedding drifts"              | Removed                       | Already withdrawn. |
| Worker trim (axis 1)                             | Deferred to Phase C           | Close + respawn handles context overflow. Trim adds complexity without proven benefit. |
| Worker self-compact (axis 2)                     | Deferred to Phase C           | Same rationale. |
| Worker task-completion close (axis 3)            | Subsumed by trigger #3        | Workflow-Ship transition is the concrete signal. |
| `agents/Bridge.md`                               | **Remove in Ship 4**          | Native Agent path retired; Smart Bridge single dispatcher replaces it. |
| `agents/Worker.md`                               | **Remove in Ship 4**          | Same reason. The body's task-guidance content migrates into `rules/roles/worker.md` (new, optional, Tier 3 `# agent-role`). |
| `~/.claude/PROFILE.md` + `.macos.md` + `.windows.md` | Remove (optional cleanup) | Zero code references. Not part of any prompt path. |
| `bot.json: sleepEnabled / sleepTime` + `/sleep`  | Remove in Ship 4              | Unused feature. Quiet-hours covered by `bot.quiet.schedule`. Memory `cycle2/sleep` is a separate concept that stays. |
| CLAUDE.md `## Project Guides`                    | Remove                        | Migrated per §5.5. |
| Single-tool Skill model                          | Not adopted                   | Existing 3-tool split is richer; reverting would be a regression. |
| Hermes auto-generation skill pipeline            | Deferred to Phase C           | Not aligned with Phase B's cache / dispatch goals. |
| Experimental skills pre-block in Tier 3          | Not present in Phase B        | Depends on the deferred Hermes pipeline. |
| Native `Agent(subagent_type: ...)` for Worker    | Discontinued                  | Bridge MCP `create_session + bridge_send` used instead. |
| CLAUDE.md User Rules: `worker → opus-max (Native)` | Change to `(Bridge)`        | Consequence of the above. |

---

## 12. Ship Plan

Order partial. Ship 0 is a gate. Ship 1 cannot start without Ship 0 passing.

| Ship  | Title | Primary scope |
|-------|-------|---------------|
| **0** | Provider cache verification & adjustment | Instrument adapters, confirm `llm-maintenance.jsonl` write path, measure Tier 2 payload size, decide Haiku Option A vs B, finalise OpenAI `prompt_cache_key` scheme, verify Anthropic TTL refresh, confirm cycle1 is actually running through Smart Bridge (the manual-cycle1 bypass noted 2026-04-16 21:49 KST). |
| **1** | Messages layer migration + Project MD slot | `rules-builder` split into `buildLead` (Pool A content) vs `buildBridge` (Pool B content). `session/manager.createSession` injects `buildBridge` static output into `system`, dynamic output into messages `<system-reminder>`. Add `# project-context` slot with cwd-based `PROJECT.md` detection. Remove CLAUDE.md `## Project Guides`. |
| **2a** | callLLM removal + `bridge-llm.mjs` common helper + `/bridge` CLI unification | Delete `shared/llm/index.mjs:callLLM` and helpers (`runCodex`, `runHTTP`, `runGemini`). Migrate `maintenance-llm.mjs`, `memory/lib/memory-cycle.mjs`, `channels/lib/scheduler.mjs`, `channels/lib/webhook.mjs` to Smart Bridge. Extract `bridge-llm.mjs` (generic; `maintenance-llm.mjs` becomes a thin wrapper). Update `bin/bridge` CLI so `/trib-plugin:bridge` routes through `bridge-llm.mjs` while preserving terminal stdout UX. |
| **2b** | Worker lifecycle triggers | Implement `session.lastUsedAt` tracking, idle-5-min close, token-threshold close (soft/hard with agent-config overrides), `close_session` on workflow-Ship transition. Depends on Ship 2a. |
| **3** | Sub pool unification | Create `sub-task` profile (lifecycle `continuous`, `behavior: 'stateless'`). Route reviewer / tester / debugger / researcher through it. Implement pool as "at most one live session per role × provider, messages reset between dispatches" (§4.5). Retire or alias `reviewer-external` / `tester-runtime` / `debugger-deep` / `researcher-minimal`. |
| **4** | Native path retirement + rules-builder Lead path + legacy cleanup | CLAUDE.md User Rules update to `worker → opus-max (Bridge)`. Delete `agents/Bridge.md` and `agents/Worker.md`. Optionally migrate Worker.md's task-guidance body into `rules/roles/worker.md`. Remove `router.mjs` Layer 2 LLM routing. Remove `bot.json: sleepEnabled / sleepTime` + `/sleep` command + its UI. Remove `PROFILE.md` files. |
| **5** | Observability + search-memory origin anchor | cycle1 health-check + auto-restart (§2.4). Simultaneous-cold-spawn singleflight lock. Per-profile cache-hit / token / cost dashboards. `entries` schema extension with `source_session_id` + `source_turn_range`. Expose `anchor` in `recall` results for origin jsonl navigation. |
| **7** | MD management UI | Config UI General tab: Common MD textarea + Project MD CRUD. `/md/common` GET/POST + `/md/project` GET/POST/DELETE endpoints. |

Ship 1.5 (Hermes auto-gen skill) was removed from the plan and deferred to Phase C.
Ship 6 number is not used; skipping prevents confusion in tracking.

---

## 13. Open Items / Verification Needs

1. **Sub agent MDs** — `Reviewer.md`, `Tester.md`, `Debugger.md`, `Researcher.md` not yet authored. If absent when Ship 1 lands, `# agent-role` slot stays empty for Subs. Optional backlog.
2. **`maintenance-llm.mjs` composition** — current system-prompt assembly for cycle1 / cycle2 / search to be aligned with Tier 3 `# maintenance-prompt` contract during Ship 2a.
3. **Profile `skip[]` semantics** — `composeSystemPrompt.profile.skip[]` mechanism should port to `buildBridge`. Decide which flags remain meaningful.
4. **Pool B prefix actual token count** — Ship 0.
5. **OpenAI `prompt_cache_key` scheme** — Option A recommended; Ship 0 to confirm persistence across close + spawn.
6. **Gemini viability for Sub** — resolved: 1h TTL makes Gemini viable for Sub, Worker, and Maintenance roles.
7. **Bridge.md / Worker.md safe removal** — grep for remaining `Agent(subagent_type: "trib-plugin:Bridge" / "Worker")` usages, confirm all gone before Ship 4 deletion.
8. **Manual cycle1 Smart Bridge bypass** — `memory/index.mjs` manual cycle1 still calls legacy `callLLM` path (observed 2026-04-16 21:49 KST). Fix in Ship 0 as a prerequisite for any cache validation.
9. **`/bridge raw` mode** — decide in Ship 2a whether to support `<role>=raw` that skips Pool B prefix.

---

## Appendix A — Cache invalidation matrix

| Change event                                  | BP_1 (Tier 1) | BP_2 (Tier 2) | Tier 3 system-reminder |
|-----------------------------------------------|:-------------:|:-------------:|:----------------------:|
| Skill promote / rename / remove               | destroyed     | intact        | intact                 |
| Skill body edit                               | intact        | intact        | intact (body in tool_result only) |
| Common MD edit                                | intact        | destroyed     | intact                 |
| `rules/memory.md` or `rules/search.md` edit   | intact        | destroyed     | intact                 |
| CLAUDE.md common-block edit                   | intact        | destroyed     | intact                 |
| `profile.json` edit                           | intact        | destroyed     | intact                 |
| Project MD edit / cwd change (project switch) | intact        | intact        | slot changes (no cache) |
| Role switch (worker ↔ reviewer)               | intact        | intact        | slot changes (no cache) |
| Recap update                                  | N/A (Lead only) | N/A         | N/A                    |
| MCP tool catalogue change                     | destroyed     | intact        | intact                 |

---

## Appendix B — Glossary

- **Pool A / Pool B** — logical cache-injection contracts for Lead vs Smart Bridge paths. Physical storage is per-provider / per-model shards.
- **BP_1 / BP_2** — Anthropic cache breakpoints for tools / system. Up to four breakpoints per request; this spec uses only BP_1 and BP_2 in steady state.
- **Tier 1 / 2 / 3** — our naming for the three logical blocks (tools / system / messages) regardless of provider.
- **Cache keeper** — cycle1 maintenance call that re-touches the Anthropic Pool B prefix; warm-only on Anthropic shard.
- **Role-scoped stable key** — `prompt_cache_key` value derived from role + workspace, reused across close + spawn so OpenAI's prefix cache persistence (best-effort) is exercised.

---

## Appendix C — Observed baseline numbers (for future comparison)

| Measurement | Value | Source | Date |
|-------------|-------|--------|------|
| `cache-registry.maintenance-light` hit / miss | 0 / 1 | `~/.claude/plugins/data/trib-plugin-trib-plugin/cache-registry.json` | 2026-04-17 KST |
| `cache-registry.tester-runtime` hit / miss | 0 / 2 | same | same |
| `llm-usage.jsonl` total entries | 995 | same directory | same |
| `llm-usage.jsonl` entries with `cacheReadTokens > 0` OR `cacheWriteTokens > 0` | 0 | same | same |
| `llm-maintenance.jsonl` existence | file missing | same | same |

After Ship 0, re-take these measurements; they form the baseline against which Phase B success is judged.

---

End of spec.
