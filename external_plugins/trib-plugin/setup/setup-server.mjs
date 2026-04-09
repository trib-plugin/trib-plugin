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
const pluginsData = join(home, '.claude', 'plugins', 'data');

const DATA_DIR = join(pluginsData, 'trib-plugin-trib-plugin');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const BOT_PATH = join(DATA_DIR, 'bot.json');
const MEMORY_PATH = join(DATA_DIR, 'memory-config.json');
const SEARCH_PATH = join(DATA_DIR, 'search-config.json');
const PORT = 3458;
const APP_WIDTH = 850;
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

function setAlwaysOnTop(title) {
  if (isWin) {
    const ps = `Add-Type -Name W -Namespace N -Member '[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int h2,uint f);[DllImport("user32.dll")]public static extern IntPtr FindWindow(string c,string t);';$h=[N.W]::FindWindow([NullString]::Value,'${title}');if($h-ne[IntPtr]::Zero){[N.W]::SetWindowPos($h,[IntPtr]::new(-1),0,0,0,0,3)}`;
    try {
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
    } catch {}
  } else if (process.platform === 'darwin') {
    const osa = `tell application "System Events" to set frontmost of every process whose name contains "Chrome" to true`;
    try {
      spawn('osascript', ['-e', osa], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
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
        // Set always-on-top after window opens
        setTimeout(() => setAlwaysOnTop('TRIB-CHANNELS CONFIG'), 1500);
        return true;
      } catch {}
    }
    // Fallback: use PowerShell Start-Process to avoid cmd.exe console flash
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Start-Process "${appUrl}"`], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
    return true;
  }

  if (process.platform === 'darwin') {
    const macBrowsers = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    const macBrowser = macBrowsers.find(p => existsSync(p));
    if (macBrowser) {
      try {
        const child = spawn(macBrowser, [`--app=${appUrl}`, `--window-size=${APP_WIDTH},${APP_HEIGHT}`], {
          detached: true, stdio: 'ignore',
        });
        child.unref();
        setTimeout(() => setAlwaysOnTop('TRIB-CHANNELS CONFIG'), 1500);
        return true;
      } catch {}
    }
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
  if (data.autotalk) config.autotalk = data.autotalk;
  if (data.events) config.events = data.events;
  if (data.webhook) config.webhook = data.webhook;

  return config;
}

// -- CLI check --

function checkCli(name) {
  return new Promise(resolve => {
    const cmd = isWin ? `where ${name}` : `which ${name}`;
    exec(cmd, (err, stdout) => {
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

const server = http.createServer(async (req, res) => {
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
    config._bot = readJsonFile(BOT_PATH);
    config._memory = readJsonFile(MEMORY_PATH);
    config._search = readJsonFile(SEARCH_PATH);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (req.method === 'POST' && path === '/config') {
    const data = await readBody(req);

    const botData = data._bot;
    const memoryData = data._memory;
    const searchData = data._search;
    delete data._bot;
    delete data._memory;
    delete data._search;

    const existing = readConfig();
    const merged = mergeConfig(existing, data);
    writeConfig(merged);
    console.log('  Config saved: main');

    if (botData) {
      const existingBot = readJsonFile(BOT_PATH);
      writeJsonFile(BOT_PATH, { ...existingBot, ...botData });
      console.log('  Config saved: bot.json');
    }
    if (memoryData) {
      const existingMem = readJsonFile(MEMORY_PATH);
      writeJsonFile(MEMORY_PATH, { ...existingMem, ...memoryData });
      console.log('  Config saved: memory-config.json');
    }
    if (searchData) {
      const existingSearch = readJsonFile(SEARCH_PATH);
      writeJsonFile(SEARCH_PATH, { ...existingSearch, ...searchData });
      console.log('  Config saved: search-config.json');
    }
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
        exec(commands[tool], { timeout: 120000 }, (err, stdout, stderr) => {
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
  console.log(`\n  TRIB-CHANNELS CONFIG`);
  console.log(`  http://localhost:${PORT}\n`);
  if (process.env.TRIB_SETUP_OPEN_ON_START === '1') {
    openGeneration++;
    setTimeout(() => { openAppWindow(); }, 0);
  }
});
