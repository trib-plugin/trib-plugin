/**
 * ai-wrapped-dispatch — dispatch hub for `recall` / `search` / `explore`.
 *
 * All three MCP tools flagged `aiWrapped: true` in tools.json route here
 * instead of the direct module handler. Each query spawns its own Pool C
 * agent session and runs concurrently via Promise.allSettled, so wall-clock
 * latency is bound by the slowest query rather than the sum. A single query
 * spawns a single agent, so the per-array cost scales linearly with query
 * count. Shared Pool B/C cache shards mean only the first concurrent agent
 * pays the cold-write; peers ride the warm prefix.
 *
 * Async completion pushes into the caller's session via the existing
 * `notifications/claude/channel` bridge. The notify meta carries
 * `type: 'async_result'` plus an `instruction` string so the Lead
 * integrates the answer on its next turn automatically.
 */

import { homedir } from 'os'
import { resolve as resolvePath, isAbsolute } from 'path'
import { loadConfig } from './config.mjs'
import { resolvePresetName } from './smart-bridge/bridge-llm.mjs'
import { smartReadTruncate } from './tools/builtin.mjs'

const ROLE_BY_TOOL = Object.freeze({
  recall:  { role: 'recall-agent',  build: buildRecallPrompt,   label: 'recall-agent' },
  search:  { role: 'search-agent',  build: buildSearchPrompt,   label: 'search-agent' },
  explore: { role: 'explorer',      build: buildExplorerPrompt, label: 'explorer agent' },
})

// Background dispatch registry. Entries live in-memory for the plugin server
// process lifetime — the merged answer is auto-pushed via the channel,
// and the registry is kept around for observability only. Pruned
// opportunistically to keep the map bounded.
const _asyncResults = new Map() // id → { status, role, tool, queries, createdAt, completedAt?, content?, error? }
const ASYNC_RESULT_MAX_ENTRIES = 200
const ASYNC_RESULT_TTL_MS = 30 * 60_000 // 30 minutes — enough for the Lead to loop back, short enough to not hoard memory

function _pruneAsyncResults() {
  if (_asyncResults.size < ASYNC_RESULT_MAX_ENTRIES) return
  const now = Date.now()
  for (const [id, entry] of _asyncResults) {
    const age = now - (entry.completedAt || entry.createdAt || now)
    if (entry.status !== 'running' && age > ASYNC_RESULT_TTL_MS) _asyncResults.delete(id)
  }
  if (_asyncResults.size >= ASYNC_RESULT_MAX_ENTRIES) {
    // Still full — evict the oldest regardless of status.
    const oldest = _asyncResults.keys().next().value
    if (oldest) _asyncResults.delete(oldest)
  }
}

export function getAsyncResult(id) {
  if (!id) return null
  return _asyncResults.get(String(id)) || null
}

export async function dispatchAiWrapped(name, args, ctx) {
  const rawQuery = args.query
  if (rawQuery == null) return fail('query is required')
  const queries = Array.isArray(rawQuery) ? rawQuery : [rawQuery]
  if (queries.length === 0) return fail('query cannot be empty')

  const spec = ROLE_BY_TOOL[name]
  if (!spec) throw new Error(`Unknown aiWrapped tool: ${name}`)

  // Recursion break — the tool schema stays full across every session so
  // that all roles share one cache shard. The counterweight lives here:
  // when a hidden-role session (recall-agent / search-agent / explorer /
  // cycle1 / cycle2) calls back into an aiWrapped dispatcher, we reject
  // the call at runtime. Without this, `recall` inside a recall-agent turn
  // would spawn another recall-agent session and fan out forever.
  if (ctx?.callerSessionId) {
    try {
      const { loadSession } = await import('./session/store.mjs')
      const { isHiddenRole } = await import('./internal-roles.mjs')
      const caller = loadSession(ctx.callerSessionId)
      if (caller && isHiddenRole(caller.role)) {
        return fail(
          `"${name}" is blocked inside the "${caller.role}" hidden role (recursion break). `
          + `Use the direct executor (memory_search / web_search / read / grep / glob / multi_read) for your query.`,
        )
      }
    } catch {
      // Fail-open on introspection errors — one stray call beats a broken session.
    }
  }

  const { makeBridgeLlm } = await import('./smart-bridge/bridge-llm.mjs')

  // `brief` (default true) applies a ~3000-token cap to each sub-agent
  // answer before it rides back into the Lead context. Pass `brief:false`
  // when the caller explicitly wants the uncapped synthesis. See
  // bridge-llm.mjs::applyBriefCap for the cap shape.
  const brief = args.brief !== false;

  // Always async + notification. There is no synchronous mode. Spawning
  // inline would block the MCP response for 14+ seconds while the
  // sub-agents stream, long enough for Claude Code's MCP client to drop
  // the connection. Dispatching in the background and returning a handle
  // immediately — with the merged answer delivered later via the channel
  // notification bridge — eliminates that failure mode entirely.
  _pruneAsyncResults()
  const id = `async_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  _asyncResults.set(id, {
    status: 'running',
    tool: name,
    role: spec.role,
    queries,
    createdAt: Date.now(),
  })
  // Emit a channel notification mirroring the bridge worker UX — the
  // Discord user sees "<tool> started" the instant dispatch begins. The
  // `silent_to_agent` flag keeps this status ping out of Lead's context
  // window; Lead still receives the async_result push later (pushAsyncResult)
  // which carries the merged answer it needs to integrate.
  if (typeof ctx?.notifyFn === 'function') {
    try { ctx.notifyFn(`${name} started`, { silent_to_agent: true }) } catch { /* best-effort */ }
  }
  const resolvedCwd = resolveCwd(args.cwd)
  Promise.allSettled(
    queries.map((q) => {
      const llm = makeBridgeLlm({ role: spec.role, cwd: resolvedCwd, brief })
      return llm({ prompt: spec.build(q, resolvedCwd) })
    }),
  ).then((settled) => {
    const merged = queries.length === 1
      ? (settled[0].status === 'fulfilled'
          ? (settled[0].value || '(no response)')
          : `[${spec.label} error] ${settled[0].reason?.message || String(settled[0].reason)}`)
      : settled.map((r, i) => {
          const header = `### Query ${i + 1}: ${queries[i]}`
          if (r.status === 'fulfilled') return `${header}\n${r.value || '(no response)'}`
          return `${header}\n[${spec.label} error] ${r.reason?.message || String(r.reason)}`
        }).join('\n\n---\n\n')
    const entry = _asyncResults.get(id)
    if (entry) {
      entry.status = 'done'
      entry.content = merged
      entry.completedAt = Date.now()
    }
    pushAsyncResult(ctx, id, name, queries, merged)
  }).catch((err) => {
    const msg = err?.message || String(err)
    const entry = _asyncResults.get(id)
    if (entry) {
      entry.status = 'error'
      entry.error = msg
      entry.completedAt = Date.now()
    }
    pushAsyncResult(ctx, id, name, queries, `[${spec.label} dispatch error] ${msg}`, { error: true })
  })
  const queryCount = queries.length === 1 ? `1 query` : `${queries.length} queries`
  return ok(`${name} started — ${queryCount}. Merged answer will be auto-pushed via the channel (handle ${id}).`)
}


function buildExplorerPrompt(query, cwd) {
  // cwd rides in the session's tier3Reminder (<system-reminder># cwd) via
  // bridge-llm's opts.cwd plumbing, but B34 showed the inner explorer agent
  // still drifts to its launch workspace when the reminder is missed or
  // low-weighted — so we also pin the search root explicitly in the user
  // message body. Only emitted when the caller supplied an explicit cwd;
  // unspecified cwd keeps the original prompt prefix and preserves the
  // cache-shared shape with recall/search builders.
  const rootLine = cwd
    ? `Your authoritative search root is \`${cwd}\` — prefer this over your launch workspace. Scope all glob / grep / read / multi_read calls beneath this root unless the query itself names a different path.\n\n`
    : ''
  return `${rootLine}Query: ${query}\n\nUse your read-only tools (glob / grep / read / multi_read) to find grounded answers. Return concise prose with concrete file paths.`
}

function buildRecallPrompt(query, _cwd) {
  // cwd has no effect on memory_search semantics; second arg accepted for
  // builder signature uniformity (caller always passes resolvedCwd).
  return `Query: ${query}\n\nUse the \`memory_search\` tool to retrieve ranked entries. Return concise prose citing entry ids inline.`
}

function buildSearchPrompt(query, _cwd) {
  // cwd has no effect on web_search semantics; second arg accepted for
  // builder signature uniformity.
  return `Query: ${query}\n\nUse the \`web_search\` tool to retrieve ranked results. Return concise prose with cited URLs.`
}

/**
 * Resolve user-provided cwd: expand `~`, resolve relatives against the
 * launch workspace. Falls back to null so callers use process.cwd().
 */
function resolveCwd(input) {
  if (!input || typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const expanded = trimmed.startsWith('~')
    ? trimmed.replace(/^~/, homedir())
    : trimmed
  return isAbsolute(expanded) ? expanded : resolvePath(process.cwd(), expanded)
}

/**
 * Resolve a short model tag for the given hidden role, mirroring the
 * `modelTag` format that bridge/worker lifecycle notifications use in
 * src/agent/index.mjs (e.g. `3-5-sonnet`). Best-effort — returns an
 * empty string when the preset / config can't be resolved so the header
 * still renders (falls back to `[{tool}] Done.`).
 */
export function resolveAgentModelTag(role) {
  try {
    const presetName = resolvePresetName({ role })
    if (!presetName) return ''
    const config = loadConfig()
    const preset = config?.presets?.find((p) => p.id === presetName || p.name === presetName)
    const raw = preset?.model
    if (!raw || typeof raw !== 'string') return ''
    const stripped = raw.startsWith('claude-') ? raw.slice('claude-'.length) : raw
    return stripped || ''
  } catch {
    return ''
  }
}

/**
 * Build the `Done.` header that wraps async-result notifications, mirroring
 * the Pool B worker completion shape emitted in src/agent/index.mjs:
 *     [{model-tag}] [{role}] <content>
 * Async dispatch re-uses the same pattern so the user sees a consistent
 * `Done.` header across bridge worker output and async recall/search/explore
 * result delivery.
 *
 * When the model tag can't be resolved, falls back to `[{tool}] Done.`.
 * When the tool is empty (shouldn't happen), falls back to `Done.`.
 */
export function buildAsyncResultHeader(tool, modelTag) {
  const toolPart = tool ? `[${tool}] ` : ''
  const tagPart = modelTag ? `[${modelTag}] ` : ''
  return `${tagPart}${toolPart}Done.`
}

export function pushAsyncResult(ctx, id, tool, queries, body, flags = {}) {
  const notify = ctx?.notifyFn
  if (typeof notify !== 'function') return
  const queryCount = queries.length === 1
    ? `1 query`
    : `${queries.length} queries`
  const bodyHeader = flags.error
    ? `${tool} failed`
    : `${tool} — ${queryCount}`
  // v0.6.249 smart truncation — large recall/search/explore merged bodies
  // (multi-query fan-out) can blow past the 30 KB smart-read cap and waste
  // Lead context. Apply the same head/tail summariser used by `read` /
  // `multi_read` so Lead still sees the interesting frames (first queries
  // and final queries) without paying for the middle mass. Truncation acts
  // on the body only — the `Done.` header is prepended AFTER, so it never
  // gets cut.
  const bodyStr = typeof body === 'string' ? body : String(body ?? '')
  const bodyBytes = Buffer.byteLength(bodyStr, 'utf8')
  const bodyLines = bodyStr.length === 0 ? 0 : bodyStr.split('\n').length
  const { text: cappedBody } = smartReadTruncate(bodyStr, bodyLines, bodyBytes)
  const originalBody = `${bodyHeader}\n\n${cappedBody}`
  // v0.6.241: prepend a `Done.` wrapper that mirrors the Pool B worker
  // completion header in src/agent/index.mjs (`${modelTag}[${role}] ...`).
  // When the model tag can't be resolved, the helper falls back to
  // `[{tool}] Done.` — still better than no header.
  const spec = ROLE_BY_TOOL[tool]
  const modelTag = spec ? resolveAgentModelTag(spec.role) : ''
  const doneHeader = flags.error
    ? buildAsyncResultHeader(tool, modelTag).replace(/Done\.$/, 'Failed.')
    : buildAsyncResultHeader(tool, modelTag)
  const content = `${doneHeader}\n\n${originalBody}`
  try {
    notify(content, { type: 'async_result', async_id: id, tool, instruction: `The async ${tool} dispatch you started earlier (${id}) has returned — use this answer in your next step.` })
  } catch {
    // Telemetry-style best-effort — never let the push crash the dispatch.
  }
}

function ok(text) {
  return { content: [{ type: 'text', text }] }
}

function fail(msg) {
  return { content: [{ type: 'text', text: `[aiWrapped error] ${msg}` }], isError: true }
}
