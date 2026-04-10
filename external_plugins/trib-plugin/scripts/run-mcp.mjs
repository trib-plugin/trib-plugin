#!/usr/bin/env node
/**
 * MCP entry wrapper — spawns server.mjs IMMEDIATELY, no blocking work.
 * Only responsibilities: single-instance lock + spawn + relay exit.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
const pluginData = process.env.CLAUDE_PLUGIN_DATA
if (!pluginRoot || !pluginData) { process.exit(1) }
mkdirSync(pluginData, { recursive: true })

// ── Single-instance lock ──
const lockFile = join(pluginData, 'mcp.lock')
try {
  const oldPid = parseInt(readFileSync(lockFile, 'utf8'), 10)
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, 0)
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(oldPid), '/F'], { stdio: 'pipe', timeout: 3000, shell: true })
      } else {
        process.kill(oldPid, 'SIGTERM')
      }
    } catch {}
  }
} catch {}
writeFileSync(lockFile, String(process.pid))
process.on('exit', () => { try { unlinkSync(lockFile) } catch {} })

// ── Spawn server IMMEDIATELY (no blocking work before this) ──
const serverEntry = join(pluginRoot, 'scripts', 'server.mjs')
const sep = process.platform === 'win32' ? ';' : ':'
const child = spawn('node', [serverEntry], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    TRIB_UNIFIED: '1',
    NODE_PATH: [join(pluginData, 'node_modules'), pluginRoot, process.env.NODE_PATH].filter(Boolean).join(sep),
  },
})

// ── Relay exit ──
child.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGTERM', () => { try { child.kill('SIGTERM') } catch {} })
process.on('SIGINT', () => { try { child.kill('SIGINT') } catch {} })
