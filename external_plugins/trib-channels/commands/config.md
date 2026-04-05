---
description: Read or update trib-channels config values directly.
args: "[path] [value]"
allowed-tools:
  - Read
  - Write
  - Edit
---

# trib-channels Config

Manage `${CLAUDE_PLUGIN_DATA}/config.json` directly.

## Behavior

- If no args are provided:
  - read the config file
  - print a compact summary
- If only `path` is provided:
  - print the current value at that path
- If both `path` and `value` are provided:
  - update the config at that path
  - write the file back

## Supported paths

- `discord.token`
- `access.dmPolicy`
- `access.allowFrom`
- `access.channels`
- `channelsConfig.main`
- `channelsConfig.channels`

## Special rules

- If a path ends with `.token`, never print the full secret back. Show only `set` or `empty`.
- If a path is missing, create the parent object as needed.
