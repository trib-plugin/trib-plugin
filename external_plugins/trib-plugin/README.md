# trib-plugin

Unified integration platform for Claude Code. A single MCP server exposes four cooperating modules — **channels**, **memory**, **search**, and **agent** — alongside a bundled set of local filesystem / shell / code-navigation tools.

## Modules

| Module    | Purpose                                                                                                          |
|-----------|------------------------------------------------------------------------------------------------------------------|
| `channels`| Discord backend: message I/O, scheduler (timed + proactive), voice pipeline, webhook receiver, event routing.    |
| `memory`  | Persistent semantic memory: hybrid (FTS + vector) search, chunk/curate pipeline, core-memory promotion.          |
| `search`  | Web search with auto-routing across multiple providers; URL scrape; GitHub code / issue / repo lookup.           |
| `agent`   | External AI session orchestration — multi-provider registry, delegated execution, workflow store.               |

All modules live under `src/<module>/index.mjs` and share the same entry point (`server.mjs`). Source is plain ESM — no bundler, no build step for runtime code.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  server.mjs  (MCP handshake, static TOOL_DEFS)   │
│                                                  │
│   ListTools → tools.json (36 tools)              │
│   CallTool  → TOOL_MODULE[name] → loadModule()   │
│                                                  │
│   ┌──────────┬──────────┬──────────┬──────────┐  │
│   │ channels │  memory  │  search  │  agent   │  │
│   └──────────┴──────────┴──────────┴──────────┘  │
│         (all four eager-init after handshake)    │
└──────────────────────────────────────────────────┘
```

- **Static `ListTools`** — `tools.json` is read synchronously at startup, so the MCP handshake returns in a few milliseconds regardless of module weight.
- **Module lifecycle** — `memory` initializes first (channels depends on it for episode delivery), then `channels`, then `search` and `agent`. All four boot eagerly; `loadModule()` caches the module so the first `CallTool` for any tool returns immediately.
- **Worker processes** — `channels` and `memory` are forked as child workers; `search` and `agent` are loaded in-process.
- **Singleton lock** — a pidfile in `$CLAUDE_PLUGIN_DATA/server.lock` prevents two `server.mjs` instances (e.g. marketplace vs cache path) from running in parallel.

## Tools (36)

Each tool is routed to the module listed in `tools.json`.

### channels (10)
`reply`, `react`, `edit_message`, `download_attachment`, `fetch`, `schedule_status`, `trigger_schedule`, `schedule_control`, `activate_channel_bridge`, `reload_config`

### memory (3)
`memory`, `recall`, `explore` — `recall` and `explore` are synthesized answers from an internal retrieval agent.

### search (1)
`search` — synthesized answer from an internal web / scrape / GitHub dispatcher.

### agent (5)
`create_session`, `list_sessions`, `close_session`, `list_models`, `bridge`

### builtin (9)
`read`, `edit`, `edit_lines`, `write`, `bash`, `grep`, `glob`, `list`, `diff`

### lsp (4)
`lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols`

### astgrep (2)
`sg_search`, `sg_rewrite`

### patch (1)
`apply_patch`

### bash_session (1)
`bash_session`

## Layout

```
trib-plugin/
├── server.mjs                       # MCP entry point
├── tools.json                       # Static manifest (36 tools + module tag)
├── package.json
├── .claude-plugin/plugin.json       # version
├── .mcp.json
├── agents/                          # Claude Code agent role definitions
├── commands/                        # Claude Code slash commands
├── hooks/
│   ├── hooks.json                   # SessionStart, PostToolUse
│   ├── session-start.cjs
│   └── post-tool-use.cjs
├── rules/                           # Lead / bridge / shared rule snippets
├── scripts/
│   └── build-tools-manifest.mjs     # npm run build:tools
└── src/
    ├── channels/                    # Discord, scheduler, webhook, events, voice
    ├── memory/                      # sqlite-vec, embeddings, chunker, curator
    ├── search/                      # providers, scraper, formatter
    ├── agent/                       # orchestrator, sessions, providers, tools
    └── shared/                      # llm cost / usage, config, seed
```

## Channels — Detail

### Scheduling
| Mode             | Trigger       | Behavior                                                                |
|------------------|---------------|-------------------------------------------------------------------------|
| Non-interactive  | Cron / time   | Spawns a separate `claude -p` session                                   |
| Interactive      | Cron / time   | Injects a prompt into the active Claude Code session over MCP           |

Schedules may carry a `script` (produces input), a `prompt` (template), or both.

### Proactive chat
- Frequency levels 1–5 (3 / 5 / 7 / 10 / 15 fires per day, with matching 180 / 120 / 90 / 60 / 30-minute idle guards).
- Topic selection delegated to a dedicated scheduler role (`rules/bridge/50-proactive-decision.md`). Decisions read from core memory only; on `skip` the slot is dropped silently.
- Per-source engagement scoring feeds back into future topic picks.

### Voice transcription
- Whisper.cpp + FFmpeg pipeline.
- Auto-detects browser / FFmpeg binaries across platforms.
- Attachment → WAV 16 kHz mono → Whisper → message injection.

### Access control
| Method              | Description                                                 |
|---------------------|-------------------------------------------------------------|
| DM pairing          | Unauthenticated user receives a one-time code; admin approves |
| Allowlist           | Per-channel user-ID allowlist                               |
| Mention requirement | Per-channel `requireMention` flag                           |

### Event pipeline
Three trigger sources feed a single priority queue (high / normal / low):

| Source   | Description                                                                      |
|----------|----------------------------------------------------------------------------------|
| webhook  | HTTP receiver with optional HMAC-SHA256 verification (GitHub, Sentry, Stripe, generic) |
| watcher  | Chat-message regex matching                                                      |
| file     | Glob-based file watcher                                                          |

A rule picks a parser, an optional filter, and a prompt template; matches are enqueued and handed to the scheduler for execution.

### Multi-instance coordination
The webhook HTTP server tries to bind in the range **3460–3467**. The first live instance owns the port; later instances detect the incumbent and run as HTTP proxies, forwarding rebinds through an `active-instance.json` file under the OS temp directory.

## Memory — Detail

- **Two-pass pipeline** — a **chunker** pass groups recent entries into coherent chunks and classifies them; a **curator** pass re-scores existing roots, promotes / demotes, merges duplicates, and archives. Both passes run on a timer inside the memory worker and call out to a small LLM via the agent bridge.
- **Categories** (grade-weighted) — `rule`, `constraint`, `decision`, `fact`, `goal`, `preference`, `task`, `issue`.
- **Core-memory states** — `active`, `pending`, `demoted`, `archived`, `processed`. Chunk status tracks the root; demoted entries need repeated mentions to revive.
- **Hybrid retrieval** — FTS + vector (sqlite-vec), combined with RRF, importance weight, and time decay.
- **LLM-gated promotion** — the curator judges "does this describe the user durably?" rather than relying on numeric thresholds. Anything that is transient, project-specific, or purely technical stays out of active core memory.

## Search — Detail

- Single user-facing tool: `search`. An internal dispatcher picks the right backend per query.
- **Web search providers** — Serper, Brave, Perplexity, Firecrawl, Tavily, xAI. The provider chain is configurable; usage and quotas are tracked per provider.
- **URL scrape** — Puppeteer-core (optional) with Mozilla Readability fallback; Firecrawl is used when a remote scraper is preferred.
- **GitHub routing** — queries shaped like `owner/repo`, or tagged as code / issue / PR lookups, are dispatched directly to the GitHub API path.
- Passing a `query` array fans out the same call across multiple angles and merges the results.

## Agent — Detail

- **Provider registry** — OpenAI (+ OAuth), Anthropic (+ OAuth), Gemini, Copilot, Groq, OpenRouter, xAI, Ollama, LM Studio, and a generic `local` OpenAI-compatible slot. Each provider is enabled per-key in config.
- **Session manager** — `bridge` is the single entry point for delegated execution; role names are user-defined in `user-workflow.json` and surfaced to Lead as a `# Roles` rule block. Sessions are tracked with idle-sweep cleanup and survive across MCP restarts only when still live.
- **Activity bus + stall watchdog** — a per-session ticker notifies the channels scheduler on every dispatch; a stream-level watchdog aborts at hard stall thresholds so a dead provider never wedges a session.
- **Workflow store** — pre-canned plans (code review, quick research) plus any user-defined workflow. Workflows compile into a prompt + role pair at dispatch time.
- **Context injection** — at dispatch, the agent composes a cached system prompt from `CLAUDE.md`, role snippets under `rules/`, and relevant skills. External provider calls reuse the cached prefix when the provider supports it.

## Hooks

Only two hooks are registered in `hooks/hooks.json`:

| Event         | Handler                | Purpose                                                                                 |
|---------------|------------------------|-----------------------------------------------------------------------------------------|
| SessionStart  | `session-start.cjs`    | Injects rule blocks and core-memory / recap context into the starting Claude session.   |
| PostToolUse   | `post-tool-use.cjs`    | Writes a `tool-exec-*.signal` file consumed by the sub-agent permission flow in `pre-tool-subagent.cjs` and the channels worker's permission-request watcher. |

There is no `PermissionRequest` hook — channel-side permission prompts arrive as MCP notifications (`claude/channel/permission_request`) and are forwarded directly into the channels worker.

## Configuration

Persistent configuration lives under `$CLAUDE_PLUGIN_DATA/trib-config.json`. On boot, `server.mjs` splits it into per-module files (`config.json`, `agent-config.json`, `memory-config.json`, `search-config.json`); editing the per-module files is also supported and reverse-merged on next boot.

Main sections of `config.json` (channels):

```text
backend            ("discord")
discord            (token, state directory)
access             (DM policy, allowlists, mention patterns)
channelsConfig     (per-channel modes, role mappings, requireMention)
nonInteractive[]   (scheduled claude -p sessions)
interactive[]      (in-session prompt schedules)
proactive          (frequency 1–5, idle guard, DND windows)
voice              (command, model, language)
webhook            (port range 3460–3467, ngrok, HMAC secret)
events[]           (webhook / watcher / file rules)
contextFiles[]     (additional .md context injection)
promptInjection    (mode: "claude_md" disables hook injection)
language           ("ko" | "en" | "ja")
```

Memory, search, and agent keep their own config files; see `src/<module>/lib/config.mjs` for the authoritative schema.

## Development

- Every source file is `.mjs` — edit and restart, no build step for runtime code.
- The only build target is the tool manifest:
  ```sh
  npm run build:tools   # → tools.json
  ```
- Run the server locally:
  ```sh
  CLAUDE_PLUGIN_ROOT="$PWD" CLAUDE_PLUGIN_DATA="$PWD/.data" node server.mjs
  ```
- `server.mjs` requires both `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` to be set — there is no fallback. In production, Claude Code injects both.
- `npm test` runs the full suite; `node scripts/test-scheduler-idle.mjs` is a quick smoke test for the scheduler idle classifier.

## License

Apache-2.0
