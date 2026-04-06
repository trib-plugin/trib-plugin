#!/usr/bin/env node

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
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
  rmSync(dataNodeModules, { recursive: true, force: true })
  await copyFile(manifestPath, dataManifestPath)

  if (fileContents(lockfilePath) != null) {
    await copyFile(lockfilePath, dataLockfilePath)
    runInstall(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--silent'])
    log('npm ci completed')
    return
  }

  runInstall(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--silent'])
  log('npm install completed')
}

await syncDependenciesIfNeeded()

// Config reading
function readLocalConfig() {
  try {
    const configPath = join(pluginData, 'config.json')
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

const localConfig = readLocalConfig()

// Dev: auto-sync marketplace source to cache if newer
function devSyncFromMarketplace() {
  try {
    const pluginsBase = join(pluginRoot, '..', '..', '..', '..')
    const marketName = pluginRoot.split(/[/\\]cache[/\\]/)[1]?.split(/[/\\]/)?.[0]
    const pluginName = pluginRoot.split(/[/\\]cache[/\\]/)[1]?.split(/[/\\]/)?.[1]
    if (!marketName || !pluginName) return
    const marketSrc = join(pluginsBase, 'marketplaces', marketName, 'external_plugins', pluginName)
    const dirs = ['src', 'src/providers', 'src/session', '.']
    let synced = 0
    for (const dir of dirs) {
      try {
        const base = dir === '.' ? marketSrc : join(marketSrc, dir)
        const entries = readdirSync(base).filter(f => f.endsWith('.ts') || f.endsWith('.mjs') || f.endsWith('.json') || f.endsWith('.md'))
        for (const f of entries) {
          try {
            const src = join(base, f)
            const dst = dir === '.' ? join(pluginRoot, f) : join(pluginRoot, dir, f)
            const srcMtime = statSync(src).mtimeMs
            let dstMtime = 0
            try { dstMtime = statSync(dst).mtimeMs } catch {}
            if (srcMtime > dstMtime) {
              mkdirSync(join(pluginRoot, dir), { recursive: true })
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

// Bundle TypeScript source with esbuild
const serverSrc = join(pluginRoot, 'src', 'index.ts')
const serverJs = join(pluginData, 'server.bundle.mjs')

function getMaxSourceMtime() {
  let max = 0
  const srcDirs = [
    join(pluginRoot, 'src'),
    join(pluginRoot, 'src', 'providers'),
    join(pluginRoot, 'src', 'session'),
  ]
  for (const dir of srcDirs) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.ts')) {
          try { max = Math.max(max, statSync(join(dir, f)).mtimeMs) } catch {}
        }
      }
    } catch {}
  }
  return max
}

function buildBundle() {
  try {
    const maxSourceMtime = getMaxSourceMtime()
    try {
      const bundleStat = statSync(serverJs)
      if (bundleStat.mtimeMs >= maxSourceMtime) return true
    } catch { /* bundle doesn't exist yet */ }
    log('building server bundle...')
    const result = spawnSync(esbuildBin, [
      serverSrc, '--bundle', '--platform=node', '--format=esm',
      `--outfile=${serverJs}`, '--packages=external',
    ], { cwd: pluginRoot, stdio: 'pipe', shell: process.platform === 'win32', timeout: 30000 })
    if (result.status === 0) {
      log('bundle built successfully')
      return true
    }
    log(`bundle build failed: ${result.stderr?.toString().slice(0, 500)}`)
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

// Bundle CLI for slash commands
const cliSrc = join(pluginRoot, 'scripts', 'cli.mjs')
const cliJs = join(pluginData, 'cli.bundle.mjs')
try {
  const cliMtime = statSync(cliSrc).mtimeMs
  let cliBundleMtime = 0
  try { cliBundleMtime = statSync(cliJs).mtimeMs } catch {}
  if (cliMtime > cliBundleMtime) {
    const result = spawnSync(esbuildBin, [
      cliSrc, '--bundle', '--platform=node', '--format=esm',
      `--outfile=${cliJs}`, '--packages=external',
    ], { cwd: pluginRoot, stdio: 'pipe', shell: process.platform === 'win32', timeout: 15000 })
    if (result.status === 0) log('cli bundle built')
    else log(`cli bundle failed: ${result.stderr?.toString().slice(0, 200)}`)
  }
} catch (e) {
  log(`cli bundle skipped: ${e.message}`)
}

// Read API keys from config
function readNestedKey(config, pathParts) {
  let current = config
  for (const part of pathParts) {
    if (!current || typeof current !== 'object') return ''
    current = current[part]
  }
  return typeof current === 'string' ? current : ''
}

const spawnEnv = {
  ...process.env,
  CLAUDE_PLUGIN_ROOT: pluginRoot,
  CLAUDE_PLUGIN_DATA: pluginData,
  // Pass API keys from config.json as env vars
  ...(readNestedKey(localConfig, ['providers', 'openai', 'apiKey']) ? { OPENAI_API_KEY: readNestedKey(localConfig, ['providers', 'openai', 'apiKey']) } : {}),
  ...(readNestedKey(localConfig, ['providers', 'anthropic', 'apiKey']) ? { ANTHROPIC_API_KEY: readNestedKey(localConfig, ['providers', 'anthropic', 'apiKey']) } : {}),
  ...(readNestedKey(localConfig, ['providers', 'gemini', 'apiKey']) ? { GEMINI_API_KEY: readNestedKey(localConfig, ['providers', 'gemini', 'apiKey']) } : {}),
  ...(readNestedKey(localConfig, ['providers', 'groq', 'apiKey']) ? { GROQ_API_KEY: readNestedKey(localConfig, ['providers', 'groq', 'apiKey']) } : {}),
  ...(readNestedKey(localConfig, ['providers', 'openrouter', 'apiKey']) ? { OPENROUTER_API_KEY: readNestedKey(localConfig, ['providers', 'openrouter', 'apiKey']) } : {}),
  ...(readNestedKey(localConfig, ['providers', 'xai', 'apiKey']) ? { XAI_API_KEY: readNestedKey(localConfig, ['providers', 'xai', 'apiKey']) } : {}),
}

log(`exec node ${serverJs} (bundled)`)
const child = spawn('node', [serverJs], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: spawnEnv,
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
  log(`exit code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  process.exit(code ?? 0)
})
child.on('error', err => {
  log(`spawn error=${err}`)
  process.stderr.write(`run-mcp: spawn failed: ${err}\n`)
  process.exit(1)
})

process.on('SIGTERM', () => relayShutdown('SIGTERM'))
process.on('SIGINT', () => relayShutdown(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT'))
if (process.platform !== 'win32') process.on('SIGHUP', () => relayShutdown('SIGTERM'))
process.on('disconnect', () => relayShutdown('SIGTERM'))
