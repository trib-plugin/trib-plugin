# Orchestrator Merge Plan v1

Merge trib-orchestrator into trib-agent as a single unified plugin.

## Goal

Consolidate the multi-model orchestration capabilities of trib-orchestrator into trib-agent, eliminating a separate plugin while preserving all functionality. After merge, trib-orchestrator is deleted.

## MCP Tools (5)

| Tool | Description |
|------|-------------|
| `create_session` | Create an AI session with a specific provider and model. Auto-injects CLAUDE.md, agent rules, skills. Registers builtin+MCP tools. Supports `preset` (full/readonly/mcp) and `agent` (Worker/Reviewer). |
| `resume_session` | Resume an existing session after server restart. Refreshes tool registrations. Optionally change tool preset. |
| `list_sessions` | List all sessions (active and stored) with metadata (provider, model, message count, token usage). |
| `close_session` | Close and delete a session. |
| `list_models` | List available models from all enabled providers. |

**Note**: `ask` is no longer an MCP tool. It runs via CLI (`cli.ts`) invoked through Bash, supporting foreground and `--background` modes with optional `--context`.

### Removed Tools

| Tool | Reason |
|------|--------|
| `team_review` | Unused. Can be re-added later if needed. |
| `inject` | Merged into CLI `ask` as a `--context` parameter. |
| `ask` (MCP) | Moved to CLI for foreground/background execution flexibility. |

### CLI ask: Context Parameter

The CLI `ask` command accepts an optional `--context` flag:

```
node cli.js ask <sessionId> --context "extra context" <prompt>
node cli.js ask --background <sessionId> <prompt>
```

Background mode spawns a detached child process and saves results to `CLAUDE_PLUGIN_DATA/results/`.

## Retained Components

### From trib-agent (unchanged)

| Component | Path | Notes |
|-----------|------|-------|
| Worker agent | `agents/Worker.md` | Code modification specialist |
| Reviewer agent | `agents/Reviewer.md` | Read-only verification |
| Workflow skill | `skills/workflow/SKILL.md` | Enforces Lead's 5-step workflow |
| Hooks | `hooks/hooks.json` | Empty structure, reserved for future use |

### From trib-orchestrator (moved into trib-agent)

| Component | Source Path | Target Path |
|-----------|------------|-------------|
| Slash commands | `commands/ask.md`, `commands/models.md` | `commands/ask.md`, `commands/models.md` |
| CLI script | `scripts/cli.mjs` | `scripts/cli.mjs` |
| MCP server source | `src/` (entire directory) | `src/` |
| Run script | `scripts/run-mcp.mjs` | `scripts/run-mcp.mjs` (replaces agent's version) |

## Providers (Current State)

All five provider types are retained:

| Provider | Class | SDK | Covers |
|----------|-------|-----|--------|
| OpenAI-compatible | `OpenAICompatProvider` | `openai` | openai, groq, openrouter, xai, ollama, lmstudio, local |
| OpenAI OAuth | `OpenAIOAuthProvider` | native fetch + SSE | openai-oauth (ChatGPT subscription via Codex Responses API) |
| Anthropic | `AnthropicProvider` | `@anthropic-ai/sdk` | anthropic |
| Gemini | `GeminiProvider` | `@google/generative-ai` | gemini |
| Copilot | `CopilotProvider` (wraps OpenAI-compat) | `openai` + custom auth | copilot |

### Current Capabilities

| Feature | Status | Notes |
|---------|--------|-------|
| Tool use / function calling | Implemented | All providers support tool definitions and tool call loops |
| Streaming | Partial | OpenAI OAuth uses SSE streaming; others use non-streaming |
| Image/file input (multimodal) | Not implemented | `Message.content` is `string`-only |
| Dynamic model lists | Partial | OpenAI-compat and Copilot query API; others are hardcoded |
| MCP tool forwarding | Implemented | Sessions can use external MCP tools via `mcp-tools.json` |

## Merge Method

### Base

Use trib-orchestrator's MCP server (`src/index.ts`) as the base. It contains all tool definitions, provider initialization, session management, and channel notifications.

### Integration Steps

1. **Copy source**: Move `src/`, `scripts/cli.mjs`, and `commands/` from trib-orchestrator into trib-agent.
2. **Replace run-mcp.mjs**: Use orchestrator's version (more complete: cli bundling, config.json API key reading).
3. **Add MCP instructions**: Inject trib-agent's instructions string into the orchestrator server's `Server` constructor capabilities.
4. **Remove tools**: Delete `team_review` and `inject` tool definitions from `index.ts`.
5. **Modify ask tool**: Add optional `context` parameter to the `ask` tool schema and handler.
6. **Update plugin.json**: Unified metadata with name `trib-agent`.
7. **Update .mcp.json**: Single server entry named `trib-agent`.
8. **Update package.json**: Merge dependencies (orchestrator is superset).
9. **Delete trib-orchestrator**: Remove the entire `external_plugins/trib-orchestrator/` directory.
10. **Rebuild bundle**: Run esbuild to produce new `server.bundle.mjs`.

### Dependencies (merged)

```json
{
  "@anthropic-ai/sdk": "^0.52.0",
  "@google/generative-ai": "^0.24.0",
  "@modelcontextprotocol/sdk": "^1.12.1",
  "esbuild": "^0.25.0",
  "openai": "^5.8.0",
  "zod": "^3.23.0"
}
```

### plugin.json (merged)

```json
{
  "name": "trib-agent",
  "version": "0.1.0",
  "description": "Agent workflow orchestration with multi-model AI sessions — structured task flow, team management, and context-efficient delegation.",
  "author": {
    "name": "TRIBGAMES",
    "email": "dev@tribgames.com"
  },
  "license": "Apache-2.0",
  "mcpServers": "./.mcp.json"
}
```

## Final Directory Structure

```
trib-agent/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json
├── package.json
├── agents/
│   ├── Worker.md
│   └── Reviewer.md
├── commands/
│   ├── ask.md
│   └── models.md
├── hooks/
│   └── hooks.json
├── scripts/
│   ├── run-mcp.mjs
│   └── cli.mjs
├── skills/
│   └── workflow/
│       └── SKILL.md
└── src/
    ├── index.ts
    ├── cli.ts
    ├── config.ts
    ├── providers/
    │   ├── base.ts
    │   ├── registry.ts
    │   ├── openai-compat.ts
    │   ├── openai-oauth.ts
    │   ├── anthropic.ts
    │   ├── gemini.ts
    │   └── copilot-auth.ts
    ├── session/
    │   ├── manager.ts
    │   ├── store.ts
    │   └── trim.ts
    └── mcp/
        └── client.ts
```

## TODO Checklist

- [x] Copy `src/` directory from trib-orchestrator to trib-agent
- [x] Copy `scripts/cli.mjs` from trib-orchestrator to trib-agent
- [x] Copy `commands/` directory from trib-orchestrator to trib-agent
- [x] Replace `scripts/run-mcp.mjs` with orchestrator's version
- [x] Add MCP instructions to server constructor in `src/index.ts`
- [x] Remove `team_review` tool definition and handler from `src/index.ts`
- [x] Remove `inject` tool definition and handler from `src/index.ts`
- [x] Move `ask` from MCP tool to CLI (`cli.ts`) with `--context` and `--background` support
- [x] Add `resume_session` tool for session persistence across restarts
- [ ] Consider trim-protection for injected context messages
- [x] Update `.claude-plugin/plugin.json` with merged metadata
- [x] Update `.mcp.json` to single `trib-agent` server entry
- [x] Update `package.json` with merged dependencies
- [x] Delete `server.mjs` and `dist/server.bundle.mjs` (replaced by src/ build)
- [x] Build new `server.bundle.mjs` via esbuild
- [ ] Test: create_session, ask (with and without context), list_sessions, close_session, list_models
- [ ] Test: Worker and Reviewer agents still function
- [ ] Test: workflow skill still enforces Lead sequence
- [ ] Test: channel notifications deliver ask results
- [ ] Delete `external_plugins/trib-orchestrator/` directory
- [ ] Bump plugin version
