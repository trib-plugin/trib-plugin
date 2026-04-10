#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
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
const tsxBin = join(
  dataNodeModules,
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
)
const logPath = join(pluginData, 'run-mcp.log')

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

async function isExecutable(path) {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK)
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
    try { unlinkSync(dataManifestPath) } catch {}
    process.exit(result.status ?? 1)
  }
}

async function syncDependenciesIfNeeded() {
  mkdirSync(pluginData, { recursive: true })
  log(`invoked root=${pluginRoot} data=${pluginData}`)

  let needsInstall = false
  if (depsHash(manifestPath) !== depsHash(dataManifestPath)) {
    needsInstall = true
  }
  if (!(await isExecutable(tsxBin))) {
    needsInstall = true
  }

  if (!needsInstall) {
    return
  }

  log('dependency sync required')
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
}

await syncDependenciesIfNeeded()

// Ensure native modules (sharp etc.) have correct platform binaries.
// The marketplace node_modules may have been installed on a different OS
// (e.g. Linux CI), so binaries for the current platform could be missing.
function ensureNativeDeps() {
  const nativeModules = ['sharp']
  const rootNodeModules = join(pluginRoot, 'node_modules')
  try { statSync(rootNodeModules) } catch { return }

  for (const mod of nativeModules) {
    try {
      const modPath = join(rootNodeModules, mod)
      statSync(modPath)
      // Try loading — if it throws, the platform binary is missing
      const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(modPath)})`], {
        cwd: pluginRoot, stdio: 'pipe', timeout: 10000,
      })
      if (result.status !== 0) {
        log(`${mod}: platform binary missing, rebuilding...`)
        const rebuildResult = spawnSync(
          process.platform === 'win32' ? 'npm.cmd' : 'npm',
          ['rebuild', mod],
          { cwd: pluginRoot, stdio: 'pipe', shell: process.platform === 'win32', timeout: 30000 },
        )
        if (rebuildResult.status === 0) {
          log(`${mod}: rebuild OK`)
        } else {
          log(`${mod}: rebuild failed, installing with platform flags...`)
          spawnSync(
            process.platform === 'win32' ? 'npm.cmd' : 'npm',
            ['install', `--os=${process.platform}`, `--cpu=${process.arch}`, mod],
            { cwd: pluginRoot, stdio: 'pipe', shell: process.platform === 'win32', timeout: 60000 },
          )
          log(`${mod}: platform install done`)
        }
      }
    } catch { /* module not present, skip */ }
  }
}

ensureNativeDeps()

const serverTs = join(pluginRoot, 'server.ts')
const serverJs = join(pluginRoot, 'server.bundle.mjs')
const esbuildBin = join(dataNodeModules, '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
const sep = process.platform === 'win32' ? ';' : ':'
const spawnEnv = {
  ...process.env,
  TRIB_UNIFIED: '1',
  NODE_PATH: [dataNodeModules, pluginRoot, process.env.NODE_PATH].filter(Boolean).join(sep),
}

// Prefer pre-built bundle shipped with the plugin (no runtime esbuild needed).
// Falls back to runtime build if pre-built bundle is missing (dev mode).
const prebuiltBundle = join(pluginRoot, 'dist', 'server.bundle.mjs')
let serverFile

try {
  statSync(prebuiltBundle)
  serverFile = prebuiltBundle
  log('using pre-built bundle')
} catch {
  // No pre-built bundle — try root bundle or build at runtime
  log('no pre-built bundle, building at runtime...')
  function buildBundle() {
    try {
      let entryTs = serverTs
      const srcStat = statSync(entryTs)
      try {
        const bundleStat = statSync(serverJs)
        if (bundleStat.mtimeMs >= srcStat.mtimeMs) return true
      } catch {}
      const result = spawnSync(esbuildBin, [
        entryTs, '--bundle', '--platform=node', '--format=esm',
        `--outfile=${serverJs}`, '--packages=external',
      ], { cwd: pluginRoot, stdio: 'pipe', shell: process.platform === 'win32', timeout: 30000 })
      if (result.status === 0) { log('bundle built'); return true }
      log(`bundle build failed: ${result.stderr?.toString().slice(0, 200)}`)
      return false
    } catch (e) { log(`bundle build error: ${e.message}`); return false }
  }

  if (buildBundle()) {
    serverFile = serverJs
  } else {
    // tsx fallback
    serverFile = null
  }
}

const child = serverFile
  ? (() => {
      log(`exec node ${serverFile}`)
      return spawn('node', [serverFile], { cwd: pluginRoot, stdio: 'inherit', env: spawnEnv })
    })()
  : process.platform === 'win32'
  ? (() => {
      const tsxCliPath = join(dataNodeModules, 'tsx', 'dist', 'cli.mjs')
      log(`exec tsx fallback ${serverTs}`)
      return spawn('node', [tsxCliPath, serverTs], { cwd: pluginRoot, stdio: 'inherit', env: spawnEnv })
    })()
  : (() => {
      log(`exec tsx fallback ${serverTs}`)
      return spawn(tsxBin, [serverTs], { cwd: pluginRoot, stdio: 'inherit', env: spawnEnv })
    })()

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
