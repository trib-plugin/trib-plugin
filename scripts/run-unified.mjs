#!/usr/bin/env node

/**
 * run-unified.mjs — Unified trib-plugin launcher.
 * Syncs deps from all 4 sub-plugins, builds unified server, runs it.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, copyFileSync } from 'fs'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
const pluginData = process.env.CLAUDE_PLUGIN_DATA

if (!pluginRoot) { process.stderr.write('run-unified: CLAUDE_PLUGIN_ROOT required\n'); process.exit(1) }
if (!pluginData) { process.stderr.write('run-unified: CLAUDE_PLUGIN_DATA required\n'); process.exit(1) }

const isWin = process.platform === 'win32'
const npm = isWin ? 'npm.cmd' : 'npm'

// ── Merge package.json from all sub-plugins ──────────────────────────

function mergedDeps() {
  const subPlugins = ['trib-channels', 'trib-memory', 'trib-search', 'trib-agent']
  const deps = {}
  const devDeps = {}
  for (const name of subPlugins) {
    const pkgPath = join(pluginRoot, 'external_plugins', name, 'package.json')
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      Object.assign(deps, pkg.dependencies || {})
      Object.assign(devDeps, pkg.devDependencies || {})
    } catch { /* skip if missing */ }
  }
  return {
    name: 'trib-plugin-unified',
    version: '1.0.0',
    type: 'module',
    dependencies: deps,
    devDependencies: devDeps,
  }
}

// ── Sync dependencies ────────────────────────────────────────────────

mkdirSync(pluginData, { recursive: true })

const dataManifestPath = join(pluginData, 'package.json')
const dataNodeModules = join(pluginData, 'node_modules')
const merged = mergedDeps()
const mergedJson = JSON.stringify(merged, null, 2)

let needsInstall = false
try {
  const existing = readFileSync(dataManifestPath, 'utf8')
  if (existing !== mergedJson) needsInstall = true
} catch {
  needsInstall = true
}

const esbuildBin = join(dataNodeModules, '.bin', isWin ? 'esbuild.cmd' : 'esbuild')
if (!existsSync(esbuildBin)) needsInstall = true

if (needsInstall) {
  process.stderr.write('[run-unified] installing merged dependencies...\n')
  writeFileSync(dataManifestPath, mergedJson)
  const result = spawnSync(npm, ['install', '--omit=dev', '--silent'], {
    cwd: pluginData, stdio: ['ignore', 'pipe', 'inherit'],
    shell: isWin, env: process.env, timeout: 300000,
  })
  if (result.status !== 0) {
    process.stderr.write('[run-unified] npm install failed\n')
    process.exit(result.status ?? 1)
  }
  process.stderr.write('[run-unified] dependencies installed\n')
}

// ── Build unified server ─────────────────────────────────────────────

const serverTs = join(pluginRoot, 'server.ts')
const serverBundle = join(pluginData, 'unified-server.bundle.mjs')

function buildBundle() {
  try {
    const srcStat = statSync(serverTs)
    try {
      const bundleStat = statSync(serverBundle)
      if (bundleStat.mtimeMs >= srcStat.mtimeMs) return true
    } catch { /* needs build */ }

    const result = spawnSync(esbuildBin, [
      serverTs, '--bundle', '--platform=node', '--format=esm',
      `--outfile=${serverBundle}`, '--packages=external',
    ], { cwd: pluginRoot, stdio: 'pipe', shell: isWin, timeout: 30000 })

    if (result.status === 0) {
      process.stderr.write('[run-unified] bundle built\n')
      return true
    }
    process.stderr.write(`[run-unified] bundle build failed: ${result.stderr?.toString().slice(0, 300)}\n`)
    return false
  } catch (e) {
    process.stderr.write(`[run-unified] bundle build error: ${e.message}\n`)
    return false
  }
}

let serverFile
if (buildBundle()) {
  serverFile = serverBundle
} else {
  // tsx fallback
  const tsxBin = join(dataNodeModules, '.bin', isWin ? 'tsx.cmd' : 'tsx')
  serverFile = null
  process.stderr.write('[run-unified] falling back to tsx\n')
}

// ── Spawn server process ─────────────────────────────────────────────

const spawnEnv = {
  ...process.env,
  TRIB_UNIFIED: '1',
  NODE_PATH: process.env.NODE_PATH
    ? `${dataNodeModules}${isWin ? ';' : ':'}${process.env.NODE_PATH}`
    : dataNodeModules,
}

const child = serverFile
  ? spawn('node', ['--no-warnings', serverFile], { cwd: pluginRoot, stdio: 'inherit', env: spawnEnv })
  : (() => {
      const tsxCliPath = join(dataNodeModules, 'tsx', 'dist', 'cli.mjs')
      return spawn('node', [tsxCliPath, serverTs], { cwd: pluginRoot, stdio: 'inherit', env: spawnEnv })
    })()

// ── Signal relay ─────────────────────────────────────────────────────

let shuttingDown = false
function relayShutdown(signal = 'SIGTERM') {
  if (shuttingDown) return
  shuttingDown = true
  try { child.kill(signal) } catch { process.exit(0) }
  setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 3000).unref()
}

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => { process.stderr.write(`[run-unified] spawn failed: ${err}\n`); process.exit(1) })
process.on('SIGTERM', () => relayShutdown('SIGTERM'))
process.on('SIGINT', () => relayShutdown(isWin ? 'SIGTERM' : 'SIGINT'))
if (!isWin) process.on('SIGHUP', () => relayShutdown('SIGTERM'))
process.on('disconnect', () => relayShutdown('SIGTERM'))
