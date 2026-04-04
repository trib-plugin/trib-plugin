#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
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

  runInstall(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--silent'])
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

function readNestedKey(config, pathParts) {
  let current = config
  for (const part of pathParts) {
    if (!current || typeof current !== 'object') return ''
    current = current[part]
  }
  return typeof current === 'string' ? current : ''
}

const localConfig = readLocalConfig()

const grokApiKey =
  localConfig?.grokApiKey ||
  readNestedKey(localConfig, ['aiSearch', 'profiles', 'grok', 'apiKey'])

const xaiApiKey =
  localConfig?.xaiApiKey ||
  readNestedKey(localConfig, ['rawSearch', 'credentials', 'xai', 'apiKey']) ||
  grokApiKey

const firecrawlApiKey =
  localConfig?.firecrawlApiKey ||
  readNestedKey(localConfig, ['rawSearch', 'credentials', 'firecrawl', 'apiKey']) ||
  readNestedKey(localConfig, ['aiSearch', 'profiles', 'firecrawl', 'apiKey'])

const serperApiKey =
  localConfig?.serperApiKey ||
  readNestedKey(localConfig, ['rawSearch', 'credentials', 'serper', 'apiKey'])

const braveApiKey =
  localConfig?.braveApiKey ||
  readNestedKey(localConfig, ['rawSearch', 'credentials', 'brave', 'apiKey'])

const perplexityApiKey =
  localConfig?.perplexityApiKey ||
  readNestedKey(localConfig, ['rawSearch', 'credentials', 'perplexity', 'apiKey'])

const tavilyApiKey =
  localConfig?.tavilyApiKey ||
  readNestedKey(localConfig, ['rawSearch', 'credentials', 'tavily', 'apiKey'])

const githubToken =
  localConfig?.githubToken ||
  readNestedKey(localConfig, ['rawSearch', 'credentials', 'github', 'apiKey'])

// Bundle
const serverSrc = join(pluginRoot, 'server.mjs')
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

const spawnEnv = {
  ...process.env,
  ...(xaiApiKey ? { GROK_API_KEY: xaiApiKey, XAI_API_KEY: xaiApiKey } : {}),
  ...(serperApiKey ? { SERPER_API_KEY: serperApiKey } : {}),
  ...(braveApiKey ? { BRAVE_API_KEY: braveApiKey } : {}),
  ...(perplexityApiKey ? { PERPLEXITY_API_KEY: perplexityApiKey } : {}),
  ...(firecrawlApiKey ? { FIRECRAWL_API_KEY: firecrawlApiKey } : {}),
  ...(tavilyApiKey ? { TAVILY_API_KEY: tavilyApiKey } : {}),
  ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
  CLAUDE_PLUGIN_ROOT: pluginRoot,
  CLAUDE_PLUGIN_DATA: pluginData,
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
