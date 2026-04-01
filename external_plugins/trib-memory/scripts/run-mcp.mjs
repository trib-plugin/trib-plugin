#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { access } from 'fs/promises'
import { constants } from 'fs'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
const pluginData = process.env.CLAUDE_PLUGIN_DATA

if (!pluginRoot) {
  process.stderr.write('run-mcp: CLAUDE_PLUGIN_ROOT is required\n')
  process.exit(1)
}

if (!pluginData) {
  process.stderr.write('run-mcp: CLAUDE_PLUGIN_DATA is required\n')
  process.exit(1)
}

const nodeModules = join(pluginRoot, 'node_modules')
const logPath = join(pluginData, 'run-mcp.log')

function log(message) {
  mkdirSync(pluginData, { recursive: true })
  writeFileSync(logPath, `[${new Date().toLocaleString('sv-SE', { hour12: false })}] ${message}\n`, { flag: 'a' })
}

async function syncDependenciesIfNeeded() {
  log(`invoked root=${pluginRoot} data=${pluginData}`)

  try {
    await access(join(nodeModules, '@modelcontextprotocol'), constants.R_OK)
    return
  } catch { /* needs install */ }

  log('dependency install required')
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--omit=dev', '--silent'],
    { cwd: pluginRoot, stdio: 'inherit', env: process.env },
  )
  if (result.status !== 0) {
    log(`npm install failed with status ${result.status}`)
    process.exit(result.status ?? 1)
  }
  log('npm install completed')
}

await syncDependenciesIfNeeded()

const serverMjs = join(pluginRoot, 'services', 'memory-service.mjs')

log(`exec node --no-warnings ${serverMjs}`)
const child = spawn('node', ['--no-warnings', serverMjs], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: process.env,
})

let shuttingDown = false
function relayShutdown(signal = 'SIGTERM') {
  if (shuttingDown) return
  shuttingDown = true
  log(`relay shutdown signal=${signal}`)
  try { child.kill(signal) } catch { process.exit(0); return }
  setTimeout(() => {
    try { child.kill('SIGKILL') } catch {}
  }, 3000).unref()
}

child.on('exit', (code, signal) => {
  log(`child exit code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  process.exit(code ?? 0)
})
child.on('error', err => {
  log(`spawn failed: ${err}`)
  process.stderr.write(`run-mcp: spawn failed: ${err}\n`)
  process.exit(1)
})

process.on('SIGTERM', () => relayShutdown('SIGTERM'))
process.on('SIGINT', () => relayShutdown(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT'))
process.on('SIGHUP', () => relayShutdown('SIGTERM'))
process.on('disconnect', () => relayShutdown('SIGTERM'))
