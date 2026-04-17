# trib-plugin Configuration Reference

All settings live in `config.json` inside the plugin data directory (`$CLAUDE_PLUGIN_DATA/config.json`).

---

## Top-Level

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backend` | `"discord"` | `"discord"` | Messaging backend (only Discord supported) |
| `discord` | object | — | Discord connection settings |
| `discord.token` | string | **required** | Discord bot token |
| `discord.stateDir` | string | `<data>/discord` | Directory for Discord state files |
| `access` | object | — | Access control settings |
| `channelsConfig` | object | — | Named channel configuration |
| `contextFiles` | string[] | `[]` | MD file paths injected as additional context |
| `nonInteractive` | TimedSchedule[] | `[]` | Spawns separate `claude -p` sessions at scheduled times |
| `interactive` | TimedSchedule[] | `[]` | Injects prompts into the current session at scheduled times |
| `proactive` | object | — | Bot-initiated conversation settings |
| `promptsDir` | string | — | Directory containing prompt `.md` files |
| `voice` | object | — | Voice message transcription settings |
| `language` | string | — | UI / response language override (`"ko"`, `"en"`, `"ja"`) |
| `webhook` | object | — | Webhook receiver configuration |
| `events` | object | — | Event automation system configuration |
| `embedding` | object | — | Embedding provider configuration |
| `memory` | object | — | Memory cycle configuration (see below) |

---

## `access`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"disabled"` | `"pairing"` | DM access policy |
| `allowFrom` | string[] | `[]` | User IDs allowed to interact |
| `channels` | object | `{}` | Per-channel access policies |
| `channels.<id>.requireMention` | boolean | — | Whether bot requires @mention |
| `channels.<id>.allowFrom` | string[] | — | User IDs allowed in this channel |
| `mentionPatterns` | string[] | — | Custom mention patterns |
| `ackReaction` | string | — | Emoji reaction for message acknowledgment |
| `replyToMode` | `"off"` \| `"first"` \| `"all"` | — | Reply threading mode |
| `textChunkLimit` | number | — | Max characters per message chunk |
| `chunkMode` | `"length"` \| `"newline"` | — | How to split long messages |

---

## `channelsConfig`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `main` | string | `"general"` | Label of the main channel |
| `channels` | object | — | Named channels map |
| `channels.<name>.id` | string | — | Platform-specific channel ID |
| `channels.<name>.mode` | `"interactive"` \| `"monitor"` | — | `interactive` = listen + respond, `monitor` = listen only |

---

## `voice`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `command` | string | auto-detect | Whisper binary name or absolute path |
| `model` | string | — | GGML model file path |
| `language` | string | `"auto"` | BCP-47 language code or `"auto"` |

---

## `embedding`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | `"local"` \| `"ollama"` | `"local"` | Embedding provider |
| `ollamaModel` | string | — | Ollama model name (when provider is `"ollama"`) |

`provider: "local"` uses `Xenova/bge-m3` (1024 dimensions) by default.
The model is downloaded automatically on first use through `@xenova/transformers`, so no extra Ollama setup is required.
When switching embedding models, rebuild the memory vectors before relying on dense retrieval again.

---

## `memory`

Memory cycle configuration. The runtime centers on one active worker plus one manual consolidation path:

- **cycle1**: Main update worker — runs on an interval and can auto-trigger when pending candidates back up
- **cycle2**: Consolidation settings — used by the merged update flow and manual refresh paths

### `memory.cycle1`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `interval` | string | `"5m"` | Extraction interval. Values: `"immediate"`, `"5m"`, `"10m"`, `"30m"`, `"1h"`. `"immediate"` triggers on every new episode instead of using a timer. |
| `maxPending` | number | — | When pending candidates reach this count, cycle1 auto-runs immediately. Unset = disabled. |
| `timeout` | number | `60000` | LLM call timeout in milliseconds |
| `maxCandidatesPerBatch` | number | `50` | Max candidates processed per LLM batch |
| `maxBatches` | number | `5` | Max batches per cycle1 run |
| `provider` | object | codex | LLM provider for extraction |
| `provider.connection` | string | `"codex"` | Provider type: `"codex"`, `"cli"`, `"ollama"`, `"api"` |
| `provider.model` | string | `"gpt-5.4"` | Model identifier |
| `provider.effort` | string | `"medium"` | Reasoning effort level |
| `provider.fast` | boolean | `true` | Use fast service tier |
| `provider.baseUrl` | string | — | Custom API base URL (for `"ollama"` or `"api"`) |

### `memory.cycle2`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `interval` | string | `"1h"` | Interval between consolidation runs (e.g. `"1h"`, `"30m"`) |
| `maxCandidates` | number | — | When pending candidates exceed this count, consolidation runs immediately (bypasses interval). Unset = no auto-trigger. |
| `provider` | object | codex | LLM provider for consolidation |
| `provider.connection` | string | `"codex"` | Provider type |
| `provider.model` | string | `"gpt-5.4"` | Model identifier |
| `provider.effort` | string | `"medium"` | Reasoning effort level |
| `provider.fast` | boolean | `true` | Use fast service tier |
| `provider.baseUrl` | string | — | Custom API base URL |

## `retrieval`

Retrieval tuning configuration. All keys are optional; if omitted, the current built-in defaults remain active.

### `retrieval.intent`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `topScoreMin` | number | `0.74` | Minimum top intent score before considering the classifier confident |
| `gapMin` | number | `0.05` | Minimum gap between top-1 and top-2 intent scores |

### `retrieval.secondStageThreshold`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `default` | number | `-0.50` | Fallback second-stage threshold |
| `profile` | number | `-0.42` | Profile intent threshold |
| `task` | number | `-0.42` | Task intent threshold |
| `policy` | number | `-0.44` | Policy intent threshold |
| `history` | number | `-0.40` | History intent threshold |
| `event` | number | `-0.40` | Event intent threshold |
| `graph` | number | `-0.46` | Graph intent threshold |

### `retrieval.weights`

Representative tuning groups:

- `recency.*`
- `overlap.*`
- `typeBoost.*`
- `intentBoost.*`
- `taskStagePenalty.*`
- `doneTask.*`
- `taskSeed.*`
- `history.representative.*`
- `history.exactDate.*`

---

## Example Configuration

```json
{
  "backend": "discord",
  "discord": {
    "token": "YOUR_BOT_TOKEN"
  },
  "channelsConfig": {
    "main": "general",
    "channels": {
      "general": { "id": "123456789", "mode": "interactive" }
    }
  },
  "access": {
    "dmPolicy": "pairing",
    "allowFrom": ["USER_ID"]
  },
  "embedding": {
    "provider": "local"
  },
  "memory": {
    "cycle1": {
      "interval": "5m",
      "maxPending": 30,
      "provider": {
        "connection": "codex",
        "model": "gpt-5.4",
        "effort": "medium",
        "fast": true
      }
    },
    "cycle2": {
      "interval": "1h",
      "maxCandidates": 50,
      "provider": {
        "connection": "codex",
        "model": "gpt-5.4",
        "effort": "medium",
        "fast": true
      }
    },
    "cycle3": {
      "schedule": "03:00",
      "day": "daily",
      "hardDelete": false,
      "provider": {
        "connection": "codex",
        "model": "gpt-5.4",
        "effort": "medium",
        "fast": true
      }
    }
  },
  "retrieval": {
    "intent": {
      "topScoreMin": 0.74,
      "gapMin": 0.05
    },
    "secondStageThreshold": {
      "default": -0.5,
      "task": -0.42,
      "history": -0.4
    },
    "weights": {
      "taskStagePenalty": {
        "planned": 0.12,
        "implementing": -0.03
      },
      "taskSeed": {
        "ongoingQuery": {
          "plannedPenalty": -0.85
        }
      }
    }
  }
}
```

---

## Provider Types

| Connection | Description | Requirements |
|-----------|-------------|--------------|
| `codex` | OpenAI Codex CLI | `codex` binary in PATH |
| `cli` | Claude Code CLI (`claude -p`) | `claude` binary in PATH |
| `ollama` | Local Ollama server | Ollama running, `baseUrl` optional |
| `api` | Direct API call | `baseUrl` required |

---

## Fact Status Values

Facts in the memory database can have the following status values:

| Status | Description |
|--------|-------------|
| `active` | Current, valid fact — included in search results |
| `stale` | Not seen recently — excluded from active queries |
| `superseded` | Replaced by a newer fact (via semantic dedup, similarity > 0.75) |
| `deprecated` | Explicitly deprecated — excluded from all searches |

---

## v0.6.10 Always-On Features (no toggles, single-path)

v0.6.10 ships these features active by default. There are **no enable/disable toggles, no silent fallbacks, no recovery retry**. Failures surface to the caller as exceptions or trip per-task cooldowns. Operators wanting different behaviour change the code, not config.

> Note: transport-level retries that already existed before v0.6.10 (e.g. OpenAI OAuth 502/503 before the SSE stream starts) are preserved. "No recovery retry" above refers to silent re-issuance after a feature-level failure (cache-create failure, summary failure, etc.) — those now surface rather than being masked.

### Anthropic ephemeral cache_control (5m, always-on)
- The provider always sets `cache_control: { type: 'ephemeral' }` on the system block and the last few non-system messages. The 1h extended-TTL beta is not exposed.
- The `providers.anthropic.cacheTtl` key is removed.

### OpenAI OAuth stateless single-path
- The Codex OAuth Responses contract is stateless-only: every call sets `store: false` and re-sends the full transcript. The endpoint rejects `store: true` with HTTP 400 (`Store must be set to false`).
- `previous_response_id`-based continuation is not supported on the Codex OAuth path; server-side auto-cache is achieved via `prompt_cache_key` (see prompt caching section).
- Phase 3a (stateful continuation) only applies to Responses-API providers that expose a stable `previous_response_id`. The plugin does not implement that path currently — see `docs/ROADMAP.md` Phase 3 Decision Gate.

### Gemini context cache (always-on)
- The provider always creates and reuses `cachedContent` per session (TTL 1h, min 1024 prefix tokens).
- Cache-create failure throws — no silent non-cached fallback.
- The `providers.gemini.cache.enabled` key is removed.

### Bridge context compaction (LLM-summarized, always-on)
- `compactMessages` runs every turn. It self-skips when prompt tokens are below `0.50 × context_length` or when the summary cooldown is active. On LLM summary failure: trip a 600s per-process cooldown and pass the messages through unchanged.
- After compaction, `trimMessages` runs as the byte-budget safety pass.
- All compaction tunables (`thresholdPercent`, `protectFirstN`, `protectLastN`, `summaryTargetRatio`, `tailTokenBudget`, `summaryModel`, `failureCooldownMs`) are hardcoded constants.
- The `bridge.compaction.*` keys (including `enabled` and `toolPrune`) are removed.

### Semantic cache (allow-list scopes, always-on)
- Lookup + store run automatically for any `callLLM(..., { cacheScope })` call when the scope is in the hardcoded allow-list:
  `classify` / `core-promote-phase1` / `core-promote-phase2` / `core-promote-phase3` / `reason` / `skill-suggest` (cosine similarity ≥ per-scope threshold) and `proactive` (exact hash only).
- Bridge `agentLoop`, provider `send()`, and tool execution never pass `cacheScope` by policy and are excluded.
- All tunables (per-scope `threshold`, `exactOnly`, `ttlDays`, `maxEntries`) are hardcoded constants.
- The `semanticCache.*` keys (including `enabled` and per-scope `enabled`) are removed.

### Memory cycle (single preset, no cascade)
- Each maintenance task uses one preset. On exception or empty output the per-task 600s cooldown trips and the error surfaces.
- The `cycle.cascade` key is **deprecated and ignored**. A stderr warning is emitted once per process if the key is present.

### Trim Pass 0 — old tool result pruning (always-on)
- `pruneOldToolResults` always runs as Pass 0 of `trimMessages`, replacing old `role: 'tool'` bodies (>200 chars) with a short stub. Message count is preserved.

### Verification Metrics
- `bridge-trace.jsonl`: kinds `loop` / `tool` / `fetch` / `sse` / `usage`. Stateful continuation adds a `response_id` field on `usage` events for correlation across iterations.
- `model-profile.jsonl`: 4 phases per model (`baseline`, `load`, `warmup`, `steady`), plus `post-idle` on dispose.
- `history/semantic-cache.jsonl`: per-lookup `hit` (`exact` / `semantic` / `null`), optional `similarity`, and estimated `savedTokens` from the cached response length. One line appended per allow-listed scope lookup.
