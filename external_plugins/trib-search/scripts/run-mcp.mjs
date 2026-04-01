#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd()
const pluginData = process.env.CLAUDE_PLUGIN_DATA || path.join(pluginRoot, '.trib-search-data')
const manifestPath = path.join(pluginRoot, 'package.json')
const lockfilePath = path.join(pluginRoot, 'package-lock.json')
const rootNodeModules = path.join(pluginRoot, 'node_modules')
const logPath = path.join(pluginData, 'run-mcp.log')

fs.mkdirSync(pluginData, { recursive: true })

function log(message) {
  fs.writeFileSync(
    logPath,
    `[${new Date().toLocaleString('sv-SE', { hour12: false })}] ${message}\n`,
    { flag: 'a' },
  )
}

log(`start root=${pluginRoot} data=${pluginData}`)

function readLocalConfig() {
  try {
    const configPath = path.join(pluginData, 'config.json')
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

const localConfig = readLocalConfig()

function readNestedKey(config, pathParts) {
  let current = config
  for (const part of pathParts) {
    if (!current || typeof current !== 'object') return ''
    current = current[part]
  }
  return typeof current === 'string' ? current : ''
}

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

function fileContents(targetPath) {
  try {
    return fs.readFileSync(targetPath, 'utf8')
  } catch {
    return null
  }
}

function runInstall(command, args) {
  const result = spawnSync(command, args, {
    cwd: pluginRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

async function syncDependenciesIfNeeded() {
  const needsInstall =
    !fs.existsSync(rootNodeModules)

  if (!needsInstall) {
    return
  }

  if (fileContents(lockfilePath) != null) {
    runInstall(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--silent'])
    return
  }

  runInstall(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--silent'])
}

await syncDependenciesIfNeeded()

const child = spawn('node', [path.join(pluginRoot, 'server.mjs')], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(xaiApiKey
      ? {
          GROK_API_KEY: xaiApiKey,
          XAI_API_KEY: xaiApiKey,
        }
      : {}),
    ...(serperApiKey
      ? {
          SERPER_API_KEY: serperApiKey,
        }
      : {}),
    ...(braveApiKey
      ? {
          BRAVE_API_KEY: braveApiKey,
        }
      : {}),
    ...(perplexityApiKey
      ? {
          PERPLEXITY_API_KEY: perplexityApiKey,
        }
      : {}),
    ...(firecrawlApiKey
      ? {
          FIRECRAWL_API_KEY: firecrawlApiKey,
        }
      : {}),
    ...(tavilyApiKey
      ? {
          TAVILY_API_KEY: tavilyApiKey,
        }
      : {}),
    ...(githubToken
      ? {
          GITHUB_TOKEN: githubToken,
        }
      : {}),
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: pluginData,
  },
})

child.on('exit', (code, signal) => {
  log(`exit code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  process.exit(code ?? 0)
})

child.on('error', error => {
  log(`spawn error=${error}`)
  process.stderr.write(`trib-search run-mcp failed: ${error}\n`)
  process.exit(1)
})
