#!/usr/bin/env node

import { mkdirSync, readFileSync, unlinkSync, writeFileSync, statSync, rmSync } from 'fs'
import { copyFile } from 'fs/promises'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
const pluginData = process.env.CLAUDE_PLUGIN_DATA

if (!pluginRoot || !pluginData) {
  process.stderr.write('run-mcp: CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA required\n')
  process.exit(1)
}

mkdirSync(pluginData, { recursive: true })

const logPath = join(pluginData, 'run-mcp.log')
function log(msg) {
  writeFileSync(logPath, `[${new Date().toLocaleString('sv-SE', { hour12: false })}] ${msg}\n`, { flag: 'a' })
}

// ── Single-instance lock ──
const lockFile = join(pluginData, 'mcp.lock')
try {
  const oldPid = parseInt(readFileSync(lockFile, 'utf8'), 10)
  if (oldPid && oldPid !== process.pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(oldPid), '/T', '/F'], { stdio: 'pipe', timeout: 3000, shell: true })
    } else {
      try { process.kill(oldPid, 'SIGTERM') } catch {}
    }
  }
} catch {}
writeFileSync(lockFile, String(process.pid))

// ── Spawn child IMMEDIATELY — handshake must happen before Claude Code times out ──

const dataNodeModules = join(pluginData, 'node_modules')
const fastEntry = join(pluginRoot, 'scripts', 'server-fast-entry.mjs')
const prebuiltBundle = join(pluginRoot, 'dist', 'server.bundle.mjs')
const serverJs = join(pluginRoot, 'server.bundle.mjs')
const sep = process.platform === 'win32' ? ';' : ':'
const spawnEnv = {
  ...process.env,
  TRIB_UNIFIED: '1',
  NODE_PATH: [dataNodeModules, pluginRoot, process.env.NODE_PATH].filter(Boolean).join(sep),
}

// Check bundle existence (sync, fast — no spawns)
let hasBundleReady = false
try { statSync(prebuiltBundle); hasBundleReady = true } catch {
  try { statSync(serverJs); hasBundleReady = true } catch {}
}

log(`invoked ppid=${process.ppid} pid=${process.pid} bundle=${hasBundleReady}`)

const childStdio = ['pipe', 'inherit', 'inherit']
let child

if (hasBundleReady) {
  child = spawn('node', [fastEntry], { cwd: pluginRoot, stdio: childStdio, env: spawnEnv })
} else {
  // No bundle — use tsx fallback (slower, but unavoidable)
  const tsxCliPath = join(dataNodeModules, 'tsx', 'dist', 'cli.mjs')
  const serverTs = join(pluginRoot, 'server.ts')
  child = spawn('node', [tsxCliPath, serverTs], { cwd: pluginRoot, stdio: childStdio, env: spawnEnv })
}

// Pipe stdin IMMEDIATELY
process.stdin.pipe(child.stdin)
log(`child spawned pid=${child.pid}`)

// ── Shutdown handling ──

let shuttingDown = false
function killChild() {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'pipe', timeout: 3000, shell: true })
  } else {
    child.kill('SIGTERM')
  }
}

function relayShutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutdown: ${reason}`)
  try { killChild() } catch {}
  process.exit(0)
}

process.stdin.on('end', () => relayShutdown('stdin ended'))
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') relayShutdown('stdout pipe closed') })
child.on('exit', (code) => { log(`child exit code=${code ?? 'null'}`); process.exit(code ?? 0) })
child.on('error', (err) => { log(`spawn failed: ${err}`); process.exit(1) })
process.on('exit', () => { try { killChild() } catch {}; try { unlinkSync(lockFile) } catch {} })
process.on('SIGTERM', () => relayShutdown('SIGTERM'))
process.on('SIGINT', () => relayShutdown('SIGINT'))
process.on('disconnect', () => relayShutdown('parent disconnected'))

// ── Deferred work (after child is alive) ──

setTimeout(async () => {
  // Sync dependencies if needed
  const manifestPath = join(pluginRoot, 'package.json')
  const dataManifestPath = join(pluginData, 'package.json')

  function depsHash(p) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8'))
      return JSON.stringify({ dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {} })
    } catch { return null }
  }

  if (depsHash(manifestPath) !== depsHash(dataManifestPath)) {
    log('deferred: dependency sync needed')
    const lockfilePath = join(pluginRoot, 'package-lock.json')
    const dataLockfilePath = join(pluginData, 'package-lock.json')
    rmSync(dataNodeModules, { recursive: true, force: true })
    await copyFile(manifestPath, dataManifestPath)
    try { await copyFile(lockfilePath, dataLockfilePath) } catch {}

    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    spawnSync(npm, ['ci', '--omit=dev', '--silent'], {
      cwd: pluginData, stdio: ['ignore', 'pipe', 'inherit'],
      shell: process.platform === 'win32', env: process.env,
    })
    log('deferred: npm install done')
  }
}, 3000)
