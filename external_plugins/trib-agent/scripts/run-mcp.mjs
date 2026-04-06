#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'fs'
import { copyFile, access } from 'fs/promises'
import { constants } from 'fs'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
const pluginData = process.env.CLAUDE_PLUGIN_DATA

if (!pluginRoot || !pluginData) {
  process.stderr.write('run-mcp: CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA are required\n')
  process.exit(1)
}

const dataNodeModules = join(pluginData, 'node_modules')
const esbuildBin = join(dataNodeModules, '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
const logPath = join(pluginData, 'run-mcp.log')
const bundlePath = join(pluginData, 'server.bundle.mjs')

function log(message) {
  writeFileSync(logPath, `[${new Date().toLocaleString('sv-SE', { hour12: false })}] ${message}\n`, { flag: 'a' })
}

function fileContents(path) {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

async function isExecutable(path) {
  try { await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true } catch { return false }
}

async function syncDependenciesIfNeeded() {
  mkdirSync(pluginData, { recursive: true })
  log(`invoked root=${pluginRoot} data=${pluginData}`)

  const manifestPath = join(pluginRoot, 'package.json')
  const lockfilePath = join(pluginRoot, 'package-lock.json')
  const dataManifestPath = join(pluginData, 'package.json')
  const dataLockfilePath = join(pluginData, 'package-lock.json')

  let needsInstall = false
  if (fileContents(manifestPath) !== fileContents(dataManifestPath)) needsInstall = true
  if (!(await isExecutable(esbuildBin))) needsInstall = true

  if (!needsInstall) return

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

// Build bundle if needed
const serverSrc = join(pluginRoot, 'server.mjs')
if (!existsSync(bundlePath) || statSync(serverSrc).mtimeMs > statSync(bundlePath).mtimeMs) {
  if (await isExecutable(esbuildBin)) {
    log('building server bundle...')
    spawnSync(esbuildBin, [serverSrc, '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`, '--packages=external'], { cwd: pluginRoot, stdio: 'pipe', shell: process.platform === 'win32', timeout: 15000 })
    log('bundle built successfully')
  }
}

// Run server
const serverFile = existsSync(bundlePath) ? bundlePath : serverSrc
log(`exec node ${serverFile} (${existsSync(bundlePath) ? 'bundled' : 'source'})`)

const child = spawn(process.execPath, [serverFile], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: { ...process.env, NODE_PATH: join(dataNodeModules) },
})

child.on('exit', (code, signal) => {
  log(`child exit code=${code} signal=${signal}`)
  process.exit(code ?? 1)
})
