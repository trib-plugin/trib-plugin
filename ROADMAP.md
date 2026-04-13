# trib-plugin Roadmap

## Next Cycle: LLM Call Architecture Refactoring

### Goal
Separate maintenance/analysis LLM calls from active work calls at the code level. Maintenance calls must be bare, stateless, HTTP-only. Active calls retain full context.

### Category A — Maintenance (bare, HTTP-only, no CLI spawn)

**Targets:**
- cycle1 (episode classification, every 10min)
- cycle2 (memory consolidation, daily)
- cycle3 (trajectory analysis + skill pattern detection, periodic)
- session recap (previous session summary at boot)
- state-packet (structured state extraction from bridge sessions)
- dialectic / mode=reason (memory-based reasoning synthesis)

**Requirements:**
- No CLI spawning (no `claude -p`, no `codex exec`, no `gemini -p`)
- No delegate-cli
- No bridge session creation
- No CLAUDE.md / skills / MCP / plugins loading
- No project cwd — use temp dir or none
- Prompt-only: self-contained prompt in, answer out
- HTTP direct calls only (OAuth token or API key)
- Auth fallback: local OAuth file → environment variable (for web VM support)

### Category B — Active Work (full context, existing paths)

**Targets:**
- Bridge sessions (external model orchestrator)
- Native sub-agents (Claude Code Agent tool)
- Proactive (scheduled conversation topics)
- Schedules (non-interactive tasks)

**Requirements:**
- Full context injection (CLAUDE.md, skills, MCP, tools)
- Project-aware, tool-capable
- Existing paths unchanged

---

### Implementation Plan

#### Phase 1: Shared Maintenance Caller

**New files:**
- `src/shared/llm/direct-runner.mjs` — Low-level HTTP execution
  - `runApiDirect(prompt, provider, opts)` — OpenAI/Anthropic/compatible HTTP
  - `runOllamaDirect(prompt, provider, opts)` — Ollama HTTP
  - No CLI spawn, no session creation, no context injection
  - Retry/timeout handling
  - Auth resolution: file-based OAuth → env var fallback

- `src/shared/llm/maintenance.mjs` — Maintenance wrapper
  - `callMaintenanceLLM(prompt, { task, timeout, retries })`
  - `resolveMaintenancePreset(task, agentConfig)`
  - `presetToMaintenanceProvider(preset)`
  - Task → preset resolution from agent-config.json
  - Default fallback: sonnet-mid

**Constraints:**
- These files must NEVER import delegate-cli, bridge session, MCP, or CLAUDE.md collection
- Structural separation, not flag-based

#### Phase 2: Caller Migration

**Files to modify:**

| File | Current | Target |
|------|---------|--------|
| `src/memory/lib/memory-cycle.mjs` | `callLLM` via `llm-provider.mjs` → delegateCli first | `callMaintenanceLLM` |
| `src/memory/index.mjs` (dialectic) | `callLLM` → delegateCli first | `callMaintenanceLLM` |
| `src/agent/orchestrator/session/state-packet.mjs` | `callLLM` + own PROVIDER_MAP | `callMaintenanceLLM` |
| `server.mjs` (session recap) | `handleToolCall('search_memories')` → internal | `callMaintenanceLLM` or keep current |

**Each caller change:**
1. Replace `callLLM(prompt, provider)` with `callMaintenanceLLM(prompt, { task: 'cycle1' })`
2. Remove manual provider resolution logic
3. Remove PROVIDER_MAP from state-packet.mjs
4. Verify prompt is self-contained (no implicit context dependency)

#### Phase 3: Preset Unification

**agent-config.json changes:**
```json
{
  "presets": [...],
  "default": "GPT5.4",
  "maintenance": {
    "defaultPreset": "sonnet-mid",
    "cycle1": "gpt5.4-mini",
    "cycle2": "gpt5.4-mini",
    "cycle3": "sonnet-mid",
    "sessionRecap": "gpt5.4-mini",
    "statePacket": "sonnet-mid",
    "reason": "sonnet-mid"
  }
}
```

**Preset resolution order:**
1. `agentConfig.maintenance[taskName]`
2. `agentConfig.maintenance.defaultPreset`
3. Preset with id "sonnet-mid"
4. First native sonnet preset with medium effort
5. Ephemeral fallback: `{ type: 'native', model: 'sonnet', effort: 'medium' }`

**Setup UI:**
- Add maintenance preset config to AGENT > Learning panel or separate section
- Dropdowns for each task, populated from agent presets
- Default shows "sonnet-mid"

#### Phase 4: Legacy Cleanup

**Remove:**
- `callDelegateCli()` from `llm-provider.mjs`
- `callClaude()` from `llm-provider.mjs` (CLI spawn)
- `callCodex()` from `llm-provider.mjs` (CLI spawn)
- `DELEGATE_CLI` constant
- `CONNECTION_TO_PROVIDER` mapping
- `presetToProvider()` in `memory-cycle.mjs` (replaced by shared resolver)
- `PROVIDER_MAP` in `state-packet.mjs`
- memory-config.json `presets[]` array (already removed from UI, clean up any remaining references)
- `src/search/lib/ai-providers.mjs` — search AI legacy (entire file)
- All `runAiSearch` callers in `src/search/index.mjs`

**Keep:**
- `callAPI()` logic → moved into `direct-runner.mjs`
- `callOllama()` logic → moved into `direct-runner.mjs`
- `llm-provider.mjs` → deprecated shim or delete entirely

#### Phase 5: Auth Path

**OAuth token resolution:**
```
1. Plugin data dir: ~/.claude/plugins/data/trib-plugin-trib-plugin/openai-oauth.json
2. Environment variable: OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.
3. agent-config.json provider credentials
```

**Per-provider auth:**
| Provider | Local | Web (cloud VM) |
|----------|-------|-----------------|
| OpenAI OAuth | oauth.json token file | env var OPENAI_API_KEY |
| Anthropic | agent-config apiKey | env var ANTHROPIC_API_KEY |
| Ollama | localhost (no auth) | N/A (no local ollama in cloud) |
| OpenAI-compat | agent-config apiKey + baseURL | env var |

---

## Next Cycle: Session Auto-Maintenance

### Goal
Automatic session lifecycle management for bridge sessions, inspired by Hermes agent.

### Features

#### Session Reset Policy
- `idle` — auto-close after N hours of inactivity
- `messageLimit` — state-packet extract + close after N messages
- `daily` — reset at specific time
- Configurable per-scope or global

#### Pre-Close Actions
- Extract state-packet before closing
- Save to disk for future session restore
- Active sessions (with running background processes) are never auto-closed

#### Session Pruning
- Delete ended sessions older than N days
- State-packets are preserved separately
- Configurable retention period

#### Implementation Location
- cycle3 or dedicated session-maintenance cycle
- Runs periodically (e.g. every 30 min)
- Checks all active bridge sessions against policy

#### Config
```json
{
  "sessionMaintenance": {
    "enabled": true,
    "idleTimeoutHours": 24,
    "messageLimit": 100,
    "pruneAfterDays": 7
  }
}
```

---

## Next Cycle: Main Session Context Continuity

### Goal
New Claude Code sessions automatically know what happened in the previous session.

### Current State (v0.2.3)
- session recap feature implemented (server.mjs boot-time generation)
- session_id tracking added (memory.mjs basename injection)
- dialectic mode=reason works
- rules-builder injects session-recap.md

### Remaining Work
- Verify session recap actually generates on real session restart
- Tune recap query for better accuracy
- Test with multiple sessions to verify session boundary detection
- Consider SessionEnd hook for pre-close summary (nohup pattern)

---

## Future: Hermes-Inspired Features (Planning Required)

### Skill Auto-Improvement
- Reference: Hermes agent learning loop
- Detect skill usage patterns from trajectory data
- Auto-refine skill prompts based on success/failure rates
- Eval pipeline for measuring skill quality
- Status: needs dedicated planning session

### Eval Pipeline
- Automated testing of memory retrieval quality
- Skill suggestion accuracy measurement
- Session recap quality assessment
- Regression detection across versions

### Per-Agent Effort Control
- Blocked by Claude Code limitation (anthropics/claude-code#25591)
- Agent tool doesn't support effort parameter
- Monitor for upstream support
- Workaround: different models as rough effort proxy

---

## Research Items

### Gemini CLI Bare Mode
- Does Gemini CLI have context isolation?
- Does it load `.gemini/` configs or project files?
- If no bare mode, maintenance calls to Gemini must use direct API only
- Status: Gemini not installed locally, needs web research + testing

### Provider Isolation Verification
- Test each provider's actual context injection behavior
- Verify `--bare` mode for Claude Code skips all expected items
- Check if codex exec loads project context in temp cwd
- Document exact isolation guarantees per provider

### Web Environment (claude.ai/code) Plugin Support
- Each session runs in fresh Anthropic-managed VM
- Plugin data dir is empty each session
- OAuth tokens not available
- API keys must come from environment variables
- Need to verify plugin marketplace installation works
- Need auth fallback path: local file → env var

---

## Technical Debt

### memory-config.json Cleanup
- `presets[]` array removed from UI but may have stale references in code
- cycle1/cycle2 `preset` field still references old preset IDs (e.g. "gpt5.4")
- Need migration: old preset IDs → agent-config preset IDs

### state-packet.mjs Coupling
- Currently imports from `memory/lib/llm-provider.mjs` (cross-module dependency)
- Should import from `shared/llm/maintenance.mjs` instead
- Dependency direction: `agent → memory internals` should become `agent → shared`

### Prompt Self-Containment
- After switching to bare/HTTP-only maintenance calls, some prompts may lose implicit context
- Review and strengthen all maintenance prompts:
  - Explicit role description
  - Output schema
  - Constraints and format requirements
  - Fallback instructions

### Old Cache Cleanup
- Multiple old cache versions accumulate (0.0.53, 0.1.x, etc.)
- Old setup servers can linger as zombie processes (found 0.0.53 + marketplace duplicate = 1.5GB RAM)
- Need periodic cache pruning or version-aware process cleanup

---

## Session Notes (2026-04-13)

### Discovered Issues
1. user-workflow.json never created → roles not injected into CLAUDE.md
2. tools.json missing mode=reason parameter → dialectic broken
3. normalizePreset stripping type field → native presets saved as bridge
4. Setup server running from old cache (v0.0.53) → Learning panel missing
5. Duplicate MCP servers consuming 1.5GB RAM
6. callDelegateCli using non-existent `cli.js ask` → always failing silently
7. session_id hardcoded to null → no session boundary tracking
8. memory-config presets separate from agent presets → duplicate management

### Key Decisions
- Native agent per-agent effort: not possible (Claude Code limitation), use model as proxy
- Session recap via dialectic at session-start, not state-packet at session-end
- CLI spawning is legacy for maintenance tasks → HTTP-only direction
- Web environment needs env var auth fallback
- Search AI is legacy → remove entirely
- Maintenance vs active distinction must be structural (separate functions), not flag-based
