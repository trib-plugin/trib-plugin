#!/usr/bin/env node
import { execSync, exec, spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const home = homedir();
const pluginsData = join(home, '.claude', 'plugins', 'data');

const CONFIG_PATH = join(pluginsData, 'trib-search-trib-plugin', 'config.json');
const PORT = 3456;
const APP_WIDTH = 750;
const APP_HEIGHT = 850;
const html = readFileSync(join(__dirname, 'setup.html'), 'utf8');

// -- Helpers --

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return {}; }
}

function writeJsonFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
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

function httpGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'GET', headers, timeout: 10000,
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => { res.statusCode < 400 ? resolve(JSON.parse(body)) : reject(); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(); });
    req.end();
  });
}

function httpPostJson(url, data, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: u.hostname, path: u.pathname,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => { res.statusCode < 400 ? resolve(JSON.parse(buf)) : reject(); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(); });
    req.write(body);
    req.end();
  });
}

async function validateKey(provider, key) {
  if (!key) return 'empty';
  try {
    switch (provider) {
      case 'serper':
        await httpPostJson('https://google.serper.dev/search', { q: 'test' },
          { 'X-API-KEY': key, 'Content-Type': 'application/json' });
        return 'valid';
      case 'brave':
        await httpGetJson('https://api.search.brave.com/res/v1/web/search?q=test&count=1',
          { 'X-Subscription-Token': key });
        return 'valid';
      case 'xai':
        await httpPostJson('https://api.x.ai/v1/chat/completions',
          { model: 'grok-3-mini-fast', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
          { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' });
        return 'valid';
      case 'perplexity':
        await httpPostJson('https://api.perplexity.ai/chat/completions',
          { model: 'sonar', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
          { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' });
        return 'valid';
      case 'firecrawl':
        await httpGetJson('https://api.firecrawl.dev/v1/crawl',
          { 'Authorization': `Bearer ${key}` });
        return 'valid';
      case 'tavily':
        await httpPostJson('https://api.tavily.com/search',
          { api_key: key, query: 'test', max_results: 1 },
          { 'Content-Type': 'application/json' });
        return 'valid';
      case 'github':
        await httpGetJson('https://api.github.com/user',
          { 'Authorization': `token ${key}`, 'User-Agent': 'trib-setup' });
        return 'valid';
      case 'grok':
        await httpPostJson('https://api.x.ai/v1/chat/completions',
          { model: 'grok-3-mini-fast', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
          { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' });
        return 'valid';
      default: return 'valid';
    }
  } catch { return 'invalid'; }
}

// -- Merge logic --

function mergeConfig(existing, data) {
  const config = { ...existing };

  if (!config.rawSearch) config.rawSearch = {};
  if (!config.rawSearch.credentials) config.rawSearch.credentials = {};

  if (data.searchPriority?.length) {
    config.rawSearch.priority = data.searchPriority;
  }

  for (const [id, key] of Object.entries(data.searchProviders || {})) {
    if (!config.rawSearch.credentials[id]) config.rawSearch.credentials[id] = {};
    config.rawSearch.credentials[id].apiKey = key;
  }

  if (!config.aiSearch) config.aiSearch = {};
  if (!config.aiSearch.profiles) config.aiSearch.profiles = {};

  if (data.aiPriority?.length) {
    // Filter out grok from saved priority
    config.aiSearch.priority = data.aiPriority;
  }

  if (data.aiModels) {
    for (const [id, modelCfg] of Object.entries(data.aiModels)) {
      if (!config.aiSearch.profiles[id]) config.aiSearch.profiles[id] = {};
      const profile = config.aiSearch.profiles[id];
      if (modelCfg.model) profile.model = modelCfg.model;
      if (modelCfg.xSearchEnabled !== undefined) profile.xSearchEnabled = modelCfg.xSearchEnabled;
      if (modelCfg.effort !== undefined) profile.effort = modelCfg.effort;
      if (modelCfg.fastMode !== undefined) profile.fastMode = modelCfg.fastMode;
    }
  }

  if (data.github !== undefined) {
    if (!config.rawSearch.credentials.github) config.rawSearch.credentials.github = {};
    config.rawSearch.credentials.github.token = data.github;
  }

  if (data.mode) config.defaultMode = data.mode;
  if (data.maxResults) config.rawSearch.maxResults = data.maxResults;
  if (data.requestTimeoutMs) config.requestTimeoutMs = data.requestTimeoutMs;
  if (data.aiTimeoutMs) config.aiSearch.timeoutMs = data.aiTimeoutMs;

  if (data.crawl) {
    config.crawl = { ...config.crawl, ...data.crawl };
  }

  // siteRules: preserve existing values (not exposed in UI)
  if (data.siteRules) {
    config.siteRules = data.siteRules;
  }

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
    console.log('  Config saved: search');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/cli-check') {
    const check = (cmd) => {
      try { execSync(`${cmd} --version`, { stdio: 'pipe', timeout: 5000 }); return true; }
      catch { return false; }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      codex: check('codex'),
      claude: check('claude'),
      gemini: check('gemini'),
    }));
    return;
  }

  if (req.method === 'POST' && path === '/validate') {
    const data = await readBody(req);
    const validation = {};
    const checks = [];

    for (const [id, val] of Object.entries(data.searchProviders || {})) {
      const key = typeof val === 'object' ? val.key : val;
      if (key) checks.push(validateKey(id, key).then(r => { validation[id] = r; }));
    }
    for (const [id, val] of Object.entries(data.aiProviders || {})) {
      if (val && val !== 'cli') {
        checks.push(validateKey(id, val).then(r => { validation[id] = r; }));
      }
    }
    if (data.github) {
      checks.push(validateKey('github', data.github).then(r => { validation.github = r; }));
    }

    await Promise.all(checks);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, validation }));
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
  console.log(`\n  TRIB-SEARCH CONFIG`);
  console.log(`  http://localhost:${PORT}\n`);
  if (process.env.TRIB_SETUP_OPEN_ON_START === '1') {
    setTimeout(() => { openAppWindow(); }, 0);
  }
});
