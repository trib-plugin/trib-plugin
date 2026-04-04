'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
const pluginData = process.env.CLAUDE_PLUGIN_DATA;

if (!pluginRoot || !pluginData) process.exit(0);

fs.mkdirSync(pluginData, { recursive: true });

const manifestPath = path.join(pluginRoot, 'package.json');
const lockfilePath = path.join(pluginRoot, 'package-lock.json');
const dataManifestPath = path.join(pluginData, 'package.json');
const dataLockfilePath = path.join(pluginData, 'package-lock.json');
const dataNodeModules = path.join(pluginData, 'node_modules');

function fileContents(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

const manifestMatch = fileContents(manifestPath) === fileContents(dataManifestPath);
const hasModules = fs.existsSync(dataNodeModules);

if (manifestMatch && hasModules) process.exit(0);

// Need install
if (!manifestMatch) {
  fs.rmSync(dataNodeModules, { recursive: true, force: true });
}
fs.copyFileSync(manifestPath, dataManifestPath);

const lockContent = fileContents(lockfilePath);
if (lockContent != null) {
  fs.copyFileSync(lockfilePath, dataLockfilePath);
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = lockContent != null
  ? ['ci', '--omit=dev', '--silent']
  : ['install', '--omit=dev', '--silent'];

const result = spawnSync(npmCmd, args, {
  cwd: pluginData,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  env: process.env,
  timeout: 120000,
});

if (result.status !== 0) {
  process.stderr.write(`deps-sync: npm failed (status ${result.status})\n`);
  process.exit(0);
}

// Build esbuild bundle
const esbuildBin = path.join(dataNodeModules, '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
const serverSrc = path.join(pluginRoot, 'services', 'memory-service.mjs');
const serverJs = path.join(pluginData, 'server.bundle.mjs');

if (fs.existsSync(esbuildBin) && fs.existsSync(serverSrc)) {
  spawnSync(esbuildBin, [
    serverSrc, '--bundle', '--platform=node', '--format=esm',
    `--outfile=${serverJs}`, '--packages=external',
  ], { cwd: pluginRoot, stdio: 'pipe', shell: process.platform === 'win32', timeout: 15000 });
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: 'trib-memory: dependencies installed. Restart Claude Code to connect MCP server.'
  }
}));
