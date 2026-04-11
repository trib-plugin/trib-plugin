# TODO / Known Issues

## Outstanding

### openai-compat provider: migrate to `/v1/responses` endpoint

**Symptom**: `gpt-5.4-mini` calls via `openai-compat.mjs` fail with:

```
400 Function tools with reasoning_effort are not supported for gpt-5.4-mini in /v1/chat/completions. Please use /v1/responses instead.
```

**Root cause**: OpenAI rejects the `reasoning_effort + function tools` combination on `/v1/chat/completions` for mini-class models. `openai-compat.mjs` uses `client.chat.completions.create(...)` and passes both fields together when the preset has `effort` set (e.g. `gpt5.4-mini` with `effort: medium`).

**What still works**:
- `GPT5.4` preset (routes through `openai-oauth.mjs` / Codex backend — already on Responses API)
- `gemma` preset (Ollama ignores the effort field)
- Any `openai-compat` preset without `effort`
- All Anthropic presets (separate provider)

**Rejected workarounds**:
- Model-name hardcoding (e.g. `model.includes('mini')`) — fragile, pattern-matching
- Error-based retry after 400 — doubles latency/cost/log noise on every normal call
- Removing `effort: medium` from `agent-config.json` mini preset — user config, should not be mutated by code

**Fix direction**:

Port the Responses API request/response pattern from `openai-oauth.mjs` into `openai-compat.mjs`. Concretely:

1. Request body shape:
   ```
   { model, instructions, input, reasoning: { effort }, tools: [{ type, name, description, parameters }], store: false, stream: true }
   ```
   instead of:
   ```
   { model, messages, reasoning_effort, tools: [{ type: 'function', function: {...} }] }
   ```
2. Message conversion: system → `instructions`, everything else → `input` array (with `function_call` / `function_call_output` items for tool flow).
3. Response parsing: SSE events with `response.output_text.delta`, `response.function_call.arguments.delta`, etc.
4. Add a provider-level flag `useResponsesApi: true` for `openai` only. Leave `groq`, `ollama`, `lmstudio`, `openrouter`, `xai` on the existing `chat/completions` path — those endpoints may not support `/v1/responses`.

**Scope**: `src/agent/orchestrator/providers/openai-compat.mjs` only. Non-breaking for other compat providers since the flag gates the new path.

**Related work (already shipped in this cycle, not affected)**:
- Session isolation / owner-based lookup (`session/manager.mjs`, `cli.mjs`)
- Bridge agent spawn pattern (`agents/Bridge.md`, `rules/team.md`)

**Deferred from cycle 0.0.51 → 0.0.59.** Tracked for the next cycle.

---

### Secondary: explicit session id not preserved in `createSession`

**Symptom**: When `ask.mjs :bridge_Agent-c_abc --preset X ...` is invoked and no session with that id exists yet, `createSession` generates a fresh `sess_<n>_<ts>` id and the explicit `bridge_Agent-c_abc` id is lost. The next call with the same explicit id can never resume the previous session.

**Impact**: Bridge agent multi-turn (same bridge id across calls for cache-hit continuity) doesn't work. Single-shot bridge calls are fine — owner is still marked `'bridge'` via `cli.mjs` sessionOwner derivation, so isolation from user pool holds.

**Fix direction**: `createSession` should accept an optional `opts.id` parameter. If provided, use it instead of generating a new one (still check for collision). Wire `cli.mjs` to pass `explicitSession` as `opts.id` when creating a fresh session for an explicit id.

**Scope**: `src/agent/orchestrator/session/manager.mjs` + `src/agent/orchestrator/cli.mjs`. ~10 lines.

**Deferred from cycle 0.0.51 → 0.0.59.**
