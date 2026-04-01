# trib-memory RAG Injection Architecture

## Overview

trib-memory is a standalone Claude Code plugin that provides persistent memory
through a hybrid RAG (Retrieval-Augmented Generation) system. It injects memory
context into Claude sessions via **two complementary paths** and **one guard**.

```
┌─────────────────────────────────────────────────────┐
│                   Claude Session                     │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Passive Path  │  │ Active Path   │  │   Guard    │ │
│  │ (per-turn)   │  │ (on-demand)  │  │ (blocker)  │ │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                  │                 │        │
└─────────┼──────────────────┼─────────────────┼────────┘
          │                  │                 │
  UserPromptSubmit    recall_memory      PreToolUse
     hook              MCP tool            hook
          │                  │                 │
          ▼                  ▼                 ▼
┌─────────────────────────────────────────────────────┐
│              memory-service.mjs                      │
│  ┌──────────┐  ┌────────────┐  ┌──────────────────┐ │
│  │ HTTP:3350 │  │ MCP stdio  │  │ SQLite + vector  │ │
│  │ /hints    │  │ tools      │  │ hybrid search    │ │
│  │ /context  │  │            │  │                  │ │
│  │ /episode  │  │            │  │                  │ │
│  └──────────┘  └────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────┘
```

## Injection Paths

### 1. Passive Path — Per-Turn Hint Injection

**Hook:** `UserPromptSubmit` → `hooks/memory-hint.cjs`

Every time the user sends a message, the hook:
1. Reads the memory-service HTTP port from `$TMPDIR/trib-memory/memory-port`
2. Sends the user prompt to `GET /hints?q=<prompt>`
3. memory-service runs intent classification + hybrid search
4. Returns ranked hints as `<memory-context>` block
5. Hook injects via `additionalContext` (appears in system-reminder)

**Characteristics:**
- Automatic, zero effort from Claude
- Lightweight (top-N hints only, truncated)
- May contain noise (recent tasks surfaced regardless of relevance)
- Latency budget: 8s timeout

**Hint types:** `fact`, `task`, `episode`, `signal`, `profile`

### 2. Active Path — On-Demand Recall

**MCP tool:** `recall_memory` (7 modes)

When passive hints are insufficient, Claude explicitly calls recall_memory:

| Mode | Use Case | Key Params |
|------|----------|------------|
| `search` | Broad hybrid search (default) | `query`, `type`, `timerange` |
| `verify` | Confirm/deny a specific claim | `query` |
| `episodes` | Conversation/event history | `query`, `timerange`, `context`, `source` |
| `tasks` | Active work items | `query`, `task_status` |
| `policy` | Rules, constraints, restrictions | `query` |
| `profile` | User preferences, language, tone | `query` |
| `bulk` | Batch-verify hint list | `hints[]` |

**Routing guide:**
- Date/timeline lookup → `episodes` + `timerange`
- Event/topic recall → `episodes` + `query` (+ `timerange`)
- Rule/restriction check → `verify` or `policy`
- Current work status → `tasks`
- User preference/tone → `profile`

**MCP Instructions:** Injected via `new Server({ instructions })` so every
MCP client (terminal, trib-channels, future plugins) receives the Memory Tool
Policy automatically.

### 3. Guard — Auto-Memory Blocker

**Hook:** `PreToolUse` (matcher: `Read|Write|Edit`) → `hooks/block-auto-memory.cjs`

Prevents Claude from using file-based auto-memory (`~/.claude/projects/*/memory/`)
when the MCP memory system is active:

1. Checks if `$TMPDIR/trib-memory/memory-port` exists (MCP running?)
2. If active: blocks Read/Write/Edit to memory files (except MEMORY.md reads)
3. If inactive: allows auto-memory as fallback
4. Returns `systemMessage` directing Claude to use `recall_memory` instead

**Purpose:** Ensures single source of truth. Without this guard, Claude would
write duplicate state to both the RAG system and auto-memory files.

## Memory Lifecycle

### Write Path (Ingestion)

```
Conversation turn
  → turn-end detection (fs.watch on transcript)
  → ingestTranscriptFile (incremental, offset-based)
  → memory extraction (facts, tasks, signals, episodes, entities, relations)
  → SQLite + vector embedding storage
```

### Read Path (Retrieval)

```
User prompt
  → intent classification (event/task/profile/policy/decision/history)
  → query plan (FTS + vector + metadata filters)
  → hybrid search (BM25 + cosine similarity)
  → reranking + decay scoring
  → formatted response
```

### Maintenance (memory_cycle)

| Action | Purpose |
|--------|---------|
| `cycle1` | Fast incremental update (recent turns) |
| `sleep` | Merged daily update (consolidate + context refresh) |
| `flush` | Force-consolidate pending memories |
| `rebuild` | Rebuild recent memory index |
| `prune` | Cleanup stale/duplicate entries |
| `status` | Health check |

## Session Bootstrap

### SessionStart (trib-channels only)

`trib-channels/hooks/session-start.cjs` loads:
1. `contextFiles` from config.json
2. `context.md` — memory bridge (SQLite → rendered summary)
3. `settings.local.md` — user overrides

This provides initial context before the first UserPromptSubmit fires.

**Note:** trib-memory itself has no SessionStart hook. The passive path
activates on the first user prompt. For richer session bootstrap, the
consuming plugin (trib-channels) handles it.

## Plugin Boundaries

```
trib-memory (standalone)          trib-channels (channel)
├── .claude-plugin/plugin.json    ├── .claude-plugin/plugin.json
├── .mcp.json                     ├── .mcp.json
│   └── memory-service.mjs        │   └── server.ts (Discord MCP)
├── hooks/                        ├── hooks/
│   ├── hooks.json                │   ├── hooks.json
│   ├── memory-hint.cjs           │   ├── session-start.cjs
│   └── block-auto-memory.cjs     │   ├── permission-request.cjs
├── services/                     │   ├── control-worker.cjs
│   └── memory-service.mjs        │   └── stop.cjs
├── lib/                          ├── .mcp.json deps:
│   ├── memory.mjs                │   └── trib-memory (via plugin)
│   ├── memory-recall-store.mjs   │
│   ├── embedding-provider.mjs    └── No memory hooks
│   └── ...                           (trib-memory handles all)
└── defaults/
    └── prompts (cycle, consolidate, contextualize)
```

## Known Issues & Improvements

### Current Issues

1. **Hint relevance scoring** — Hints surface by recency rather than
   conversation context relevance. The intent classifier runs on the user
   prompt but doesn't weight against the ongoing conversation topic.

2. **No SessionStart hook in trib-memory** — Initial session context depends
   on trib-channels's session-start.cjs loading context.md. Standalone
   trib-memory users get no bootstrap context until their first prompt.

3. **Startup crash resilience** — memory-service.mjs can crash on first
   start (observed: 3x exit code=1 before recovery). No stderr capture in
   run-mcp.mjs makes debugging blind.

### Potential Improvements

1. **Add stderr capture to run-mcp.mjs** — Pipe child stderr to log file
   for crash diagnosis instead of silent exit code=1.

2. **SessionStart hook for trib-memory** — Generate and inject context.md
   summary at session start, independent of trib-channels.

3. **Conversation-aware hint scoring** — Weight hints by similarity to
   recent conversation turns, not just the current prompt.

4. **Hint deduplication** — Multiple plugins registering the same hook
   (legacy trib-channels + trib-memory) caused duplicate hints. Now resolved
   by removing trib-channels's legacy hooks.

5. **Graceful degradation signal** — When memory-service is down, hooks
   silently return empty. Consider surfacing a one-time notice so Claude
   knows recall_memory is unavailable.
