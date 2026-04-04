---
description: "Quick channel operations -- status, fetch, schedule overview."
args: "<action> [arguments...]"
allowed-tools:
  - mcp__plugin_trib-channels_trib-channels__schedule_status
  - mcp__plugin_trib-channels_trib-channels__fetch
  - mcp__plugin_trib-channels_trib-channels__trigger_schedule
  - Read
---

# /trib-channels:channels -- Quick Channel Operations

Parse `$ARGUMENTS` and route to the appropriate action.

```
$ARGUMENTS
```

## Routing

| Action | Behavior |
|--------|----------|
| (empty) / `status` | Show channel connection status and registered channels |
| `fetch [channel] [count]` | Fetch recent messages from a channel |
| `schedule` / `schedules` | Show all schedules via `schedule_status` tool |
| `trigger <name>` | Trigger a schedule immediately via `trigger_schedule` tool |
| `send` | Explain: use the reply MCP tool in channel context, or redirect to `/trib-channels:setup` |

## Status

Read `${CLAUDE_PLUGIN_DATA}/config.json` and display:
- Backend type and connection state
- Registered channels (label, ID, mode)
- Main channel
- Access policy summary

## Fetch

Call `fetch` with optional channel and count parameters.
Default to the main channel if none specified.
Default to 10 messages if count not specified.

## Schedule

Call `schedule_status` and present grouped by category (non-interactive, interactive, proactive).

## Trigger

Call `trigger_schedule(name="<name>")` with the provided schedule name.
