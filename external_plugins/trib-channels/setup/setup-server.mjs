#!/usr/bin/env node
import { exec } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const home = homedir();
const pluginsData = join(home, '.claude', 'plugins', 'data');

const DATA_DIR = join(pluginsData, 'trib-channels-trib-plugin');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const PORT = 3458;
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
  if (data.events) config.events = data.events;
  if (data.contextFiles) config.contextFiles = data.contextFiles;
  if (data.language) config.language = data.language;
  if (data.embedding) config.embedding = data.embedding;
  if (data.webhook) config.webhook = data.webhook;

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
    const botPath = join(DATA_DIR, 'bot.json');
    const profilePath = join(DATA_DIR, 'profile.json');
    config._bot = readJsonFile(botPath);
    config._profile = readJsonFile(profilePath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (req.method === 'POST' && path === '/config') {
    const data = await readBody(req);

    const botData = data._bot;
    const profileData = data._profile;
    delete data._bot;
    delete data._profile;

    const existing = readConfig();
    const merged = mergeConfig(existing, data);
    writeConfig(merged);
    console.log('  Config saved: channels');

    if (botData) {
      const botPath = join(DATA_DIR, 'bot.json');
      const existingBot = readJsonFile(botPath);
      writeJsonFile(botPath, { ...existingBot, ...botData });
      console.log('  Config saved: bot.json');
    }
    if (profileData) {
      const profilePath = join(DATA_DIR, 'profile.json');
      const existingProfile = readJsonFile(profilePath);
      writeJsonFile(profilePath, { ...existingProfile, ...profileData });
      console.log('  Config saved: profile.json');
    }

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
  console.log(`\n  trib-channels setup`);
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
    if (browser) exec(`"${browser}" --app=${appUrl} --window-size=800,900 --new-window`);
    else exec(`start ${appUrl}`);
  } else if (process.platform === 'darwin') {
    exec(`open ${appUrl}`);
  } else {
    exec(`xdg-open ${appUrl}`);
  }
});
