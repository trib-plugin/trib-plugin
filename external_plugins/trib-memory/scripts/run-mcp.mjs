#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, unlinkSync, openSync, closeSync } from 'fs'
import { copyFile } from 'fs/promises'
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

const manifestPath = join(pluginRoot, 'package.json')
const lockfilePath = join(pluginRoot, 'package-lock.json')
const dataManifestPath = join(pluginData, 'package.json')
const dataLockfilePath = join(pluginData, 'package-lock.json')
const dataNodeModules = join(pluginData, 'node_modules')
const logPath = join(pluginData, 'run-mcp.log')
const syncLockPath = join(pluginData, '.sync.lock')

function log(message) {
  writeFileSync(
    logPath,
    `[${new Date().toLocaleString('sv-SE', { hour12: false })}] ${message}\n`,
    { flag: 'a' },
  )
}

function fileContents(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function depsHash(path) {
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    return JSON.stringify({ dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {} })
  } catch {
    return null
  }
}

function runInstall(command, args) {
  const result = spawnSync(command, args, {
    cwd: pluginData,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
    env: process.env,
  })

  if (result.status !== 0) {
    log(`npm install failed with status ${result.status}`)
    try { unlinkSync(dataManifestPath) } catch {}
    process.exit(result.status ?? 1)
  }
}

function acquireLock(maxWaitMs = 60000) {
  const pollMs = 500
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    try {
      const stat = statSync(syncLockPath)
      // Stale lock: older than 120s means the holder crashed
      if (Date.now() - stat.mtimeMs > 120000) {
        log('removing stale sync lock')
        try { unlinkSync(syncLockPath) } catch {}
      } else {
        spawnSync(process.platform === 'win32' ? 'timeout.exe' : 'sleep',
          process.platform === 'win32' ? ['/t', '1', '/nobreak'] : ['0.5'],
          { stdio: 'ignore', shell: process.platform === 'win32' })
        continue
      }
    } catch { /* lock doesn't exist — good */ }
    try {
      const fd = openSync(syncLockPath, 'wx')
      writeFileSync(fd, `${process.pid}`)
      closeSync(fd)
      return true
    } catch {
      // Another process grabbed it between our check and create
      continue
    }
  }
  log('failed to acquire sync lock after timeout')
  return false
}

function releaseLock() {
  try { unlinkSync(syncLockPath) } catch {}
}

async function syncDependenciesIfNeeded() {
  mkdirSync(pluginData, { recursive: true })
  log(`invoked root=${pluginRoot} data=${pluginData}`)

  let needsInstall = false
  if (depsHash(manifestPath) !== depsHash(dataManifestPath)) {
    needsInstall = true
  }

  if (!needsInstall) {
    return
  }

  log('dependency sync required')

  if (!acquireLock()) {
    // Another process finished sync — recheck if install is still needed
    if (depsHash(manifestPath) === depsHash(dataManifestPath)) {
      log('sync completed by another process, skipping')
      return
    }
    log('lock timeout but sync still needed, proceeding anyway')
  }

  try {
    // Re-check after acquiring lock (another process may have finished)
    if (depsHash(manifestPath) === depsHash(dataManifestPath)) {
      log('sync already completed by another process')
      return
    }

    rmSync(dataNodeModules, { recursive: true, force: true })
    await copyFile(manifestPath, dataManifestPath)

    if (fileContents(lockfilePath) != null) {
      await copyFile(lockfilePath, dataLockfilePath)
      runInstall(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--silent'])
      log('npm ci completed')
      return
    }

    runInstall(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--silent'])
    log('npm install completed')
  } finally {
    releaseLock()
  }
}

await syncDependenciesIfNeeded()

const serverFile = join(pluginRoot, 'services', 'memory-service.mjs')

log(`exec node ${serverFile}`)
// Cap ONNX Runtime thread usage so embedding/reranker don't pin all CPU cores.
// onnxruntime-node respects these env vars before any session is created.
const child = spawn('node', ['--no-warnings', serverFile], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '4',
    OMP_THREAD_LIMIT: process.env.OMP_THREAD_LIMIT || '4',
    ORT_INTRA_OP_PARALLELISM_THREADS: process.env.ORT_INTRA_OP_PARALLELISM_THREADS || '4',
    ORT_INTER_OP_PARALLELISM_THREADS: process.env.ORT_INTER_OP_PARALLELISM_THREADS || '1',
  },
})

// Lower process priority so embedding yields CPU to other programs
if (child.pid) {
  try {
    if (process.platform === 'win32') {
      spawnSync('wmic', ['process', 'where', `ProcessId=${child.pid}`, 'CALL', 'setpriority', 'below normal'], { stdio: 'ignore', shell: true })
    } else {
      spawnSync('renice', ['-n', '10', '-p', String(child.pid)], { stdio: 'ignore' })
    }
    log(`process priority lowered (pid=${child.pid})`)
  } catch (e) { log(`priority change failed: ${e.message}`) }
}

let shuttingDown = false
function relayShutdown(signal = 'SIGTERM') {
  if (shuttingDown) return
  shuttingDown = true
  log(`relay shutdown signal=${signal}`)

  try {
    child.kill(signal)
  } catch {
    process.exit(0)
    return
  }

  setTimeout(() => {
    try {
      child.kill('SIGKILL')
      log('child forced to SIGKILL after shutdown timeout')
    } catch { /* ignore */ }
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
if (process.platform !== 'win32') process.on('SIGHUP', () => relayShutdown('SIGTERM'))
process.on('disconnect', () => relayShutdown('SIGTERM'))
