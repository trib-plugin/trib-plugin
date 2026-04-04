#!/usr/bin/env node

import { execSync, spawnSync } from 'child_process'
import { mkdirSync, readFileSync, existsSync, copyFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const home = homedir()
const pluginsDir = join(home, '.claude', 'plugins')
const isWin = process.platform === 'win32'
const npm = isWin ? 'npm.cmd' : 'npm'

const plugins = ['trib-channels', 'trib-memory', 'trib-search']

// 1. Install plugins
console.log('[trib-plugin] Installing plugins...')
for (const name of plugins) {
  try {
    execSync(`claude plugins install ${name}@trib-plugin`, { stdio: 'pipe' })
    console.log(`  ✓ ${name}`)
  } catch {
    console.log(`  ✓ ${name} (already installed)`)
  }
}

// 2. Install deps + build bundles
console.log('[trib-plugin] Installing dependencies...')
for (const name of plugins) {
  const dataDir = join(pluginsDir, 'data', `${name}-trib-plugin`)
  const cacheDir = join(pluginsDir, 'cache', 'trib-plugin', name, '0.0.1')
  const marketDir = join(pluginsDir, 'marketplaces', 'trib-plugin', 'external_plugins', name)
  const pluginRoot = existsSync(cacheDir) ? cacheDir : marketDir

  mkdirSync(dataDir, { recursive: true })

  // Copy package.json + lockfile
  copyFileSync(join(pluginRoot, 'package.json'), join(dataDir, 'package.json'))
  try { copyFileSync(join(pluginRoot, 'package-lock.json'), join(dataDir, 'package-lock.json')) } catch {}

  // npm ci
  const r = spawnSync(npm, ['ci', '--omit=dev', '--silent'], {
    cwd: dataDir, stdio: 'pipe', shell: isWin, timeout: 120000,
  })
  if (r.status !== 0) {
    spawnSync(npm, ['install', '--omit=dev', '--silent'], {
      cwd: dataDir, stdio: 'pipe', shell: isWin, timeout: 120000,
    })
  }
  console.log(`  ✓ ${name} deps`)

  // esbuild bundle
  const esbuild = join(dataDir, 'node_modules', '.bin', isWin ? 'esbuild.cmd' : 'esbuild')
  const entryMap = {
    'trib-channels': join(pluginRoot, 'server.ts'),
    'trib-memory': join(pluginRoot, 'services', 'memory-service.mjs'),
    'trib-search': join(pluginRoot, 'server.mjs'),
  }
  const entry = entryMap[name]
  const bundle = join(dataDir, 'server.bundle.mjs')

  if (existsSync(esbuild) && existsSync(entry)) {
    spawnSync(esbuild, [
      entry, '--bundle', '--platform=node', '--format=esm',
      `--outfile=${bundle}`, '--packages=external',
    ], { cwd: pluginRoot, stdio: 'pipe', shell: isWin, timeout: 15000 })
    console.log(`  ✓ ${name} bundle`)
  }
}

console.log('[trib-plugin] Done! Restart Claude Code to connect.')
