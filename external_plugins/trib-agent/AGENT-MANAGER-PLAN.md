# Unified Agent Manager — Design Plan

## Vision

trib-agent evolves from "external model session manager" to a **unified agent management framework**. Users install it and configure their own models, workflows, and routing — customized to their work style.

## Architecture Overview

```
┌─────────────────────────────────────────┐
│              workflow skill              │
│         (process owner, always first)   │
│                                         │
│  1. Check MCP instructions for plans    │
│  2. Match → get_workflow(name)          │
│  3. Execute steps in order              │
│  4. No match → Lead freestyle           │
└──────────┬──────────────────────────────┘
           │
┌──────────▼──────────────────────────────┐
│            Unified Dispatch              │
│     step.model → native or external     │
├──────────────────┬──────────────────────┤
│   Native Pool    │   External Pool      │
│   Agent(Worker)  │   delegate(provider) │
│   Agent(Reviewer)│   session(multi-turn)│
│   Claude models  │   GPT/Gemini/Local   │
└──────────────────┴──────────────────────┘
```

## Layer Separation

| Layer | Role | Location |
|-------|------|----------|
| **Skills** (auto-trigger) | Lead's decision-making (when/why) | skills/*.md |
| **MCP instructions** | Tool syntax + workflow list (what/how) | server.mjs |
| **MCP tools** | Data access (get_workflow, delegate, etc.) | server.mjs |
| **Agent definitions** | Agent's own constraints | agents/*.md |
| **Workflow plans** | Step-by-step execution plans (data, not triggers) | workflows/*.json |
| **Config** | Models, providers, connections | config.json |

## Skills Architecture

Three auto-trigger skills, each with one clear purpose:

| Skill | Trigger | Question it answers |
|-------|---------|-------------------|
| **workflow** | Any work request | "How should Lead operate?" |
| **recall** | Any context gap | "Is current context sufficient?" |
| **verify** | Any factual claim | "Is my training data still accurate?" |

workflow = operational framework (loads once at work start)
recall/verify = judgment triggers (fire throughout conversation)

## Workflow Skill — State Cycle

```
idle → discuss → approve → execute → verify → idle
```

During **execute** phase, Lead checks for matching workflow plans and follows steps if found. Otherwise proceeds with own judgment.

## Delegation Rules

Choose by follow-up likelihood:

| Will this agent get follow-up tasks? | Method |
|--------------------------------------|--------|
| No — result-only (research, audit) | Background agent |
| Likely — sequential work in same sector | Team agent (reuse via SendMessage) |
| Uncertain | Background first, create team on 2nd task |

Context hygiene:
- If a team agent's accumulated context exceeds useful scope, start a new one.
- Never force-fit unrelated tasks into an existing team to "save tokens."

## Unified Model Registry

All models in one registry — native + external + local:

```
providers:
  native:
    - claude-opus-4-6 (integrated tools, default)
    - claude-sonnet-4-6 (fast)
    - claude-haiku-4-5 (cheap)
  external:
    - openai / gpt-5.4 (API key or OAuth)
    - anthropic / claude (API key)
    - gemini (API key)
    - groq (API key)
    - openrouter (API key)
    - xai (API key)
  local:
    - ollama (auto-detect)
    - lm-studio (auto-detect)
  oauth:
    - openai-codex (browser auth)
    - github-copilot (token)
```

Native models shown as read-only — they route to Claude Code's built-in Agent tool, not through API.

## Workflow Plans

### Storage

```
~/.claude/plugins/data/trib-agent/
  workflows/
    code-review.json
    bug-fix.json
    feature-impl.json
    ... (user creates 20-30)
```

User data directory, not plugin source. Each user manages their own.

### Schema

```json
{
  "name": "code-review",
  "description": "Code review with second opinion",
  "steps": [
    {
      "model": "native/opus",
      "action": "Scan code for issues",
      "notes": "Focus on logic errors, not style. Check test coverage."
    },
    {
      "model": "external/gpt-5.4",
      "action": "Second opinion review",
      "notes": "Review independently from Step 1. Focus on security."
    },
    {
      "model": "native/haiku",
      "action": "Combine results and report",
      "notes": "Compare both reviews. Highlight conflicting opinions."
    }
  ]
}
```

### Step Fields

| Field | Purpose |
|-------|---------|
| **model** | Which model (dropdown from Models config) |
| **action** | What to do (one line) |
| **notes** | How to do it, what to watch for (detailed instructions) |

No condition field — Lead judges naturally whether to skip/adjust based on previous step results.

### Discovery

- **List** (name + description): injected into MCP instructions at server start. Always visible to Lead.
- **Full plan** (steps): loaded on demand via `get_workflow(name)` MCP tool.

### Execution

Once workflow skill fires and Lead matches a plan:

```
1. get_workflow("code-review") → full steps loaded
2. Step 1: route to native/opus → Agent or direct
3. Step 1 result → passed as context to Step 2
4. Step 2: route to external/gpt → delegate()
5. Step 2 result → passed as context to Step 3
6. Step 3: route to native/haiku → summarize
7. Final result → report to user
```

Lead IS the execution engine. No separate orchestrator needed. Workflow JSON is just a plan Lead follows.

## MCP Changes

### Tools

| Tool | Status | Purpose |
|------|--------|---------|
| `create_session` | Keep | Multi-turn external session |
| `list_sessions` | Keep | Session management |
| `close_session` | Keep | Session cleanup |
| `list_models` | Keep | Model discovery |
| `delegate` | Keep | One-shot external (sync/async) |
| ~~`ask`~~ | Removed | Replaced by delegate |
| `get_workflows` | **New** | List available workflow plans |
| `get_workflow(name)` | **New** | Load full workflow plan |

### Instructions

```
Tools: `delegate`, `create_session`, `list_sessions`, `close_session`, 
       `list_models`, `get_workflows`, `get_workflow`.

Available workflows:
- code-review: Code review with second opinion
- bug-fix: Bug investigation and fix
- feature-impl: Feature implementation
[dynamically generated from workflows/ directory]
```

## Config UI Redesign

### Tab Structure

```
Providers  → Connection management (API keys, OAuth, local detection)
Models     → Model presets (renamed from "Presets")
Workflows  → Step-by-step plan editor (NEW)
Status     → Unified status for all models
```

### Providers Tab — Improvements

- Status badges unified: `Active` (green) for any working connection (API key, OAuth, Running)
- `Off` (gray) for unconfigured
- `Error` (red) for configured but failing
- "Get Key" as primary action for unconfigured providers (links to provider's API page)

### Models Tab (renamed from Presets)

Model configurations with provider + model + settings. Used as dropdown options in Workflow editor.

### Workflows Tab — Editor

```
┌─ code-review ────────────────────────┐
│                                      │
│  Description: [Code review + verify] │
│                                      │
│  ┌─ Step 1 ───────────────────────┐  │
│  │ Model:  [Native Opus     ▼]    │  │
│  │ Action: [Scan for issues     ] │  │
│  │ Notes:  [Logic errors, not   ] │  │
│  │         [style. Check tests. ] │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌─ Step 2 ───────────────────────┐  │
│  │ Model:  [GPT 5.4         ▼]    │  │
│  │ Action: [Second opinion      ] │  │
│  │ Notes:  [Independent view.   ] │  │
│  │         [Security focus.     ] │  │
│  └────────────────────────────────┘  │
│                                      │
│  [+ Add Step]                        │
│                                      │
│  [Save]  [Duplicate]  [Delete]       │
└──────────────────────────────────────┘
```

- Model dropdown pulls from Models tab
- Steps can be reordered (drag)
- Duplicate to create variations of existing workflows

### Status Tab — Unified

```
Provider Status:
  OpenAI        Active (API Key)
  OpenAI Codex  Active (OAuth)
  Gemini        Off
  Ollama        Active (Local)

Active Agents:
  [native]   Worker-main    | opus  | running
  [external] GPT-review     | gpt-5.4 | idle
```

## Implementation Order

| Phase | Work | Files |
|-------|------|-------|
| **1. Workflow data layer** | JSON schema, read/write, directory scanning | server.mjs, new: workflow-store.js |
| **2. MCP tools** | get_workflows, get_workflow(name) | server.mjs |
| **3. MCP instructions** | Dynamic workflow list injection | server.mjs |
| **4. Workflow skill update** | Add execution flow referencing workflow plans | skills/workflow/SKILL.md |
| **5. Config UI: Models rename** | Presets → Models | setup/ |
| **6. Config UI: Workflows tab** | Step editor, model dropdown, CRUD | setup/ |
| **7. Config UI: Providers polish** | Status unification, Get Key flow | setup/ |
| **8. Config UI: Status unification** | Combined native + external status | setup/ |
| **9. Default workflows** | Ship 3-5 example workflows | workflows/examples/ |
| **10. Testing** | End-to-end: trigger → match → load → execute | manual |

## Design Decisions Log

| Decision | Rationale |
|----------|-----------|
| Workflow plans are data, not skills | Avoids double-trigger with workflow skill |
| No condition field in steps | Lead judges naturally based on previous results |
| No trigger keywords in plans | Lead matches by name + description, more flexible |
| List in instructions, full plan via tool | Lightweight discovery, on-demand loading |
| Native models read-only in registry | Route to built-in Agent tool, not API (no double cost) |
| JSON not .md for plans | UI editor needs structured parsing |
| User data dir for workflows | Each user customizes their own |
| workflow skill stays monolithic | State cycle + delegation + execution are one coherent flow |
| MCP ask tool removed | delegate covers sync/async, single entry point |
| Version auto-sync from plugin.json | Runtime read, no hardcoded versions |
