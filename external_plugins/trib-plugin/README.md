# trib-plugin

Discord integration plugin for Claude Code. Provides messaging, scheduling, proactive chat, voice transcription, webhook events, and access control.

## MCP Tools

| Tool | Description |
|------|-------------|
| `reply` | Send message to Discord (text, embeds, components, files up to 25MB × 10) |
| `react` | Add emoji reaction |
| `edit_message` | Edit previously sent message |
| `fetch` | Retrieve recent channel messages (max 100) |
| `download_attachment` | Download attachments to local inbox |
| `schedule_status` | View all schedules, fire times, running state |
| `trigger_schedule` | Manually trigger a named schedule |
| `schedule_control` | Defer (default 30m) or skip_today |
| `activate_channel_bridge` | Toggle bridge (typing indicators, emoji, auto-forward transcript) |
| `inject` | Internal — notification injection from trib-agent async results |

## Scheduling

### Two Execution Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Non-interactive** | Fixed time | Spawns separate `claude -p` session |
| **Interactive** | Fixed time | Injects prompt into current session via MCP notification |

### Behavioral Modes

| User State | Schedule Behavior |
|------------|-------------------|
| Idle | **Execute mode** — start naturally without asking |
| Active | **Ask-first mode** — suggest transition, don't interrupt |

### Proactive Chat

- Frequency levels 1-5 (3-15 fires per day)
- Memory-aware topic selection (avoids repetition via proactive-history.md)
- Feedback tracking (positive/negative/no-response in proactive-feedback.md)
- Silent fallback — no forced conversation if no good topic found

## Voice Transcription

- Whisper.cpp + FFmpeg pipeline
- Auto-detects browser binary paths across OS
- BCP-47 language support with device fallback
- Audio → WAV 16kHz mono → Whisper → text injection

## Access Control

| Method | Description |
|--------|-------------|
| DM Pairing | Unauthenticated user gets one-time code, admin approves |
| Allowlist | Static per-channel user ID allowlist |
| Mention Requirement | Per-channel `requireMention` flag |

## Event Pipeline

Three trigger sources with priority levels:

| Source | Description |
|--------|-------------|
| webhook | HTTP receiver with HMAC-SHA256 verification (GitHub, Sentry, Stripe, generic) |
| watcher | Chat message regex matching |
| file | Glob-based file watching |

Priority: high (immediate), normal (idle), low (batch).

## Hooks

| Event | Handler | Purpose |
|-------|---------|---------|
| SessionStart | `session-start.cjs` | Initialize Discord state |
| PermissionRequest | `permission-request.cjs` | DM pairing workflow (15 min timeout) |
| PostToolUse | `post-tool-use.cjs` | State sync, transcript ingestion |

## Multi-Instance Support

- Active instance tracking via status files
- HTTP proxy mode for non-owner instances
- Port-based ownership election (3460-3467)
- Stale owner timeout (10s)

## Configuration

```text
$CLAUDE_PLUGIN_DATA/config.json
├── backend              ("discord")
├── discord              (token, state directory)
├── access               (DM policy, allowlists, mention patterns)
├── channelsConfig       (per-channel modes, role mappings)
├── nonInteractive[]     (scheduled claude -p sessions)
├── interactive[]        (in-session prompt schedules)
├── proactive            (frequency, idle guard, DND windows)
├── voice                (command, model, language)
├── webhook              (port, ngrok, HMAC secret)
├── events[]             (webhook/watcher/file rules)
├── contextFiles[]       (additional .md context injection)
├── memory               (cycle1 settings, provider)
└── language             (ko, en, ja)
```

## Key Files

| File | Purpose |
|------|---------|
| `server.ts` | MCP server, tool handlers |
| `backends/discord.ts` | Discord.js v14 client lifecycle |
| `lib/scheduler.ts` | Schedule engine (non-interactive, interactive, proactive) |
| `lib/output-forwarder.ts` | Auto-forward transcript to Discord |
| `lib/event-pipeline.ts` | Webhook/watcher/file event processing |
| `lib/webhook.ts` | HTTP server with HMAC verification |
| `lib/runtime-paths.ts` | Multi-instance ownership coordination |

## Notes

- All documented features are implemented — no plan-only documents
- Discord.js v14.14.0
- Supports ngrok for external webhook access
