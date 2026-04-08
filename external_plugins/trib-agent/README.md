# trib-agent

Agent workflow orchestration and multi-AI delegation plugin for Claude Code. Manages sessions with external AI providers, executes workflow plans, and defines agent roles.

## Architecture

```text
Lead (Claude Code)
  -> trib-agent MCP server
    -> Orchestrator (session manager + agent loop)
      -> Providers (Anthropic, OpenAI, Gemini, Groq, xAI, Copilot, Ollama, ...)
```

The Lead delegates tasks to external models via sessions. Each session maintains conversation history, injected context (CLAUDE.md, agent rules, skills), and registered tools.

## MCP Tools

| Tool | Description |
|------|-------------|
| `create_session` | Create external AI session with preset (full/readonly/mcp) |
| `delegate` | Send task to session. Sync by default, `background=true` for async |
| `list_sessions` | View all active sessions with token/usage info |
| `close_session` | Terminate session and cleanup |
| `list_models` | Enumerate available models from all configured providers |
| `get_workflows` | List available workflow plans |
| `get_workflow` | Load specific workflow by name |

## Workflow Plans

JSON-based execution plans with step routing:

```json
{
  "name": "code-review",
  "steps": [
    { "model": "native/opus", "action": "Review code for logic errors..." },
    { "model": "native/sonnet", "action": "Synthesize final report..." }
  ]
}
```

### Default Workflows

| Name | Steps | Purpose |
|------|-------|---------|
| `code-review` | opus → sonnet | Two-pass code review |
| `bug-investigation` | opus → sonnet | Root cause analysis |
| `quick-research` | sonnet → haiku | Web research + summary |

## Agent Definitions

| Agent | Mode | Tools | Role |
|-------|------|-------|------|
| **Worker** | bypassPermissions | Read, Write, Edit, Bash, Grep, Glob, SendMessage, TaskUpdate | Code modification, never commits |
| **Reviewer** | bypassPermissions (read-only) | Read, Grep, Glob, SendMessage, TaskUpdate | Verification, bug detection, independent review |

These are constraint definitions (data files), not executable code. They define rules for agents spawned via Claude Code's native `Agent()` tool.

## Commands

| Command | Description |
|---------|-------------|
| `/ask` | Query active session (auto-creates if none) |
| `/new` | Create new session from default preset |
| `/resume` | List or activate a previous session |
| `/clear` | Clear active session messages |
| `/model` | Switch default model |
| `/config` | Open provider/preset settings UI |

## Skills

| Skill | Trigger | Purpose |
|-------|---------|---------|
| `workflow` | Any actionable task (auto) | Lead state cycle: idle → discuss → approve → execute → verify |

## Providers

Anthropic, OpenAI, Gemini, OpenAI-OAuth (ChatGPT), Copilot, Groq, OpenRouter, xAI, Ollama, LM-Studio.

All providers support `send()` and `listModels()` with tool calling.

## Cross-Plugin Integration

- **trib-channels**: Async delegate results delivered via `inject` tool
- **trib-memory**: Context injection via MCP client auto-detect

## Hooks

| Event | Action |
|-------|--------|
| SessionStart | Clear active session pointer (fresh opt-in each session) |

## Key Files

| File | Purpose |
|------|---------|
| `server.mjs` | MCP server, tool handlers, instructions |
| `orchestrator/session/manager.js` | Session lifecycle (create, ask, resume, close) |
| `orchestrator/session/loop.js` | Agent tool-calling loop (max 10 iterations) |
| `orchestrator/workflow-store.js` | Workflow load/save/seed |
| `orchestrator/providers/` | Provider implementations |
| `orchestrator/mcp/client.js` | Cross-plugin MCP client |

## What Is NOT Implemented

- **Team management**: Instructions reference `TeamCreate` but this is a Claude Code native tool, not implemented in trib-agent
- **recall / verify skills**: Not built
