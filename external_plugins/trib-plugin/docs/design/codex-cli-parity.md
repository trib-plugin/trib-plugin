# Codex CLI Parity — Options for Channel-Equivalent UX

Research note on bringing trib-plugin's Claude-Code-style `<channel>` experience
to users who drive Codex CLI instead of Claude Code. Written 2026-04-19.

## Background

Today the channel UX lives entirely inside Claude Code's harness:

- trib-plugin MCP server emits events (Discord messages, webhooks, schedules).
- Claude Code's harness auto-injects those events into the model turn as
  `<channel>` tagged system reminders.
- The agent reacts naturally without the user having to ask.

For a Codex CLI user, the trib MCP tools (search/recall/reply/…) are reachable
but the auto-injection layer has historically been missing. This note maps
the current Codex capabilities (April 2026) to each component of the channel
UX and evaluates feasibility.

## What Codex CLI Now Offers (post v0.121.0, 2026-04-15)

### Plugin marketplace (first-class)

- `codex marketplace add <source>` accepts GitHub repos, git URLs, local
  directories, or direct `marketplace.json` URLs.
- `/plugins` browses, installs, and removes plugins with auth/setup handling.
- Structurally aligned with Claude Code's plugin marketplace — the same
  plugin can plausibly ship to both ecosystems with matching manifests.

### MCP Apps

- Richer custom-server support: resource reads, tool-call metadata,
  custom-server tool search, file-parameter uploads.
- **Server-driven elicitations** — MCP server can prompt the client for
  structured input.
- Namespaced MCP registration and parallel-call opt-in.
- Sandbox-state metadata, symlink-aware filesystem metadata.

### Hooks system

- `userpromptsubmit` hook fires before prompt execution and history entry;
  it can block, augment, or rewrite the prompt.
- `SessionStart` hook distinguishes `/clear`, fresh start, and resume.
- Early-stage but functionally similar to Claude Code hooks.

### Turn injection

- `turn/steer` (app-server) appends user input to an **in-flight turn** via
  JSON-RPC — requires `threadId`, `input`, `expectedTurnId`.
- **Raw turn item injection API** — realtime + app-server — pushes raw items
  into a running session from an external program.
- WebSocket transport is experimental but supported; JSON-RPC 2.0 framing.

### Event streaming

- Thread lifecycle: `thread/started`, `thread/archived`, `thread/closed`.
- Turn: `turn/started`, `turn/completed`, `turn/diff/updated`.
- Item: `item/started`, `item/completed`, delta streams.
- Approval prompts: `item/commandExecution/requestApproval`.
- Clients can opt out of specific notifications via
  `initialize.params.capabilities.optOutNotificationMethods`.

## Channel UX Implementation Paths

### Path A — MCP tools only (pull)

- Register trib-plugin as a Codex MCP server.
- Expose a `check_channel` tool; the agent polls it inside each tool loop.

| | |
|---|---|
| Reach | Any Codex user who installs the MCP |
| Push while idle | **No** (turn must be active) |
| Mid-turn push | Only if the model chooses to call the tool |
| Complexity | Lowest |

**Verdict**: acceptable as a minimum, but not equivalent to Claude Code's
channel auto-injection.

### Path B — Hooks-augmented pull

- Same MCP registration as Path A.
- Add a Codex `userpromptsubmit` hook script that drains the Discord event
  queue and prepends a `<channel>` block before the prompt enters history.
- A `SessionStart` hook can restore a recap block at the top of new
  conversations.

| | |
|---|---|
| Reach | Any Codex user who installs the plugin |
| Push while idle | **No** |
| Mid-turn push | No — hooks run only at prompt-submit time |
| Complexity | Low |

**Verdict**: closest approximation to Claude Code's UX without running an
external process. Users perceive "per-message" channel integration.

### Path C — App-server turn injection (true push)

- trib-plugin runs `codex exec-server` as a child process (or connects to an
  existing one) over WebSocket JSON-RPC.
- A Discord/webhook listener calls `turn/steer` or the raw turn item
  injection API on the active `threadId` / `expectedTurnId`.
- The agent receives the message inside the current turn without needing to
  poll or re-prompt.

| | |
|---|---|
| Reach | Users who opt into the exec-server path |
| Push while idle | Partial — orchestrator can open a fresh turn on event |
| Mid-turn push | **Yes** — this is the exact primitive Codex exposes |
| Complexity | Highest — new provider layer, process management |

**Verdict**: the only path that matches Claude Code's `<channel>` latency
and behaviour. Requires trib to become a Codex host (in addition to the
Claude Code plugin role).

### Paths can coexist

B and C are not mutually exclusive. A sensible rollout is B first (low risk,
broad reach) and C later as an opt-in "trib runs Codex for you" mode.

## Gap Analysis vs Claude Code `<channel>`

| Capability | Claude Code today | Codex Path A | Codex Path B | Codex Path C |
|---|---|---|---|---|
| Tool access to MCP (search/recall/reply) | Yes | Yes | Yes | Yes |
| `<channel>`-style pre-prompt injection | Yes | No | Yes | Yes |
| In-flight turn injection | Yes | No | No | **Yes** |
| Idle-time wake-up | Yes (harness) | No | No | Partial |
| Requires extra process | No | No | No | Yes |

## Cache & WebSocket Notes (context for readers)

Current trib OpenAI provider uses the ChatGPT backend OAuth endpoint
(`chatgpt.com/backend-api/codex/responses`). Empirically:

- WebSocket transport gives cross-session prefix cache hits
  (`cached_tokens` ≈ 4608 stable on reviewer pings).
- Delta transport reduces per-iteration payload (~6k → delta-only).
- `prompt_cache_retention: "24h"` is **rejected** by this endpoint (400
  Unsupported parameter), re-verified 2026-04-19. The public Responses API
  accepts it; OAuth backend does not.

Path C would switch (or add) the provider to the Codex exec-server path,
which operates at a different layer and may have different cache semantics.
That needs its own measurement round.

## Open Questions

1. Does the Codex plugin marketplace accept the same `marketplace.json`
   schema Claude Code uses, or is a translation layer needed?
2. Does the Codex userpromptsubmit hook have access to arbitrary host-side
   state (to drain the Discord queue), or only to prompt text?
3. Raw turn item injection — is it restricted to realtime sessions, or does
   it work in the text-only flow as well?
4. What is the TTL and invalidation behaviour of the Codex exec-server
   `threadId` / `turnId` pair? Needed for listener reliability.
5. Does server-driven elicitation surface to the Codex CLI user as a native
   prompt, or require TUI integration per plugin?

## Proposed Next Steps

1. Prototype Path B end-to-end with a minimal `userpromptsubmit` hook
   script that prepends a `<channel>` block when the Discord queue is
   non-empty. No core code changes in trib's orchestrator.
2. Measure whether this covers 80% of the Claude Code channel UX in
   practice (most events arrive between turns anyway).
3. If real-time push matters (e.g., long-running agent turns), prototype
   Path C as an opt-in provider `openai-exec-server`.
4. Parallel track: confirm marketplace schema compatibility so the same
   plugin repo ships to both Claude Code and Codex.
