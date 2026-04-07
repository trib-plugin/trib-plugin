'use strict';

const fs = require('fs');
const path = require('path');

let _event = {};
try {
  const _input = fs.readFileSync(0, 'utf8');
  if (_input) _event = JSON.parse(_input);
} catch {}

if (_event.isSidechain) process.exit(0);
if (_event.agentId) process.exit(0);
if (_event.kind && _event.kind !== 'interactive') process.exit(0);

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DB_FILE = path.join(DATA_DIR, 'memory.sqlite');
const BOT_FILE = path.join(DATA_DIR, 'bot.md');
const USER_PROFILE_FILE = path.join(DATA_DIR, 'user.md');

function readOptional(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

function loadCoreMemory() {
  try {
    if (!fs.existsSync(DB_FILE)) return '';
    // Node.js 22+ built-in sqlite. Suppress ExperimentalWarning so it doesn't
    // leak into hook stderr and pollute Claude Code's output.
    process.removeAllListeners('warning');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      const rows = db.prepare(
        "SELECT topic, element, importance FROM core_memory WHERE status = 'active' ORDER BY final_score DESC"
      ).all();
      if (!rows.length) return '';
      return rows.map(r => `- [${r.importance}] ${r.topic} — ${r.element}`).join('\n');
    } finally {
      db.close();
    }
  } catch {
    return '';
  }
}

// Build user line from config
let userLine = '';
const cfg = readJson(CONFIG_FILE);
const userName = (cfg.user && cfg.user.name || '').trim();
const userTitle = (cfg.user && cfg.user.title || '').trim();
if (userName) {
  userLine = userTitle ? `User: ${userName} (${userTitle})` : `User: ${userName}`;
}

let botContent = readOptional(BOT_FILE);
let userProfileContent = readOptional(USER_PROFILE_FILE);
let coreMemoryContent = loadCoreMemory();

const merged = [userLine, userProfileContent, botContent, coreMemoryContent].filter(Boolean).join('\n\n');
if (merged) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: merged
    }
  }));
}
