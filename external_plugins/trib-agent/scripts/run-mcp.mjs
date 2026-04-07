#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { copyFile } from 'fs/promises'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
const pluginData = process.env.CLAUDE_PLUGIN_DATA

if (!pluginRoot || !pluginData) {
  process.stderr.write('run-mcp: CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA are required\n')
  process.exit(1)
}

const dataNodeModules = join(pluginData, 'node_modules')
const logPath = join(pluginData, 'run-mcp.log')

function log(message) {
  writeFileSync(logPath, `[${new Date().toLocaleString('sv-SE', { hour12: false })}] ${message}\n`, { flag: 'a' })
}

function fileContents(path) {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

function depsHash(path) {
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    return JSON.stringify({ dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {} })
  } catch {
    return null
  }
}

async function syncDependenciesIfNeeded() {
  mkdirSync(pluginData, { recursive: true })
  log(`invoked root=${pluginRoot} data=${pluginData}`)

  const manifestPath = join(pluginRoot, 'package.json')
  const lockfilePath = join(pluginRoot, 'package-lock.json')
  const dataManifestPath = join(pluginData, 'package.json')
  const dataLockfilePath = join(pluginData, 'package-lock.json')

  if (depsHash(manifestPath) === depsHash(dataManifestPath)) return

  log('dependency sync required')
  rmSync(dataNodeModules, { recursive: true, force: true })
  await copyFile(manifestPath, dataManifestPath)

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const lockContent = fileContents(lockfilePath)
  if (lockContent != null) {
    await copyFile(lockfilePath, dataLockfilePath)
    const r = spawnSync(npmCmd, ['ci', '--omit=dev', '--silent'], { cwd: pluginData, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' })
    if (r.status !== 0) { log(`npm ci failed with status ${r.status}`); try { unlinkSync(dataManifestPath) } catch {}; process.exit(r.status ?? 1) }
    log('npm ci completed')
  } else {
    const r = spawnSync(npmCmd, ['install', '--omit=dev', '--silent'], { cwd: pluginData, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' })
    if (r.status !== 0) { log(`npm install failed with status ${r.status}`); try { unlinkSync(dataManifestPath) } catch {}; process.exit(r.status ?? 1) }
    log('npm install completed')
  }
}

await syncDependenciesIfNeeded()

const serverFile = join(pluginRoot, 'server.mjs')
log(`exec node ${serverFile}`)

const child = spawn(process.execPath, [serverFile], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  log(`child exit code=${code} signal=${signal}`)
  process.exit(code ?? 1)
})
