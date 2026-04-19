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
 */

const ROLE_BY_TOOL = Object.freeze({
  recall:  { role: 'recall-agent',  build: buildRecallPrompt,   label: 'recall-agent' },
  search:  { role: 'search-agent',  build: buildSearchPrompt,   label: 'search-agent' },
  explore: { role: 'explorer',      build: buildExplorerPrompt, label: 'explorer agent' },
})

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

  // One Pool C session per query, dispatched concurrently. allSettled so a
  // single agent failure doesn't nullify the remaining answers.
  const settled = await Promise.allSettled(
    queries.map((q) => {
      const llm = makeBridgeLlm({ role: spec.role })
      return llm({ prompt: spec.build(q, args.cwd) })
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

function buildExplorerPrompt(query, cwdOverride) {
  const lines = []
  if (cwdOverride) {
    lines.push(`Override cwd: ${cwdOverride}`)
    lines.push('')
  }
  lines.push(`Query: ${query}`)
  lines.push('')
  lines.push('Use your read-only tools (glob / grep / read) to find grounded answers. Return concise prose with concrete file paths.')
  return lines.join('\n')
}

function buildRecallPrompt(query, cwdOverride) {
  const lines = []
  if (cwdOverride) {
    lines.push(`Override cwd: ${cwdOverride}`)
    lines.push('')
  }
  lines.push(`Query: ${query}`)
  lines.push('')
  lines.push('Use the `memory_search` tool to retrieve ranked entries. Return concise prose citing entry ids inline.')
  return lines.join('\n')
}

function buildSearchPrompt(query, cwdOverride) {
  const lines = []
  if (cwdOverride) {
    lines.push(`Override cwd: ${cwdOverride}`)
    lines.push('')
  }
  lines.push(`Query: ${query}`)
  lines.push('')
  lines.push('Use the `web_search` tool to retrieve ranked results. Return concise prose with cited URLs.')
  return lines.join('\n')
}

function ok(text) {
  return { content: [{ type: 'text', text }] }
}

function fail(msg) {
  return { content: [{ type: 'text', text: `[aiWrapped error] ${msg}` }], isError: true }
}
