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

const CONFIG_PATH = join(pluginsData, 'trib-memory-trib-plugin', 'config.json');
const PORT = 3457;
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

  if (data.embedding) {
    if (!config.embedding) config.embedding = {};
    if (data.embedding.provider) config.embedding.provider = data.embedding.provider;
    if (data.embedding.model) config.embedding.model = data.embedding.model;
  }

  if (data.cycles) {
    if (!config.cycles) config.cycles = {};

    if (data.cycles.cycle1) {
      if (!config.cycles.cycle1) config.cycles.cycle1 = {};
      const c = data.cycles.cycle1;
      if (c.interval !== undefined) config.cycles.cycle1.interval = c.interval;
      if (c.timeout !== undefined) config.cycles.cycle1.timeout = c.timeout;
      if (c.batchSize !== undefined) config.cycles.cycle1.batchSize = c.batchSize;
      if (c.maxDays !== undefined) config.cycles.cycle1.maxDays = c.maxDays;
      if (c.provider) config.cycles.cycle1.provider = c.provider;
    }

    if (data.cycles.cycle2) {
      if (!config.cycles.cycle2) config.cycles.cycle2 = {};
      const c = data.cycles.cycle2;
      if (c.schedule !== undefined) config.cycles.cycle2.schedule = c.schedule;
      if (c.maxCandidates !== undefined) config.cycles.cycle2.maxCandidates = c.maxCandidates;
      if (c.provider) config.cycles.cycle2.provider = c.provider;
    }

    if (data.cycles.cycle3) {
      if (!config.cycles.cycle3) config.cycles.cycle3 = {};
      const c = data.cycles.cycle3;
      if (c.schedule !== undefined) config.cycles.cycle3.schedule = c.schedule;
      if (c.day) config.cycles.cycle3.day = c.day;
      if (c.threshold !== undefined) config.cycles.cycle3.threshold = c.threshold;
      if (c.graceDays !== undefined) config.cycles.cycle3.graceDays = c.graceDays;
    }
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
    console.log('  Config saved: memory');
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
  console.log(`\n  trib-memory setup`);
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
    if (browser) exec(`"${browser}" --app=${appUrl} --window-size=650,600 --new-window`);
    else exec(`start ${appUrl}`);
  } else if (process.platform === 'darwin') {
    exec(`open ${appUrl}`);
  } else {
    exec(`xdg-open ${appUrl}`);
  }
});
