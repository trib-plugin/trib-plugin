/**
 * ai-wrapped-dispatch — Step B deferred mode for `recall` / `search`.
 *
 * For tools flagged `aiWrapped: true` in tools.json, server.mjs routes
 * here instead of the direct module handler. Raw results from the
 * underlying handler (memory worker `search_memories` for recall, search
 * module `search` for search) are collected and passed to Pool C synth
 * via `synth({ task, userMessage })`, which runs a single-shot LLM call
 * with the monolithic Pool C SYSTEM. The model returns the response
 * following the task's response contract (rules/pool-c/20-recall-agent.md
 * for recall, rules/pool-c/21-search-agent.md for search).
 */

import { pathToFileURL } from 'url'
import { join } from 'path'
import { synth } from '../../shared/llm/agentic-synth.mjs'

export async function dispatchAiWrapped(name, args, ctx) {
  const rawQuery = args.query
  if (rawQuery == null) return fail('query is required')
  const queries = Array.isArray(rawQuery) ? rawQuery : [rawQuery]
  if (queries.length === 0) return fail('query cannot be empty')

  if (name === 'recall') {
    const raws = await Promise.all(queries.map(q =>
      ctx.callMemoryWorker('search_memories', { query: q, limit: 20 })
        .catch(err => ({ error: err?.message || String(err) })),
    ))
    const userMessage = composeUserMessage('recall', queries, raws)
    const text = await synth({ task: 'recall', userMessage })
    return ok(text)
  }

  if (name === 'search') {
    const searchMod = await import(
      pathToFileURL(join(ctx.PLUGIN_ROOT, 'src/search/index.mjs')).href
    )
    const raws = await Promise.all(queries.map(q =>
      searchMod.handleToolCall('search', { keywords: q })
        .catch(err => ({ error: err?.message || String(err) })),
    ))
    const userMessage = composeUserMessage('search', queries, raws)
    const text = await synth({ task: 'search', userMessage })
    return ok(text)
  }

  throw new Error(`Unknown aiWrapped tool: ${name}`)
}

function composeUserMessage(task, queries, raws) {
  const isMulti = queries.length > 1
  const lines = []
  lines.push(`Task: ${task}`)
  lines.push('')
  lines.push(isMulti ? `Queries (${queries.length}):` : 'Query:')
  queries.forEach((q, i) => lines.push(`  ${i + 1}. ${q}`))
  lines.push('')
  lines.push(isMulti ? 'Raw results per query:' : 'Raw results:')
  raws.forEach((r, i) => {
    lines.push('')
    lines.push(isMulti ? `--- For query ${i + 1} ---` : '---')
    lines.push(typeof r === 'string' ? r : JSON.stringify(r, null, 2))
  })
  return lines.join('\n')
}

function ok(text) {
  return { content: [{ type: 'text', text }] }
}

function fail(msg) {
  return { content: [{ type: 'text', text: `[aiWrapped error] ${msg}` }], isError: true }
}
