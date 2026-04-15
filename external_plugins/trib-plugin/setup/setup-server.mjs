#!/usr/bin/env node
import { exec, execSync, spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
import { DEFAULT_MAINTENANCE } from '../src/agent/orchestrator/config.mjs';
import { syncRootEmbedding, runCycle1, runCycle2 } from '../src/memory/lib/memory-cycle.mjs';
import { runFullBackfill } from '../src/memory/lib/memory-ops-policy.mjs';
import { cleanMemoryText } from '../src/memory/lib/memory.mjs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const home = homedir();
const pluginsData = join(home, '.claude', 'plugins', 'data');

// -- Channels paths --
const DATA_DIR = join(pluginsData, 'trib-plugin-trib-plugin');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const BOT_PATH = join(DATA_DIR, 'bot.json');

// -- Agent paths (same data dir after unification) --
const AGENT_DATA_DIR = DATA_DIR;
const AGENT_CONFIG_PATH = join(AGENT_DATA_DIR, 'agent-config.json');

// -- Workflow paths --
const USER_WORKFLOW_PATH = join(DATA_DIR, 'user-workflow.json');
const USER_WORKFLOW_MD_PATH = join(DATA_DIR, 'user-workflow.md');

const DEFAULT_USER_WORKFLOW = {
  roles: []
};

const DEFAULT_USER_WORKFLOW_MD = "";

// -- Memory paths --
const MEMORY_DATA_DIR = DATA_DIR;
const MEMORY_CONFIG_PATH = join(MEMORY_DATA_DIR, 'memory-config.json');
const MEMORY_FILES_DIR = join(MEMORY_DATA_DIR, 'history');
const MEMORY_DB_PATH = join(MEMORY_DATA_DIR, 'memory.sqlite');

// -- Search paths --
const SEARCH_DATA_DIR = DATA_DIR;
const SEARCH_CONFIG_PATH = join(SEARCH_DATA_DIR, 'search-config.json');

// -- Unified config sync --
const TRIB_CONFIG_PATH = join(DATA_DIR, 'trib-config.json');
const SECTION_FILES = { channels: CONFIG_PATH, agent: AGENT_CONFIG_PATH, memory: MEMORY_CONFIG_PATH, search: SEARCH_CONFIG_PATH };

function syncToTribConfig() {
  try {
    const merged = {};
    const SECTION_NAMES = { channels: 'config.json', agent: 'agent-config.json', memory: 'memory-config.json', search: 'search-config.json' };
    for (const [section, filePath] of Object.entries(SECTION_FILES)) {
      try { merged[section] = JSON.parse(readFileSync(filePath, 'utf8')); } catch {}
    }
    writeJsonFile(TRIB_CONFIG_PATH, merged);
  } catch {}
}

const PORT = 3458;
const APP_WIDTH = 950;
const APP_HEIGHT = 900;
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
function writeConfig(data) { writeJsonFile(CONFIG_PATH, data); syncToTribConfig(); }

function readAgentConfig() { return readJsonFile(AGENT_CONFIG_PATH); }
function writeAgentConfig(data) { writeJsonFile(AGENT_CONFIG_PATH, data); syncToTribConfig(); }

function readMemoryConfig() { return readJsonFile(MEMORY_CONFIG_PATH); }
function writeMemoryConfig(data) { writeJsonFile(MEMORY_CONFIG_PATH, data); syncToTribConfig(); }

function readSearchConfig() { return readJsonFile(SEARCH_CONFIG_PATH); }
function writeSearchConfig(data) { writeJsonFile(SEARCH_CONFIG_PATH, data); syncToTribConfig(); }

function readUserWorkflow() {
  if (!existsSync(USER_WORKFLOW_PATH)) return DEFAULT_USER_WORKFLOW;
  try { return JSON.parse(readFileSync(USER_WORKFLOW_PATH, 'utf8')); }
  catch { return DEFAULT_USER_WORKFLOW; }
}
function writeUserWorkflow(data) { writeJsonFile(USER_WORKFLOW_PATH, data); }

function readUserWorkflowMd() {
  if (!existsSync(USER_WORKFLOW_MD_PATH)) return DEFAULT_USER_WORKFLOW_MD;
  try { return readFileSync(USER_WORKFLOW_MD_PATH, 'utf8'); }
  catch { return DEFAULT_USER_WORKFLOW_MD; }
}
function writeUserWorkflowMd(content) {
  mkdirSync(dirname(USER_WORKFLOW_MD_PATH), { recursive: true });
  const tmp = USER_WORKFLOW_MD_PATH + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, USER_WORKFLOW_MD_PATH);
}

// -- HTTPS helpers --

function httpGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
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
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
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

function pingLocalHttp(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = http.request({
        hostname: u.hostname, port: u.port,
        path: u.pathname + u.search,
        method: 'GET', timeout: timeoutMs,
      }, res => { res.resume(); resolve(res.statusCode > 0 && res.statusCode < 500); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}

// -- Agent key validation --

async function validateAgentKey(provider, key) {
  if (!key) return 'empty';
  try {
    switch (provider) {
      case 'openai':
        await httpGetJson('https://api.openai.com/v1/models', { 'Authorization': `Bearer ${key}` });
        return 'valid';
      case 'anthropic':
        await httpPostJson('https://api.anthropic.com/v1/messages',
          { model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
          { 'x-api-key': key, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' });
        return 'valid';
      case 'gemini':
        await httpGetJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {});
        return 'valid';
      case 'groq':
        await httpGetJson('https://api.groq.com/openai/v1/models', { 'Authorization': `Bearer ${key}` });
        return 'valid';
      case 'openrouter':
        await httpGetJson('https://openrouter.ai/api/v1/models', { 'Authorization': `Bearer ${key}` });
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

// -- Search key validation --

async function validateSearchKey(provider, key) {
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
        await httpGetJson('https://api.firecrawl.dev/v1/crawl', { 'Authorization': `Bearer ${key}` });
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
      default: return 'valid';
    }
  } catch { return 'invalid'; }
}

// -- Auth detection (shared by agent & memory) --

async function detectAuth(config = {}) {
  const result = {};
  const codexAuth = join(home, '.codex', 'auth.json');
  result.codexOAuth = existsSync(codexAuth);
  const configDir = isWin
    ? (process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'))
    : join(home, '.config');
  result.copilot = existsSync(join(configDir, 'github-copilot', 'hosts.json'))
    || existsSync(join(configDir, 'github-copilot', 'apps.json'))
    || !!process.env.GITHUB_TOKEN;
  result.envKeys = {};
  for (const [name, envKey] of [
    ['openai', 'OPENAI_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY'],
    ['gemini', 'GEMINI_API_KEY'], ['groq', 'GROQ_API_KEY'],
    ['openrouter', 'OPENROUTER_API_KEY'], ['xai', 'XAI_API_KEY'],
  ]) { result.envKeys[name] = !!process.env[envKey]; }
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

// -- Provider model listing --

const STATIC_MODELS = {
  anthropic: ['claude-opus-4-6','claude-opus-4-0','claude-sonnet-4-6','claude-sonnet-4-0','claude-haiku-4-5-20251001'],
  gemini: ['gemini-3.1-pro-preview','gemini-3-flash-preview','gemini-3.1-flash-lite-preview','gemini-2.5-pro','gemini-2.5-flash'],
  openai: ['gpt-5.4','gpt-5.4-mini','gpt-5.4-nano'],
  'openai-oauth': ['gpt-5.4','gpt-5.4-mini','gpt-5.3-codex'],
};

async function listProviderModels(providerId, cfg) {
  const pcfg = cfg?.providers?.[providerId] || {};
  if (STATIC_MODELS[providerId]) return STATIC_MODELS[providerId];

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

  const LOCAL_DEFAULTS = { ollama: 'http://localhost:11434/v1/models', lmstudio: 'http://localhost:1234/v1/models' };
  if (LOCAL_DEFAULTS[providerId]) {
    const baseURL = pcfg.baseURL || LOCAL_DEFAULTS[providerId].replace(/\/models$/, '');
    const url = `${baseURL.replace(/\/$/, '')}/models`;
    try {
      const json = await httpGetJson(url, {});
      const data = Array.isArray(json?.data) ? json.data : [];
      return data.map(m => m.id || m.name || String(m)).filter(Boolean).sort();
    } catch { return []; }
  }
  return [];
}

// -- Presets (shared logic for agent & memory) --

const VALID_TOOLS = new Set(['full', 'readonly', 'mcp']);
const VALID_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

function normalizePreset(input) {
  if (!input || typeof input !== 'object') throw new Error('preset must be an object');
  const id = String(input.id || '').trim();
  if (!id) throw new Error('preset.id is required');
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('preset.id must be alphanumeric (._- allowed)');
  const type = (input.type === 'native') ? 'native' : 'bridge';
  const model = String(input.model || '').trim();
  if (!model) throw new Error('preset.model is required');
  const out = { id, type, model };
  if (type === 'bridge') {
    const provider = String(input.provider || '').trim();
    if (!provider) throw new Error('preset.provider is required for bridge presets');
    out.provider = provider;
    const tools = String(input.tools || 'full');
    if (!VALID_TOOLS.has(tools)) throw new Error(`preset.tools must be one of ${[...VALID_TOOLS].join(', ')}`);
    out.tools = tools;
  }
  if (typeof input.name === 'string' && input.name.trim()) out.name = input.name.trim();
  if (input.effort != null && input.effort !== '') {
    const effort = String(input.effort);
    if (!VALID_EFFORTS.has(effort)) throw new Error(`preset.effort must be one of ${[...VALID_EFFORTS].join(', ')}`);
    out.effort = effort;
  }
  if (input.fast === true) out.fast = true;
  return out;
}

function readAgentPresets() {
  const cfg = readAgentConfig();
  return Array.isArray(cfg.presets) ? cfg.presets : [];
}

function writeAgentPresets(list) {
  const cfg = readAgentConfig();
  cfg.presets = list;
  if ('defaultPreset' in cfg) delete cfg.defaultPreset;
  const validKeys = list.map(p => p.id || p.name).filter(Boolean);
  if (!cfg.default || !validKeys.includes(cfg.default)) cfg.default = validKeys[0] || null;
  writeAgentConfig(cfg);
}

function readMemoryPresets() {
  const cfg = readMemoryConfig();
  return Array.isArray(cfg.presets) ? cfg.presets : [];
}

function writeMemoryPresets(list) {
  const cfg = readMemoryConfig();
  cfg.presets = list;
  writeMemoryConfig(cfg);
}

// -- Agent merge --

function mergeAgentConfig(existing, data) {
  const config = { ...existing };
  if (!config.providers) config.providers = {};
  if (data.providers) {
    for (const [name, val] of Object.entries(data.providers)) {
      if (!val || typeof val !== 'object') continue;
      if (!config.providers[name]) config.providers[name] = {};
      // Preserve any per-provider subkey from the setup payload so future
      // schema additions round-trip through the UI without being dropped.
      for (const [k, v] of Object.entries(val)) {
        if (v === undefined) continue;
        config.providers[name][k] = v;
      }
    }
  }
  if (data.bridge && typeof data.bridge === 'object') {
    config.bridge = { ...(config.bridge || {}), ...data.bridge };
  }
  return config;
}

// -- Memory merge --

function mergeMemoryConfig(existing, incoming) {
  const config = { ...existing };
  if (incoming.enabled !== undefined) config.enabled = incoming.enabled;
  if (incoming.cycle1) {
    if (!config.cycle1) config.cycle1 = {};
    if (incoming.cycle1.interval !== undefined) config.cycle1.interval = incoming.cycle1.interval;
    if (incoming.cycle1.timeout !== undefined) config.cycle1.timeout = incoming.cycle1.timeout;
    if (incoming.cycle1.batchSize !== undefined) config.cycle1.batchSize = incoming.cycle1.batchSize;
  }
  if (incoming.cycle2) {
    if (!config.cycle2) config.cycle2 = {};
    if (incoming.cycle2.interval !== undefined) config.cycle2.interval = incoming.cycle2.interval;
  }
  if (incoming.user) {
    if (!config.user) config.user = { name: '', title: '' };
    if (incoming.user.name !== undefined) config.user.name = incoming.user.name;
    if (incoming.user.title !== undefined) config.user.title = incoming.user.title;
  }
  if (incoming.providers) {
    if (!config.providers) config.providers = {};
    for (const [name, val] of Object.entries(incoming.providers)) {
      if (!config.providers[name]) config.providers[name] = {};
      if (val.apiKey !== undefined) config.providers[name].apiKey = val.apiKey;
      if (val.baseURL !== undefined) config.providers[name].baseURL = val.baseURL;
    }
  }
  return config;
}

// -- Search merge --

function mergeSearchConfig(existing, data) {
  const config = { ...existing };
  if (!config.rawSearch) config.rawSearch = {};
  if (!config.rawSearch.credentials) config.rawSearch.credentials = {};
  if (data.searchPriority?.length) config.rawSearch.priority = data.searchPriority;
  for (const [id, key] of Object.entries(data.searchProviders || {})) {
    if (!config.rawSearch.credentials[id]) config.rawSearch.credentials[id] = {};
    config.rawSearch.credentials[id].apiKey = key;
  }
  if (data.github !== undefined) {
    if (!config.rawSearch.credentials.github) config.rawSearch.credentials.github = {};
    config.rawSearch.credentials.github.token = data.github;
  }
  if (data.mode) config.defaultMode = data.mode;
  if (data.maxResults) config.rawSearch.maxResults = data.maxResults;
  if (data.requestTimeoutMs) config.requestTimeoutMs = data.requestTimeoutMs;
  if (data.crawl) config.crawl = { ...config.crawl, ...data.crawl };
  if (data.siteRules) config.siteRules = data.siteRules;
  return config;
}

// -- Memory SQLite --

function openMemoryDb(readonly = false) {
  if (!DatabaseSync) throw new Error('node:sqlite not available');
  return new DatabaseSync(MEMORY_DB_PATH, { open: true, readOnly: readonly });
}

// -- Memory backfill (UI trigger) --

let _backfillInProgress = false;

function ingestTranscriptForBackfill(db, transcriptPath) {
  if (!existsSync(transcriptPath)) return 0;
  let content;
  try { content = readFileSync(transcriptPath, 'utf8'); } catch { return 0; }
  const parts = transcriptPath.split(/[\\/]/);
  const sessionUuid = (parts[parts.length - 1] || '').replace(/\.jsonl$/, '');
  const lines = content.split('\n').filter(Boolean);
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO entries(ts, role, content, source_ref, session_id) VALUES (?, ?, ?, ?, ?)`
  );
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    let parsed;
    try { parsed = JSON.parse(lines[i]); } catch { continue; }
    const role = parsed?.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const rawContent = parsed?.message?.content;
    let text = '';
    if (typeof rawContent === 'string') text = rawContent;
    else if (Array.isArray(rawContent)) {
      for (const item of rawContent) {
        if (typeof item === 'string') { text = item; break; }
        if (item?.type === 'text' && typeof item.text === 'string') { text = item.text; break; }
      }
    }
    if (!text || !text.trim()) continue;
    const cleaned = cleanMemoryText(text);
    if (!cleaned) continue;
    const tsRaw = parsed.timestamp ?? parsed.ts ?? Date.now();
    let tsMs;
    if (typeof tsRaw === 'number' && Number.isFinite(tsRaw)) {
      tsMs = tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;
    } else {
      const parsedTs = Date.parse(String(tsRaw));
      tsMs = Number.isFinite(parsedTs) ? parsedTs : Date.now();
    }
    const sourceRef = `transcript:${sessionUuid}#${i + 1}`;
    try {
      const result = insertStmt.run(tsMs, role, cleaned, sourceRef, sessionUuid);
      if (result.changes > 0) count += 1;
    } catch {}
  }
  return count;
}

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
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
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
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Start-Process "${appUrl}"`], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
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

function mergeConfig(existing, data) {
  const config = { ...existing };

  config.backend = 'discord';

  if (data.discord) {
    config.discord = { ...config.discord };
    if (data.discord.token) config.discord.token = data.discord.token;
    if (data.discord.applicationId) config.discord.applicationId = data.discord.applicationId;
  }

  if (data.channelsConfig) config.channelsConfig = data.channelsConfig;
  if (data.mainChannel) config.mainChannel = data.mainChannel;
  if (data.access) config.access = data.access;
  if (data.voice) config.voice = data.voice;
  if (data.schedules) config.schedules = data.schedules;
  if (data.proactive) config.proactive = data.proactive;
  if (data.webhook) config.webhook = data.webhook;

  return config;
}

// -- CLI check --

function checkCli(name) {
  return new Promise(resolve => {
    const cmd = isWin ? `where ${name}` : `which ${name}`;
    exec(cmd, { windowsHide: true }, (err, stdout) => {
      if (err || !stdout.trim()) resolve({ installed: false });
      else resolve({ installed: true, path: stdout.trim().split(/\r?\n/)[0] });
    });
  });
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
let windowOpen = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Proactive feedback CRUD
  const FEEDBACK_PATH = join(DATA_DIR, 'proactive-feedback.json');
  if (req.method === 'GET' && path === '/proactive-feedback') {
    try {
      const data = readJsonFile(FEEDBACK_PATH);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: data.entries || [] }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: [] }));
    }
    return;
  }
  if (req.method === 'DELETE' && path === '/proactive-feedback') {
    const body = await readBody(req);
    const data = readJsonFile(FEEDBACK_PATH);
    const entries = data.entries || [];
    if (typeof body.index === 'number' && body.index >= 0 && body.index < entries.length) {
      entries.splice(body.index, 1);
      writeJsonFile(FEEDBACK_PATH, { entries });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'PUT' && path === '/proactive-feedback') {
    const body = await readBody(req);
    const data = readJsonFile(FEEDBACK_PATH);
    const entries = data.entries || [];
    if (typeof body.index === 'number' && typeof body.text === 'string') {
      entries[body.index] = body.text;
      writeJsonFile(FEEDBACK_PATH, { entries });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && path === '/config') {
    const config = readConfig();
    const bot = readJsonFile(BOT_PATH);
    config._bot = bot;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (req.method === 'POST' && path === '/config') {
    const data = await readBody(req);

    const botData = data._bot;
    delete data._bot;

    const existing = readConfig();
    const merged = mergeConfig(existing, data);
    writeConfig(merged);
    console.log('  Config saved: channels');

    if (botData) {
      const existingBot = readJsonFile(BOT_PATH);
      writeJsonFile(BOT_PATH, { ...existingBot, ...botData });
      console.log('  Config saved: bot.json');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // -- Schedules CRUD --
  const SCHEDULES_DIR = join(DATA_DIR, 'schedules');

  if (req.method === 'GET' && path === '/schedules') {
    const result = [];
    if (existsSync(SCHEDULES_DIR)) {
      for (const name of readdirSync(SCHEDULES_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
        const cfg = readJsonFile(join(SCHEDULES_DIR, name, 'config.json')) || {};
        let prompt = '';
        try { prompt = readFileSync(join(SCHEDULES_DIR, name, 'prompt.md'), 'utf8'); } catch {}
        result.push({ name, ...cfg, prompt });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'POST' && path === '/schedules') {
    const sc = await readBody(req);
    if (!sc.name) { res.writeHead(400); res.end('name required'); return; }
    const dir = join(SCHEDULES_DIR, sc.name);
    mkdirSync(dir, { recursive: true });
    const prompt = sc.prompt || '';
    delete sc.prompt;
    const name = sc.name;
    delete sc.name;
    writeFileSync(join(dir, 'config.json'), JSON.stringify(sc, null, 2));
    writeFileSync(join(dir, 'prompt.md'), prompt);
    console.log('  Schedule saved:', name);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'DELETE' && path === '/schedules') {
    const name = url.searchParams.get('name');
    if (!name) { res.writeHead(400); res.end('name required'); return; }
    const dir = join(SCHEDULES_DIR, name);
    if (existsSync(dir)) { rmSync(dir, { recursive: true }); console.log('  Schedule deleted:', name); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path.startsWith('/schedules/file/')) {
    const name = decodeURIComponent(path.slice('/schedules/file/'.length));
    const filePath = join(SCHEDULES_DIR, name, 'prompt.md');
    if (!existsSync(filePath)) { mkdirSync(join(SCHEDULES_DIR, name), { recursive: true }); writeFileSync(filePath, '', 'utf8'); }
    if (isWin) { spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
    else { spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // -- Webhooks CRUD --
  const WEBHOOKS_DIR = join(DATA_DIR, 'webhooks');

  if (req.method === 'GET' && path === '/webhooks') {
    const result = [];
    if (existsSync(WEBHOOKS_DIR)) {
      for (const name of readdirSync(WEBHOOKS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
        const cfg = readJsonFile(join(WEBHOOKS_DIR, name, 'config.json')) || {};
        let instructions = '';
        try { instructions = readFileSync(join(WEBHOOKS_DIR, name, 'instructions.md'), 'utf8'); } catch {}
        result.push({ name, ...cfg, instructions });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'POST' && path === '/webhooks') {
    const wh = await readBody(req);
    if (!wh.name) { res.writeHead(400); res.end('name required'); return; }
    const dir = join(WEBHOOKS_DIR, wh.name);
    mkdirSync(dir, { recursive: true });
    const instructions = wh.instructions || '';
    delete wh.instructions;
    const name = wh.name;
    delete wh.name;
    writeFileSync(join(dir, 'config.json'), JSON.stringify(wh, null, 2));
    writeFileSync(join(dir, 'instructions.md'), instructions);
    console.log('  Webhook saved:', name);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'DELETE' && path === '/webhooks') {
    const name = url.searchParams.get('name');
    if (!name) { res.writeHead(400); res.end('name required'); return; }
    const dir = join(WEBHOOKS_DIR, name);
    if (existsSync(dir)) { rmSync(dir, { recursive: true }); console.log('  Webhook deleted:', name); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path.startsWith('/webhooks/file/')) {
    const name = decodeURIComponent(path.slice('/webhooks/file/'.length));
    const filePath = join(WEBHOOKS_DIR, name, 'instructions.md');
    if (!existsSync(filePath)) { mkdirSync(join(WEBHOOKS_DIR, name), { recursive: true }); writeFileSync(filePath, '', 'utf8'); }
    if (isWin) { spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
    else { spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/cli-check') {
    const [whisper, ngrok] = await Promise.all([
      checkCli('whisper'),
      checkCli('ngrok'),
    ]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ whisper, ngrok }));
    return;
  }

  // ============================================================
  // AGENT MODULE ROUTES
  // ============================================================

  if (req.method === 'GET' && path === '/agent/config') {
    const config = readAgentConfig();
    const auth = await detectAuth(config);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ config, auth }));
    return;
  }

  if (req.method === 'POST' && path === '/agent/config') {
    const data = await readBody(req);
    const existing = readAgentConfig();
    const merged = mergeAgentConfig(existing, data);
    writeAgentConfig(merged);
    console.log('  Config saved: agent');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/agent/presets') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ presets: readAgentPresets() }));
    return;
  }

  if (req.method === 'POST' && path === '/agent/presets') {
    const data = await readBody(req);
    let preset;
    try { preset = normalizePreset(data); }
    catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
    const list = readAgentPresets();
    const idx = list.findIndex(p => p.id === preset.id);
    if (idx >= 0) list[idx] = preset; else list.push(preset);
    writeAgentPresets(list);
    console.log(`  Agent preset saved: ${preset.id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, preset }));
    return;
  }

  if (req.method === 'DELETE' && path === '/agent/presets') {
    const id = url.searchParams.get('id');
    if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'id required' })); return; }
    const list = readAgentPresets().filter(p => p.id !== id);
    writeAgentPresets(list);
    console.log(`  Agent preset deleted: ${id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // -- Agent maintenance presets --
  if (req.method === 'GET' && path === '/agent/maintenance') {
    const cfg = readAgentConfig();
    const merged = { ...DEFAULT_MAINTENANCE, ...(cfg.maintenance || {}) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ maintenance: merged, defaults: { ...DEFAULT_MAINTENANCE } }));
    return;
  }

  if (req.method === 'POST' && path === '/agent/maintenance') {
    const data = await readBody(req);
    const cfg = readAgentConfig();
    const validIds = new Set((cfg.presets || []).map(p => p.id));
    const invalid = Object.entries(data)
      .filter(([k, v]) => k !== 'defaultPreset' && v && !validIds.has(v))
      .map(([k, v]) => `${k}: ${v}`);
    if (invalid.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Unknown preset(s): ${invalid.join(', ')}` }));
      return;
    }
    if (data.defaultPreset && !validIds.has(data.defaultPreset)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Unknown default preset: ${data.defaultPreset}` }));
      return;
    }
    cfg.maintenance = { ...(cfg.maintenance || {}), ...data };
    writeAgentConfig(cfg);
    console.log('  Maintenance presets saved');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/agent/models') {
    const provider = url.searchParams.get('provider');
    if (!provider) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'provider required' })); return; }
    const cfg = readAgentConfig();
    const models = await listProviderModels(provider, cfg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, provider, models }));
    return;
  }

  if (req.method === 'POST' && path === '/agent/validate') {
    const data = await readBody(req);
    const validation = {};
    const checks = [];
    for (const [id, key] of Object.entries(data.keys || {})) {
      if (key) checks.push(validateAgentKey(id, key).then(r => { validation[id] = r; }));
    }
    await Promise.all(checks);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, validation }));
    return;
  }

  // -- Agent learning config --

  if (req.method === 'GET' && path === '/agent/learning') {
    const cfg = readAgentConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      trajectory: { enabled: true, ...cfg.trajectory },
      skillSuggest: { autoDetect: true, ...cfg.skillSuggest },
      agentMaintenance: { enabled: true, interval: '1h', ...cfg.agentMaintenance },
    }));
    return;
  }

  if (req.method === 'POST' && path === '/agent/learning') {
    const data = await readBody(req);
    const existing = readAgentConfig();
    if (data.trajectory) existing.trajectory = { ...(existing.trajectory || {}), ...data.trajectory };
    if (data.skillSuggest) existing.skillSuggest = { ...(existing.skillSuggest || {}), ...data.skillSuggest };
    if (data.agentMaintenance) existing.agentMaintenance = { ...(existing.agentMaintenance || {}), ...data.agentMaintenance };
    writeAgentConfig(existing);
    console.log('  Config saved: agent learning');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ============================================================
  // MEMORY MODULE ROUTES
  // ============================================================

  if (req.method === 'GET' && path === '/memory/config') {
    const config = readMemoryConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (req.method === 'POST' && path === '/memory/config') {
    const data = await readBody(req);
    const existing = readMemoryConfig();
    const merged = mergeMemoryConfig(existing, data);
    writeMemoryConfig(merged);
    console.log('  Config saved: memory');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/memory/auth') {
    const cfg = readMemoryConfig();
    const result = await detectAuth(cfg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'GET' && path === '/memory/presets') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ presets: readMemoryPresets() }));
    return;
  }

  if (req.method === 'POST' && path === '/memory/presets') {
    const data = await readBody(req);
    let preset;
    try { preset = normalizePreset(data); }
    catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
    const list = readMemoryPresets();
    const idx = list.findIndex(p => p.id === preset.id);
    if (idx >= 0) list[idx] = preset; else list.push(preset);
    writeMemoryPresets(list);
    console.log(`  Memory preset saved: ${preset.id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, preset }));
    return;
  }

  if (req.method === 'PUT' && path === '/memory/presets') {
    const data = await readBody(req);
    if (!Array.isArray(data.presets)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'presets array required' }));
      return;
    }
    const normalized = data.presets.map(p => normalizePreset(p));
    writeMemoryPresets(normalized);
    console.log(`  Memory presets reordered: ${normalized.length} items`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'DELETE' && path === '/memory/presets') {
    const id = url.searchParams.get('id');
    if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'id required' })); return; }
    const list = readMemoryPresets().filter(p => p.id !== id);
    writeMemoryPresets(list);
    console.log(`  Memory preset deleted: ${id}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/memory/models') {
    const provider = url.searchParams.get('provider');
    if (!provider) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'provider required' })); return; }
    const cfg = readMemoryConfig();
    const models = await listProviderModels(provider, cfg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, provider, models }));
    return;
  }

  if (req.method === 'GET' && path === '/memory/files') {
    const result = {};
    for (const name of ['bot.md', 'user.md']) {
      try { result[name] = readFileSync(join(MEMORY_FILES_DIR, name), 'utf8'); }
      catch { result[name] = ''; }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'GET' && path.startsWith('/memory/file/')) {
    const name = decodeURIComponent(path.slice('/memory/file/'.length));
    if (!['bot.md', 'user.md'].includes(name)) { res.writeHead(404); res.end('Not found'); return; }
    const filePath = join(MEMORY_FILES_DIR, name);
    mkdirSync(MEMORY_FILES_DIR, { recursive: true });
    if (!existsSync(filePath)) writeFileSync(filePath, '', 'utf8');
    if (isWin) { spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
    else { exec(`open "${filePath}"`); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && path === '/memory/files') {
    const data = await readBody(req);
    mkdirSync(MEMORY_FILES_DIR, { recursive: true });
    for (const name of ['bot.md', 'user.md']) {
      if (data[name] != null) writeFileSync(join(MEMORY_FILES_DIR, name), data[name], 'utf8');
    }
    console.log('  Memory files saved');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/api/memory/entries/active') {
    try {
      const db = openMemoryDb(true);
      const rows = db.prepare(`
        SELECT id, element, category, summary, score, last_seen_at
        FROM entries
        WHERE is_root = 1 AND status = 'active'
        ORDER BY score DESC
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

  {
    const statusMatch = req.method === 'POST' && path.match(/^\/api\/memory\/entries\/(\d+)\/status$/);
    if (statusMatch) {
      const id = Number(statusMatch[1]);
      const data = await readBody(req);
      const VALID = ['active', 'pending', 'demoted', 'processed', 'archived'];
      const status = String(data.status ?? '').trim().toLowerCase();
      if (!Number.isInteger(id) || id <= 0 || !VALID.includes(status)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'valid id and status required' }));
        return;
      }
      try {
        const db = openMemoryDb();
        const result = db.prepare(
          'UPDATE entries SET status = ? WHERE id = ? AND is_root = 1'
        ).run(status, id);
        db.close();
        console.log(`  Entry #${id} → ${status} (changes=${result.changes})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changes: Number(result.changes ?? 0) }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
  }

  if (req.method === 'POST' && path === '/api/memory/entries') {
    const data = await readBody(req);
    const element = String(data.element ?? '').trim();
    const summary = String(data.summary ?? '').trim();
    const category = String(data.category ?? 'fact').trim().toLowerCase();
    const VALID_CATS = ['rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue'];
    if (!element || !summary || !VALID_CATS.includes(category)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'element, summary, and valid category required' }));
      return;
    }
    const GRADE = { rule: 2.0, constraint: 1.9, decision: 1.8, fact: 1.6, goal: 1.5, preference: 1.4, task: 1.1, issue: 1.0 };
    const nowMs = Date.now();
    const sourceRef = `manual:${nowMs}-${process.pid}`;
    try {
      const db = openMemoryDb();
      db.exec('BEGIN');
      try {
        const result = db.prepare(`
          INSERT INTO entries(ts, role, content, source_ref, session_id)
          VALUES (?, 'system', ?, ?, NULL)
        `).run(nowMs, element + ' — ' + summary, sourceRef);
        const newId = Number(result.lastInsertRowid);
        db.prepare(`
          UPDATE entries
          SET chunk_root = ?, is_root = 1, element = ?, category = ?, summary = ?,
              status = 'active', score = ?, last_seen_at = ?
          WHERE id = ?
        `).run(newId, element, category, summary, GRADE[category], nowMs, newId);
        db.exec('COMMIT');
        await syncRootEmbedding(db, newId);
        console.log(`  Remembered entry #${newId}: [${category}] ${element}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: newId }));
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      } finally {
        db.close();
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && path === '/memory/backfill') {
    if (_backfillInProgress) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'backfill already in progress' }));
      return;
    }
    const data = await readBody(req);
    const requestedWindow = data.window || '7d';
    _backfillInProgress = true;
    let db;
    try {
      db = openMemoryDb();
      try { db.exec('PRAGMA busy_timeout = 30000'); } catch {}
      const memoryConfig = readMemoryConfig() || {};
      console.log(`[backfill] start window=${requestedWindow}`);
      const result = await runFullBackfill(db, {
        window: requestedWindow,
        scope: 'all',
        config: memoryConfig,
        ingestTranscriptFile: (fp) => ingestTranscriptForBackfill(db, fp),
        runCycle1,
        runCycle2,
      });
      console.log(`[backfill] done files=${result.files} ingested=${result.ingested} cycle1_iters=${result.cycle1_iters} promoted=${result.promoted} unclassified=${result.unclassified}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      console.error(`[backfill] failed: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    } finally {
      try { db?.close?.(); } catch {}
      _backfillInProgress = false;
    }
    return;
  }

  if (req.method === 'POST' && path === '/memory/validate') {
    const data = await readBody(req);
    const validation = {};
    const checks = [];
    for (const [id, key] of Object.entries(data.keys || {})) {
      if (key) checks.push(validateAgentKey(id, key).then(r => { validation[id] = r; }));
    }
    await Promise.all(checks);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, validation }));
    return;
  }

  // ============================================================
  // SEARCH MODULE ROUTES
  // ============================================================

  if (req.method === 'GET' && path === '/search/config') {
    const config = readSearchConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (req.method === 'POST' && path === '/search/config') {
    const data = await readBody(req);
    const existing = readSearchConfig();
    const merged = mergeSearchConfig(existing, data);
    writeSearchConfig(merged);
    console.log('  Config saved: search');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && path === '/search/validate') {
    const data = await readBody(req);
    const validation = {};
    const checks = [];
    for (const [id, val] of Object.entries(data.searchProviders || {})) {
      const key = typeof val === 'object' ? val.key : val;
      if (key) checks.push(validateSearchKey(id, key).then(r => { validation[id] = r; }));
    }
    for (const [id, val] of Object.entries(data.aiProviders || {})) {
      if (val && val !== 'cli') checks.push(validateSearchKey(id, val).then(r => { validation[id] = r; }));
    }
    if (data.github) checks.push(validateSearchKey('github', data.github).then(r => { validation.github = r; }));
    await Promise.all(checks);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, validation }));
    return;
  }

  if (req.method === 'GET' && path === '/search/cli-check') {
    const check = (cmd) => {
      try { execSync(`${cmd} --version`, { stdio: 'pipe', timeout: 5000, windowsHide: true }); return true; }
      catch { return false; }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ codex: check('codex'), claude: check('claude'), gemini: check('gemini') }));
    return;
  }

  // ============================================================
  // CHANNELS MODULE ROUTES (continued)
  // ============================================================

  if (req.method === 'POST' && path === '/install') {
    const data = await readBody(req);
    const tool = data.tool;
    if (!tool || !['ngrok', 'whisper'].includes(tool)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid tool' }));
      return;
    }

    const commands = {
      ngrok: 'npm install -g ngrok',
      whisper: 'pip install openai-whisper',
    };

    try {
      const { stdout } = await new Promise((resolve, reject) => {
        exec(commands[tool], { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      });
      console.log(`  Installed ${tool}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tool, output: stdout.trim() }));
    } catch (e) {
      console.log(`  Install ${tool} failed: ${e.message}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, tool, error: e.message }));
    }
    return;
  }

  // ============================================================
  // GENERAL MODULE ROUTES
  // ============================================================

  if (req.method === 'GET' && path === '/general/config') {
    const config = readConfig();
    const pi = (config && typeof config.promptInjection === 'object' && config.promptInjection) || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      promptInjection: {
        mode: pi.mode === 'claude_md' ? 'claude_md' : 'hook',
        targetPath: typeof pi.targetPath === 'string' && pi.targetPath ? pi.targetPath : '~/.claude/CLAUDE.md',
      },
    }));
    return;
  }

  if (req.method === 'POST' && path === '/general/save') {
    const data = await readBody(req);
    const existing = readConfig();
    const next = { ...existing };
    const prev = (existing && typeof existing.promptInjection === 'object' && existing.promptInjection) || {};
    const merged = { ...prev };
    if (data && (data.mode === 'hook' || data.mode === 'claude_md')) {
      merged.mode = data.mode;
    }
    if (data && typeof data.targetPath === 'string' && data.targetPath.trim()) {
      merged.targetPath = data.targetPath.trim();
    }
    if (!merged.mode) merged.mode = 'hook';
    if (!merged.targetPath) merged.targetPath = '~/.claude/CLAUDE.md';
    next.promptInjection = merged;
    writeConfig(next);
    console.log('  Config saved: general/promptInjection');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, promptInjection: merged }));
    return;
  }

  // ============================================================
  // WORKFLOW MODULE ROUTES
  // ============================================================

  if (req.method === 'GET' && path === '/workflow/load') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readUserWorkflow()));
    return;
  }

  if (req.method === 'POST' && path === '/workflow/save') {
    const data = await readBody(req);
    writeUserWorkflow(data);
    console.log('  Config saved: user-workflow');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/workflow/md') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(readUserWorkflowMd());
    return;
  }

  if (req.method === 'POST' && path === '/workflow/md') {
    let body = '';
    await new Promise((resolve, reject) => {
      req.on('data', c => { body += c; });
      req.on('end', resolve);
      req.on('error', reject);
    });
    writeUserWorkflowMd(body);
    console.log('  Config saved: user-workflow.md');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && path === '/workflow/file') {
    if (!existsSync(USER_WORKFLOW_MD_PATH)) {
      mkdirSync(dirname(USER_WORKFLOW_MD_PATH), { recursive: true });
      writeFileSync(USER_WORKFLOW_MD_PATH, DEFAULT_USER_WORKFLOW_MD, 'utf8');
    }
    if (isWin) { spawn('cmd', ['/c', 'start', '', USER_WORKFLOW_MD_PATH], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
    else { spawn('open', [USER_WORKFLOW_MD_PATH], { detached: true, stdio: 'ignore' }).unref(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === '/close') {
    windowOpen = false;
    res.writeHead(200);
    res.end();
    console.log('  Window closed');
    return;
  }

  if (path === '/open') {
    if (!windowOpen) {
      openAppWindow();
      windowOpen = true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
  console.log(`\n  TRIB CONFIG`);
  console.log(`  http://localhost:${PORT}\n`);
  if (process.env.TRIB_SETUP_OPEN_ON_START === '1') {
    openGeneration++;
    windowOpen = true;
    setTimeout(() => { openAppWindow(); }, 0);
  }
});

// Parent-PID watchdog: setup-server is launched detached/unref'd (see
// setup/launch.mjs), so losing Claude Code does not reap it. Poll the
// launcher's parent PID (the Claude Code CLI) and exit when it dies. This is
// the detached-process equivalent of the run-mcp.mjs stdin-close pattern
// applied to memory/channels workers in v0.6.0.
(() => {
  const parentPid = parseInt(process.env.TRIB_SETUP_PARENT_PID || '', 10);
  if (!Number.isFinite(parentPid) || parentPid <= 0) return;
  const tick = () => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  };
  const timer = setInterval(tick, 5000);
  if (typeof timer.unref === 'function') timer.unref();
})();
