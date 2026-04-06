#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, unlinkSync, openSync, closeSync } from 'fs'
import { copyFile, access } from 'fs/promises'
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

const manifestPath = join(pluginRoot, 'package.json')
const lockfilePath = join(pluginRoot, 'package-lock.json')
const dataManifestPath = join(pluginData, 'package.json')
const dataLockfilePath = join(pluginData, 'package-lock.json')
const dataNodeModules = join(pluginData, 'node_modules')
const esbuildBin = join(dataNodeModules, '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
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

async function isExecutable(path) {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
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
  if (fileContents(manifestPath) !== fileContents(dataManifestPath)) {
    needsInstall = true
  }
  if (!(await isExecutable(esbuildBin))) {
    needsInstall = true
  }

  if (!needsInstall) {
    return
  }

  log('dependency sync required')

  if (!acquireLock()) {
    // Another process finished sync — recheck if install is still needed
    if (fileContents(manifestPath) === fileContents(dataManifestPath) && await isExecutable(esbuildBin)) {
      log('sync completed by another process, skipping')
      return
    }
    log('lock timeout but sync still needed, proceeding anyway')
  }

  try {
    // Re-check after acquiring lock (another process may have finished)
    if (fileContents(manifestPath) === fileContents(dataManifestPath) && await isExecutable(esbuildBin)) {
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

// Dev: auto-sync marketplace source to cache if newer
function devSyncFromMarketplace() {
  try {
    const pluginsBase = join(pluginRoot, '..', '..', '..', '..')
    const marketName = pluginRoot.split(/[/\\]cache[/\\]/)[1]?.split(/[/\\]/)?.[0]
    const pluginName = pluginRoot.split(/[/\\]cache[/\\]/)[1]?.split(/[/\\]/)?.[1]
    if (!marketName || !pluginName) return
    const marketSrc = join(pluginsBase, 'marketplaces', marketName, 'external_plugins', pluginName)
    const dirs = ['lib', 'services', 'defaults', 'hooks']
    let synced = 0
    for (const dir of dirs) {
      try {
        const entries = require('fs').readdirSync(join(marketSrc, dir))
        for (const f of entries) {
          try {
            const src = join(marketSrc, dir, f)
            const dst = join(pluginRoot, dir, f)
            const srcMtime = statSync(src).mtimeMs
            let dstMtime = 0
            try { dstMtime = statSync(dst).mtimeMs } catch {}
            if (srcMtime > dstMtime) {
              require('fs').copyFileSync(src, dst)
              synced++
            }
          } catch {}
        }
      } catch {}
    }
    if (synced > 0) log(`dev-sync: copied ${synced} newer files from marketplace`)
  } catch {}
}
devSyncFromMarketplace()

const serverSrc = join(pluginRoot, 'services', 'memory-service.mjs')
const serverJs = join(pluginData, 'server.bundle.mjs')

function buildBundle() {
  try {
    const srcStat = statSync(serverSrc)
    try {
      const bundleStat = statSync(serverJs)
      if (bundleStat.mtimeMs >= srcStat.mtimeMs) return true
    } catch { /* bundle doesn't exist yet */ }
    log('building server bundle...')
    const result = spawnSync(esbuildBin, [
      serverSrc, '--bundle', '--platform=node', '--format=esm',
      `--outfile=${serverJs}`, '--packages=external',
    ], { cwd: pluginRoot, stdio: 'pipe', shell: process.platform === 'win32', timeout: 15000 })
    if (result.status === 0) {
      log('bundle built successfully')
      return true
    }
    log(`bundle build failed: ${result.stderr?.toString().slice(0, 200)}`)
    return false
  } catch (e) {
    log(`bundle build error: ${e.message}`)
    return false
  }
}

if (!buildBundle()) {
  log('fatal: bundle build failed, cannot start server')
  process.exit(1)
}

log(`exec node ${serverJs} (bundled)`)
const child = spawn('node', ['--no-warnings', serverJs], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: process.env,
})

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
