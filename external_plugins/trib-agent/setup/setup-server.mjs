#!/usr/bin/env node
import { execSync, exec } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const home = homedir();

// Use plugin data dir if available, otherwise ~/.config
const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA
  || join(home, '.config', 'trib-orchestrator');
const CONFIG_PATH = join(pluginDataDir, 'config.json');
const PORT = 3459;
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

// Lightweight HTTP ping for local servers (Ollama, LM Studio, etc.)
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
        // 2xx/3xx/4xx all indicate "server is alive"; only network errors mean "not running"
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

// -- Detect existing auth --

async function detectAuth(config = {}) {
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
  const ollamaUrl = config?.providers?.ollama?.baseURL || 'http://localhost:11434/v1';
  const lmstudioUrl = config?.providers?.lmstudio?.baseURL || 'http://localhost:1234/v1';
  const [ollamaUp, lmstudioUp] = await Promise.all([
    pingLocalHttp(ollamaUrl + '/models'),
    pingLocalHttp(lmstudioUrl + '/models'),
  ]);
  result.ollama = ollamaUp;
  result.lmstudio = lmstudioUp;
  return result;
}

// -- Merge --

function mergeConfig(existing, data) {
  const config = { ...existing };
  if (!config.providers) config.providers = {};

  // API keys
  if (data.providers) {
    for (const [name, val] of Object.entries(data.providers)) {
      if (!config.providers[name]) config.providers[name] = {};
      if (val.apiKey !== undefined) config.providers[name].apiKey = val.apiKey;
      if (val.enabled !== undefined) config.providers[name].enabled = val.enabled;
      if (val.baseURL !== undefined) config.providers[name].baseURL = val.baseURL;
    }
  }

  return config;
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
  // Strip the legacy defaultPreset field once any preset write happens.
  if ('defaultPreset' in cfg) delete cfg.defaultPreset;
  // Auto-assign default if missing or stale
  const validKeys = list.map(p => p.id || p.name).filter(Boolean);
  if (!cfg.default || !validKeys.includes(cfg.default)) {
    cfg.default = validKeys[0] || null;
  }
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

// -- Provider model listing (used by /models?provider=...) --

async function listProviderModels(providerId, cfg) {
  const pcfg = cfg?.providers?.[providerId] || {};
  // Static catalogs for providers without a list endpoint or to keep latency low.
  const STATIC = {
    anthropic: [
      'claude-opus-4-6',
      'claude-opus-4-0',
      'claude-sonnet-4-6',
      'claude-sonnet-4-0',
      'claude-haiku-4-5-20251001',
    ],
    gemini: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
    ],
    'openai-oauth': [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.2-codex',
    ],
  };
  if (STATIC[providerId]) return STATIC[providerId];

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

// -- Body reader --

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
    const auth = await detectAuth(config);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ config, auth }));
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

  // -- Dynamic model listing --
  if (req.method === 'GET' && path === '/models') {
    const provider = url.searchParams.get('provider');
    if (!provider) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'provider query parameter required' }));
      return;
    }
    const cfg = readConfig();
    const models = await listProviderModels(provider, cfg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, provider, models }));
    return;
  }

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

  if (path === '/close') {
    res.writeHead(200); res.end();
    console.log('  Setup closed');
    setTimeout(() => { server.close(); process.exit(0); }, 500);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const idleCheck = setInterval(() => {
  if (Date.now() - lastActivity > 5 * 60 * 1000) {
    console.log('  Setup timed out');
    clearInterval(idleCheck);
    server.close();
    process.exit(0);
  }
}, 10000);

server.listen(PORT, () => {
  console.log(`\n  TRIB-AGENT CONFIG`);
  console.log(`  http://localhost:${PORT}\n`);

  const appUrl = `http://localhost:${PORT}`;
  if (isWin) {
    const paths = [
      process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env['PROGRAMFILES'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
      process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    const browser = paths.find(p => existsSync(p));
    if (browser) exec(`"${browser}" --app=${appUrl} --window-size=700,800 --new-window`);
    else exec(`start ${appUrl}`);
  } else if (process.platform === 'darwin') {
    exec(`open ${appUrl}`);
  } else {
    exec(`xdg-open ${appUrl}`);
  }
});
