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
 * integrates the answer on its next turn instead of burning LLM
 * round-trips polling session_result.
 */

import { homedir } from 'os'
import { resolve as resolvePath, isAbsolute } from 'path'

const ROLE_BY_TOOL = Object.freeze({
  recall:  { role: 'recall-agent',  build: buildRecallPrompt,   label: 'recall-agent' },
  search:  { role: 'search-agent',  build: buildSearchPrompt,   label: 'search-agent' },
  explore: { role: 'explorer',      build: buildExplorerPrompt, label: 'explorer agent' },
})

// Background dispatch registry. Entries live in-memory for the plugin server
// process lifetime; poll via `session_result(id)`. Pruned opportunistically
// to keep the map bounded even if callers forget to drain.
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

  // Default mode is ASYNC (bridge-style): spawn the dispatch in the
  // background and return a polling handle so the caller (typically Lead)
  // continues its turn without blocking. To wait inline for the merged
  // answer, pass `wait: true` explicitly.
  if (args.wait !== true) {
    _pruneAsyncResults()
    const id = `async_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    _asyncResults.set(id, {
      status: 'running',
      tool: name,
      role: spec.role,
      queries,
      createdAt: Date.now(),
    })
    const resolvedCwd = resolveCwd(args.cwd)
    Promise.allSettled(
      queries.map((q) => {
        const llm = makeBridgeLlm({ role: spec.role, cwd: resolvedCwd })
        return llm({ prompt: spec.build(q) })
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
    return ok(`Async dispatch started (${name}, ${queries.length} ${queries.length === 1 ? 'query' : 'queries'}). Poll with session_result id="${id}".`)
  }

  // One Pool C session per query, dispatched concurrently. allSettled so a
  // single agent failure doesn't nullify the remaining answers.
  const resolvedCwd = resolveCwd(args.cwd)
  const settled = await Promise.allSettled(
    queries.map((q) => {
      const llm = makeBridgeLlm({ role: spec.role, cwd: resolvedCwd })
      return llm({ prompt: spec.build(q) })
    }),
  )

  if (queries.length === 1) {
    const r = settled[0]
    if (r.status === 'fulfilled') return ok(r.value || '(no response)')
    return fail(`${spec.label} error: ${r.reason?.message || String(r.reason)}`)
  }

  const merged = settled.map((r, i) => {
    const header = `### Query ${i + 1}: ${queries[i]}`
    if (r.status === 'fulfilled') return `${header}\n${r.value || '(no response)'}`
    return `${header}\n[${spec.label} error] ${r.reason?.message || String(r.reason)}`
  }).join('\n\n---\n\n')
  return ok(merged)
}

function buildExplorerPrompt(query) {
  // cwd rides in the session's tier3Reminder (<system-reminder># cwd) via
  // bridge-llm's opts.cwd plumbing — not in the user message body — so the
  // message prefix stays shareable with recall/search calls for cache hit.
  return `Query: ${query}\n\nUse your read-only tools (glob / grep / read / multi_read) to find grounded answers. Return concise prose with concrete file paths.`
}

function buildRecallPrompt(query) {
  return `Query: ${query}\n\nUse the \`memory_search\` tool to retrieve ranked entries. Return concise prose citing entry ids inline.`
}

function buildSearchPrompt(query) {
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

function pushAsyncResult(ctx, id, tool, queries, body, flags = {}) {
  const notify = ctx?.notifyFn
  if (typeof notify !== 'function') return
  const querySummary = queries.length === 1
    ? String(queries[0]).slice(0, 160)
    : `${queries.length} queries`
  const header = flags.error
    ? `[async-result ${id}] ${tool} failed`
    : `[async-result ${id}] ${tool} complete — ${querySummary}`
  const content = `${header}\n\n${body}`
  try {
    notify(content, { type: 'async_result', tool, instruction: `The async ${tool} dispatch you started earlier (${id}) has returned — use this answer in your next step and do not re-poll session_result for this handle.` })
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
