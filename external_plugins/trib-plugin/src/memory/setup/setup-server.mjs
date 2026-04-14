#!/usr/bin/env node
import { exec, spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const home = homedir();
const DATA_DIR = join(home, '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin');
const CONFIG_PATH = join(DATA_DIR, 'memory-config.json');
const FILES_DIR = join(DATA_DIR, 'history');
const DB_PATH = join(DATA_DIR, 'memory.sqlite');
const PORT = 3457;
const APP_WIDTH = 700;
const APP_HEIGHT = 800;
const html = readFileSync(join(__dirname, 'setup.html'), 'utf8');

const NATIVE_MODELS = [
  { id: 'native/opus', label: 'Claude Opus (Native)' },
  { id: 'native/sonnet', label: 'Claude Sonnet (Native)' },
  { id: 'native/haiku', label: 'Claude Haiku (Native)' },
];

const AGENT_DATA_DIR = join(home, '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin');

const STATIC_MODELS = {
  anthropic: [
    'claude-opus-4-6',
    'claude-opus-4-0',
    'claude-sonnet-4-6',
    'claude-sonnet-4-0',
    'claude-haiku-4-5-20251001',
  ],
  gemini: [
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ],
  openai: [
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
  ],
  'openai-oauth': [
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex',
  ],
};

function getAgentConfig() {
  try { return JSON.parse(readFileSync(join(AGENT_DATA_DIR, 'agent-config.json'), 'utf8')); }
  catch { return {}; }
}

async function listProviderModels(providerId) {
  const cfg = readConfig();
  const pcfg = cfg?.providers?.[providerId] || {};

  if (STATIC_MODELS[providerId]) return STATIC_MODELS[providerId];

  // Dynamic listing for OpenAI-compatible endpoints
  const KNOWN_ENDPOINTS = {
    openai: { url: 'https://api.openai.com/v1/models', auth: k => ({ 'Authorization': `Bearer ${k}` }) },
    groq: { url: 'https://api.groq.com/openai/v1/models', auth: k => ({ 'Authorization': `Bearer ${k}` }) },
    openrouter: { url: 'https://openrouter.ai/api/v1/models', auth: k => ({ 'Authorization': `Bearer ${k}` }) },
    xai: { url: 'https://api.x.ai/v1/models', auth: k => ({ 'Authorization': `Bearer ${k}` }) },
  };
  const ep = KNOWN_ENDPOINTS[providerId];
  if (ep && pcfg.apiKey) {
    try {
      const json = await httpGetJson(ep.url, ep.auth(pcfg.apiKey));
      const data = Array.isArray(json?.data) ? json.data : [];
      return data.map(m => m.id || m.name || String(m)).filter(Boolean).sort();
    } catch { return []; }
  }

  // Local providers — query their /v1/models endpoint
  const LOCAL_DEFAULTS = {
    ollama: 'http://localhost:11434/v1/models',
    lmstudio: 'http://localhost:1234/v1/models',
  };
  if (LOCAL_DEFAULTS[providerId]) {
    const baseURL = pcfg.baseURL || LOCAL_DEFAULTS[providerId].replace(/\/models$/, '');
    const url = `${baseURL.replace(/\/$/, '')}/models`;
    try {
      const json = await new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
          hostname: u.hostname, port: u.port, path: u.pathname + u.search,
          method: 'GET', timeout: 3000,
        }, res => {
          let buf = '';
          res.on('data', c => { buf += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(buf)); } catch { reject(); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(); });
        req.end();
      });
      const data = Array.isArray(json?.data) ? json.data : [];
      return data.map(m => m.id || m.name || String(m)).filter(Boolean).sort();
    } catch { return []; }
  }

  return [];
}

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

// -- Presets --

const VALID_TOOLS = new Set(['full', 'readonly', 'mcp']);
const VALID_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

function readPresets() {
  const cfg = readConfig();
  return Array.isArray(cfg.presets) ? cfg.presets : [];
}

function writePresets(list) {
  const cfg = readConfig();
  cfg.presets = list;
  writeConfig(cfg);
}

function normalizePreset(input) {
  if (!input || typeof input !== 'object') throw new Error('preset must be an object');
  const id = String(input.id || '').trim();
  if (!id) throw new Error('preset.id is required');
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('preset.id must be alphanumeric (._- allowed)');
  const provider = String(input.provider || '').trim();
  if (!provider) throw new Error('preset.provider is required');
  const model = String(input.model || '').trim();
  if (!model) throw new Error('preset.model is required');
  const tools = String(input.tools || 'full');
  if (!VALID_TOOLS.has(tools)) throw new Error(`preset.tools must be one of ${[...VALID_TOOLS].join(', ')}`);
  const out = { id, provider, model, tools };
  if (typeof input.name === 'string' && input.name.trim()) out.name = input.name.trim();
  if (input.effort != null && input.effort !== '') {
    const effort = String(input.effort);
    if (!VALID_EFFORTS.has(effort)) throw new Error(`preset.effort must be one of ${[...VALID_EFFORTS].join(', ')}`);
    out.effort = effort;
  }
  if (input.fast === true) out.fast = true;
  return out;
}

// -- Local HTTP helper --

function httpLocalGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        timeout: timeoutMs,
      }, res => {
        let buf = '';
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch { reject(new Error('invalid json')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

// -- Remote HTTPS helpers --

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

function pingLocalHttp(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        timeout: timeoutMs,
      }, res => {
        res.resume();
        resolve(res.statusCode > 0 && res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}

async function validateKey(provider, key) {
  if (!key) return 'empty';
  try {
    switch (provider) {
      case 'openai':
        await httpGetJson('https://api.openai.com/v1/models',
          { 'Authorization': `Bearer ${key}` });
        return 'valid';
      case 'anthropic':
        await httpPostJson('https://api.anthropic.com/v1/messages',
          { model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
          { 'x-api-key': key, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' });
        return 'valid';
      case 'gemini':
        await httpGetJson(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {});
        return 'valid';
      case 'groq':
        await httpGetJson('https://api.groq.com/openai/v1/models',
          { 'Authorization': `Bearer ${key}` });
        return 'valid';
      case 'openrouter':
        await httpGetJson('https://openrouter.ai/api/v1/models',
          { 'Authorization': `Bearer ${key}` });
        return 'valid';
      case 'xai':
        await httpPostJson('https://api.x.ai/v1/chat/completions',
          { model: 'grok-3-mini-fast', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
          { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' });
        return 'valid';
      default: return 'valid';
    }
  } catch { return 'invalid'; }
}

// -- SQLite DB --

function openDb(readonly = false) {
  return new DatabaseSync(DB_PATH, { open: true, readOnly: readonly });
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
    if (incoming.cycle1.preset !== undefined) config.cycle1.preset = incoming.cycle1.preset;
  }

  // cycle2
  if (incoming.cycle2) {
    if (!config.cycle2) config.cycle2 = {};
    if (incoming.cycle2.interval !== undefined) config.cycle2.interval = incoming.cycle2.interval;
    if (incoming.cycle2.preset !== undefined) config.cycle2.preset = incoming.cycle2.preset;
  }

  // user
  if (incoming.user) {
    if (!config.user) config.user = { name: '', title: '' };
    if (incoming.user.name !== undefined) config.user.name = incoming.user.name;
    if (incoming.user.title !== undefined) config.user.title = incoming.user.title;
  }

  // providers
  if (incoming.providers) {
    if (!config.providers) config.providers = {};
    for (const [name, val] of Object.entries(incoming.providers)) {
      if (!config.providers[name]) config.providers[name] = {};
      if (val.apiKey !== undefined) config.providers[name].apiKey = val.apiKey;
      if (val.baseURL !== undefined) config.providers[name].baseURL = val.baseURL;
    }
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
let openGeneration = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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

  // -- Presets CRUD --
  if (req.method === 'GET' && path === '/presets') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ presets: readPresets() }));
    return;
  }

  if (req.method === 'POST' && path === '/presets') {
    const data = await readBody(req);
    let preset;
    try { preset = normalizePreset(data); }
    catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
    const list = readPresets();
    const idx = list.findIndex(p => p.id === preset.id);
    if (idx >= 0) list[idx] = preset;
    else list.push(preset);
    writePresets(list);
    console.log(`  Preset saved: ${preset.id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, preset }));
    return;
  }

  if (req.method === 'DELETE' && path === '/presets') {
    const id = url.searchParams.get('id');
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'id query parameter required' }));
      return;
    }
    const list = readPresets().filter(p => p.id !== id);
    writePresets(list);
    console.log(`  Preset deleted: ${id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'PUT' && path === '/presets') {
    const data = await readBody(req);
    if (!Array.isArray(data.presets)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'presets array required' }));
      return;
    }
    const normalized = data.presets.map(p => normalizePreset(p));
    writePresets(normalized);
    console.log(`  Presets reordered: ${normalized.length} items`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // -- Available providers --
  if (req.method === 'GET' && path === '/providers') {
    const detected = detectProviders();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, providers: detected }));
    return;
  }

  // -- Models list --
  if (req.method === 'GET' && path === '/models-list') {
    const presetList = readPresets();
    const externalModels = presetList.map(p => ({
      id: `${p.provider}/${p.model}`,
      label: `${p.name || p.model} (${p.provider})`,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, models: [...NATIVE_MODELS, ...externalModels] }));
    return;
  }

  // -- Dynamic model listing --
  if (req.method === 'GET' && path === '/models') {
    const provider = url.searchParams.get('provider');
    if (!provider) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'provider query parameter required' }));
      return;
    }
    const models = await listProviderModels(provider);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, provider, models }));
    return;
  }

  // -- Auth detection --
  if (req.method === 'GET' && path === '/auth') {
    const cfg = readConfig();
    const result = {};

    // Codex CLI auth
    const codexAuth = join(home, '.codex', 'auth.json');
    result.codexOAuth = existsSync(codexAuth);

    // Copilot auth
    const configDir = isWin
      ? (process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'))
      : join(home, '.config');
    result.copilot = existsSync(join(configDir, 'github-copilot', 'hosts.json'))
      || existsSync(join(configDir, 'github-copilot', 'apps.json'))
      || !!process.env.GITHUB_TOKEN;

    // Env vars
    result.envKeys = {};
    for (const [name, envKey] of [
      ['openai', 'OPENAI_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY'],
      ['gemini', 'GEMINI_API_KEY'], ['groq', 'GROQ_API_KEY'],
      ['openrouter', 'OPENROUTER_API_KEY'], ['xai', 'XAI_API_KEY'],
    ]) {
      result.envKeys[name] = !!process.env[envKey];
    }

    // Local HTTP server ping (Ollama, LM Studio)
    const ollamaUrl = cfg?.providers?.ollama?.baseURL || 'http://localhost:11434/v1';
    const lmstudioUrl = cfg?.providers?.lmstudio?.baseURL || 'http://localhost:1234/v1';
    const [ollamaUp, lmstudioUp] = await Promise.all([
      pingLocalHttp(ollamaUrl + '/models'),
      pingLocalHttp(lmstudioUrl + '/models'),
    ]);
    result.ollama = ollamaUp;
    result.lmstudio = lmstudioUp;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // -- Validate API keys --
  if (req.method === 'POST' && path === '/validate') {
    const data = await readBody(req);
    const validation = {};
    const checks = [];
    for (const [id, key] of Object.entries(data.keys || {})) {
      if (key) checks.push(validateKey(id, key).then(r => { validation[id] = r; }));
    }
    await Promise.all(checks);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, validation }));
    return;
  }

  // -- Core memory list --
  if (req.method === 'GET' && path === '/core-memory') {
    try {
      const db = openDb(true);
      const rows = db.prepare(`
        SELECT id, topic, element, importance, final_score, status, mention_count, last_seen_at
        FROM core_memory
        ORDER BY
          CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 WHEN 'demoted' THEN 2 WHEN 'archived' THEN 3 ELSE 4 END,
          final_score DESC
      `).all();
      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, items: rows }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // -- Core memory status update --
  if (req.method === 'POST' && path === '/core-memory/status') {
    const data = await readBody(req);
    const { id, status } = data;
    const VALID = ['active', 'pending', 'demoted', 'archived'];
    if (!id || !VALID.includes(status)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'id and valid status required' }));
      return;
    }
    try {
      const db = openDb();
      db.prepare('UPDATE core_memory SET status = ? WHERE id = ?').run(status, id);
      db.close();
      console.log(`  Core memory #${id} → ${status}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // -- Backfill --
  if (req.method === 'POST' && path === '/backfill') {
    const data = await readBody(req);
    const window = data.window || '7d';
    const backfillPath = join(DATA_DIR, 'backfill-request.json');
    writeJsonFile(backfillPath, { window, requestedAt: Date.now() });
    console.log(`  Backfill requested: ${window}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/files') {
    const result = {};
    for (const name of ['bot.md', 'user.md']) {
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
    for (const name of ['bot.md', 'user.md']) {
      if (data[name] != null) {
        writeFileSync(join(FILES_DIR, name), data[name], 'utf8');
      }
    }
    console.log('  Files saved: bot.md, user.md');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === '/close') {
    res.writeHead(200);
    res.end();
    console.log('  Window closed');
    return;
  }

  if (path === '/open') {
    openGeneration++;
    openAppWindow();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, generation: openGeneration }));
    return;
  }

  if (req.method === 'GET' && path === '/generation') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ generation: openGeneration }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  TRIB-MEMORY CONFIG`);
  console.log(`  http://localhost:${PORT}\n`);
  if (process.env.TRIB_SETUP_OPEN_ON_START === '1') {
    openGeneration++;
    setTimeout(() => { openAppWindow(); }, 0);
  }
});
