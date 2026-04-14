# trib-plugin

Unified integration platform for Claude Code. Exposes four cooperating modules through a single MCP server: **channels**, **memory**, **search**, and **agent**.

## Modules

| Module    | Purpose                                                                                                       |
|-----------|---------------------------------------------------------------------------------------------------------------|
| `channels`| Multi-backend messaging (Discord by default), scheduler, proactive chat, voice, webhook, event pipeline.      |
| `memory`  | Persistent semantic memory — episode ingest, hybrid search, core-memory promotion backed by sqlite-vec.       |
| `search`  | Web search, scrape, crawl, and site map, with auto-routing to GitHub APIs for code/repo/issue queries.        |
| `agent`   | External AI session orchestration across multiple providers with preset-based worker / bridge roles.         |

All modules coexist under `src/<module>/index.mjs` and share the same entry point (`server.mjs`). No bundle, no build pipeline — every module is plain ESM that Node.js runs directly.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  server.mjs  (MCP handshake, static TOOL_DEFS)   │
│                                                  │
│   ListTools → tools.json (24 tools)              │
│   CallTool  → TOOL_MODULE[name] → loadModule()   │
│                                                  │
│   ┌──────────┬──────────┬──────────┬──────────┐  │
│   │ channels │  memory  │  search  │  agent   │  │
│   │  (eager) │  (lazy)  │  (lazy)  │  (lazy)  │  │
│   └──────────┴──────────┴──────────┴──────────┘  │
└──────────────────────────────────────────────────┘
```

- **Static `ListTools`** — `tools.json` is loaded synchronously at startup, so the MCP handshake returns in a few milliseconds regardless of module weight.
- **`channels` eager init** — scheduled right after `transport.connect()` via `setImmediate`, because its workers (Discord gateway, webhook HTTP server, scheduler, event pipeline) must run before any tool call.
- **`memory` / `search` / `agent` lazy init** — each module boots on its first `CallTool`, then its handlers are cached.

## MCP Tools (24)

### channels (10)
`reply`, `react`, `edit_message`, `download_attachment`, `fetch`, `schedule_status`, `trigger_schedule`, `schedule_control`, `activate_channel_bridge`, `reload_config`

### memory (2)
`memory`, `search_memories`

### search (6)
`search`, `firecrawl_scrape`, `firecrawl_map`, `crawl`, `batch`, `setup`

### agent (6)
`create_session`, `list_sessions`, `close_session`, `list_models`, `get_workflows`, `get_workflow`

## Layout

```
trib-plugin/
├── server.mjs                       # MCP entry point
├── tools.json                       # Static manifest (24 tools + module tag)
├── package.json
├── .claude-plugin/plugin.json
├── .mcp.json
├── scripts/
│   └── build-tools-manifest.mjs     # npm run build:tools
└── src/
    ├── channels/                    # Discord backend, scheduler, webhook, events, voice
    ├── memory/                      # sqlite-vec, embeddings, classification, LLM worker
    ├── search/                      # providers, scraper, crawler, formatter
    └── agent/                       # orchestrator, sessions, providers, tools
```

## Channels — Detail

### Scheduling
| Mode             | Trigger    | Behavior                                                                |
|------------------|------------|-------------------------------------------------------------------------|
| Non-interactive  | Fixed time | Spawns a separate `claude -p` session                                   |
| Interactive      | Fixed time | Injects a prompt into the current session via MCP notification          |

### Proactive chat
- Frequency levels 1–5 (3–15 fires per day)
- Memory-aware topic selection (history + feedback tracking)
- Silent skip when no good topic is available

### Voice transcription
- Whisper.cpp + FFmpeg pipeline
- Auto-detects browser binary paths across OS
- Audio → WAV 16 kHz mono → Whisper → text injection

### Access control
| Method              | Description                                                 |
|---------------------|-------------------------------------------------------------|
| DM pairing          | Unauthenticated user gets a one-time code, admin approves   |
| Allowlist           | Static per-channel user-ID allowlist                        |
| Mention requirement | Per-channel `requireMention` flag                           |

### Event pipeline
Three trigger sources with priority levels (high / normal / low):

| Source   | Description                                                                      |
|----------|----------------------------------------------------------------------------------|
| webhook  | HTTP receiver with HMAC-SHA256 verification (GitHub, Sentry, Stripe, generic)    |
| watcher  | Chat-message regex matching                                                      |
| file     | Glob-based file watching                                                         |

### Multi-instance coordination
Port-based ownership election (3460–3467) with stale-owner timeout. Non-owners run in HTTP proxy mode.

## Memory — Detail

- Two-cycle pipeline: `cycle1` (episode collection, classification, chunking, embedding) and `cycle2` (dedup + core-memory promotion).
- Core-memory states: `active` / `pending` / `demoted` / `archived` / `processed`.
- Hybrid search (FTS + vector) with unified scoring (RRF + importance + time decay).
- LLM-based promotion — core memory is judged by a prompt, not by numeric scores.
- Chunk status syncs with core-memory status; demoted entries need `mention_count >= 3` to revive.

## Search — Detail

- Google / Brave / Bing web search, routed to GitHub APIs for code/repo/issue queries.
- Firecrawl-style scrape and map via Puppeteer + Readability.
- `batch` runs multiple `search`/`firecrawl_scrape`/`firecrawl_map` actions in parallel (up to 10 per call).

## Agent — Detail

- Provider registry: OpenAI, OpenAI OAuth, Anthropic, Gemini, Groq, OpenRouter, xAI, Copilot, Ollama, LM Studio, local.
- Session manager with preset-based `Worker` / `Bridge` roles.
- Workflow store (code-review, quick-research, and user-defined plans).
- Auto-injects CLAUDE.md, agent rules, and skills into external sessions.

## Hooks

| Event             | Handler                     | Purpose                                       |
|-------------------|-----------------------------|-----------------------------------------------|
| SessionStart      | `session-start.cjs`         | Initialize channel state                      |
| PermissionRequest | `permission-request.cjs`    | DM pairing workflow (15 min timeout)          |
| PostToolUse       | `post-tool-use.cjs`         | State sync, transcript ingestion              |

## Configuration

Per-user config lives under `$CLAUDE_PLUGIN_DATA/config.json`. Key sections:

```text
backend            ("discord")
discord            (token, state directory)
access             (DM policy, allowlists, mention patterns)
channelsConfig     (per-channel modes, role mappings)
nonInteractive[]   (scheduled claude -p sessions)
interactive[]      (in-session prompt schedules)
proactive          (frequency, idle guard, DND windows)
voice              (command, model, language)
webhook            (port, ngrok, HMAC secret)
events[]           (webhook / watcher / file rules)
contextFiles[]     (additional .md context injection)
memory             (cycle1 settings, provider)
language           (ko, en, ja)
```

## Development

- Every module is `.mjs` — edit directly, no build step for source.
- The only build target is the tool manifest:
  ```sh
  npm run build:tools   # → tools.json
  ```
- Run the server locally:
  ```sh
  CLAUDE_PLUGIN_ROOT="$PWD" CLAUDE_PLUGIN_DATA="$PWD/.data" node server.mjs
  ```
- `server.mjs` requires `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` to be set — there is no fallback. In production, Claude Code injects both.

## License

Apache-2.0
