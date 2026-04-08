#!/usr/bin/env node
import { exec, spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const home = homedir();
const DATA_DIR = join(home, '.claude', 'plugins', 'data', 'trib-memory-trib-plugin');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const FILES_DIR = join(DATA_DIR, 'history');
const PORT = 3457;
const APP_WIDTH = 700;
const APP_HEIGHT = 800;
const html = readFileSync(join(__dirname, 'setup.html'), 'utf8');

// -- Helpers --

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return {}; }
}

function writeJsonFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

function readConfig() { return readJsonFile(CONFIG_PATH); }
function writeConfig(data) { writeJsonFile(CONFIG_PATH, data); }

function getBrowserPath() {
  const paths = [
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return paths.find(p => existsSync(p)) || null;
}

function getCenteredWindowPosition() {
  if (!isWin) return null;
  const script = [
    "[void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')",
    "$a=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea",
    'Write-Output "$($a.X),$($a.Y),$($a.Width),$($a.Height)"',
  ].join(';');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    const [x, y, width, height] = (result.stdout || '').trim().split(',').map(Number);
    if ([x, y, width, height].some(Number.isNaN)) return null;
    return {
      x: Math.max(0, Math.round(x + ((width - APP_WIDTH) / 2))),
      y: Math.max(0, Math.round(y + ((height - APP_HEIGHT) / 2))),
    };
  } catch {
    return null;
  }
}

function openAppWindow() {
  const appUrl = `http://localhost:${PORT}`;

  if (isWin) {
    const browser = getBrowserPath();
    if (browser) {
      const args = [
        `--app=${appUrl}`,
        `--window-size=${APP_WIDTH},${APP_HEIGHT}`,
      ];
      const position = getCenteredWindowPosition();
      if (position) args.push(`--window-position=${position.x},${position.y}`);
      try {
        const child = spawn(browser, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
        return true;
      } catch {}
    }
    exec(`cmd.exe /c start "" "${appUrl}"`, { windowsHide: true });
    return true;
  }

  if (process.platform === 'darwin') {
    exec(`open "${appUrl}"`);
    return true;
  }

  exec(`xdg-open "${appUrl}"`);
  return true;
}

// -- Merge logic --

function mergeConfig(existing, incoming) {
  const config = { ...existing };

  // enabled
  if (incoming.enabled !== undefined) config.enabled = incoming.enabled;

  // cycle1
  if (incoming.cycle1) {
    if (!config.cycle1) config.cycle1 = {};
    if (incoming.cycle1.interval !== undefined) config.cycle1.interval = incoming.cycle1.interval;
    if (incoming.cycle1.timeout !== undefined) config.cycle1.timeout = incoming.cycle1.timeout;
    if (incoming.cycle1.batchSize !== undefined) config.cycle1.batchSize = incoming.cycle1.batchSize;
  }

  // backfill
  if (incoming.backfill) {
    if (!config.backfill) config.backfill = {};
    if (incoming.backfill.window !== undefined) config.backfill.window = incoming.backfill.window;
  }

  // cycle2
  if (incoming.cycle2) {
    if (!config.cycle2) config.cycle2 = {};
    if (incoming.cycle2.schedule !== undefined) config.cycle2.schedule = incoming.cycle2.schedule;
  }

  // user
  if (incoming.user) {
    if (!config.user) config.user = { name: '', title: '' };
    if (incoming.user.name !== undefined) config.user.name = incoming.user.name;
    if (incoming.user.title !== undefined) config.user.title = incoming.user.title;
  }

  // models — replace entirely when incoming (UI sends a complete object)
  if (incoming.models) {
    config.models = { ...incoming.models };
  }

  // embedding and reranker are readonly in the UI — never overwrite from incoming

  return config;
}

// -- HTTP body reader --
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// -- Server --
let lastActivity = Date.now();

const server = http.createServer(async (req, res) => {
  lastActivity = Date.now();
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && path === '/config') {
    const config = readConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (req.method === 'POST' && path === '/config') {
    const data = await readBody(req);
    const existing = readConfig();
    const merged = mergeConfig(existing, data);
    writeConfig(merged);
    console.log('  Config saved');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/files') {
    const result = {};
    for (const name of ['bot.md', 'user.md', 'context.md']) {
      try { result[name] = readFileSync(join(FILES_DIR, name), 'utf8'); }
      catch { result[name] = ''; }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'POST' && path === '/files') {
    const data = await readBody(req);
    mkdirSync(FILES_DIR, { recursive: true });
    for (const name of ['bot.md', 'user.md', 'context.md']) {
      if (data[name] != null) {
        writeFileSync(join(FILES_DIR, name), data[name], 'utf8');
      }
    }
    console.log('  Files saved: bot.md, user.md, context.md');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === '/close') {
    res.writeHead(200);
    res.end();
    console.log('  Setup closed');
    setTimeout(() => { server.close(); process.exit(0); }, 500);
    return;
  }

  if (path === '/open') {
    openAppWindow();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const idleCheck = setInterval(() => {
  if (Date.now() - lastActivity > 5 * 60 * 1000) {
    console.log('  Setup timed out (no activity)');
    clearInterval(idleCheck);
    server.close();
    process.exit(0);
  }
}, 10000);

server.listen(PORT, () => {
  console.log(`\n  TRIB-MEMORY CONFIG`);
  console.log(`  http://localhost:${PORT}\n`);
  if (process.env.TRIB_SETUP_OPEN_ON_START === '1') {
    setTimeout(() => { openAppWindow(); }, 0);
  }
});
