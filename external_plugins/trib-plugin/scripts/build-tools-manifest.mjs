#!/usr/bin/env node
/**
 * Build tools.json — the static tool manifest consumed by server.mjs.
 *
 * Collects TOOL_DEFS from all four plugin modules and tags each tool
 * with its originating module so that server.mjs can route CallTool
 * requests without a runtime handler discovery pass.
 *
 * Usage:  node scripts/build-tools-manifest.mjs
 * Output: <plugin-root>/tools.json
 */

import { writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(__dirname, '..')
const OUTPUT = join(PLUGIN_ROOT, 'tools.json')

globalThis.__tribFastEntry = true
process.env.CLAUDE_PLUGIN_ROOT = PLUGIN_ROOT
if (!process.env.CLAUDE_PLUGIN_DATA) {
  process.env.CLAUDE_PLUGIN_DATA = join(PLUGIN_ROOT, '.data')
}

const MODULES = [
  { name: 'channels', path: 'src/channels/index.mjs' },
  { name: 'memory',   path: 'src/memory/index.mjs' },
  { name: 'search',   path: 'src/search/index.mjs' },
  { name: 'agent',    path: 'src/agent/index.mjs' },
]

const t0 = Date.now()
const collected = []

for (const { name, path } of MODULES) {
  const url = pathToFileURL(join(PLUGIN_ROOT, path)).href
  const mod = await import(url)
  const defs = Array.isArray(mod.TOOL_DEFS) ? mod.TOOL_DEFS : []
  for (const def of defs) {
    collected.push({ ...def, module: name })
  }
  console.error(`[build-tools] ${name.padEnd(8)}: ${String(defs.length).padStart(3)} tools`)
}

// Deduplicate by name (later modules override earlier if collision)
const seen = new Set()
const unique = []
for (let i = collected.length - 1; i >= 0; i--) {
  const t = collected[i]
  if (seen.has(t.name)) continue
  seen.add(t.name)
  unique.unshift(t)
}

// Validate
for (const tool of unique) {
  if (!tool.name) throw new Error(`Tool missing name: ${JSON.stringify(tool).slice(0, 120)}`)
  if (!tool.description) throw new Error(`${tool.name}: missing description`)
  if (!tool.inputSchema) throw new Error(`${tool.name}: missing inputSchema`)
  if (!tool.module) throw new Error(`${tool.name}: missing module`)
}

writeFileSync(OUTPUT, JSON.stringify(unique, null, 2) + '\n')
console.error(`[build-tools] wrote ${unique.length} tools → ${OUTPUT}`)
console.error(`[build-tools] done in ${Date.now() - t0} ms`)
process.exit(0)
