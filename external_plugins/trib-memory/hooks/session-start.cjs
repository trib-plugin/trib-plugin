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

const HISTORY_DIR = path.join(DATA_DIR, 'history');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CONTEXT_FILE = path.join(HISTORY_DIR, 'context.md');
const RECENT_FILE = path.join(HISTORY_DIR, 'recent.md');
const BOT_FILE = path.join(DATA_DIR, 'bot.md');
const USER_PROFILE_FILE = path.join(DATA_DIR, 'user_profile.md');

function readOptional(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

// Build user line from config
let userLine = '';
const cfg = readJson(CONFIG_FILE);
const userName = (cfg.user && cfg.user.name || '').trim();
const userTitle = (cfg.user && cfg.user.title || '').trim();
if (userName) {
  userLine = userTitle ? `User: ${userName} (${userTitle})` : `User: ${userName}`;
}

let contextContent = readOptional(CONTEXT_FILE);
let recentContent = readOptional(RECENT_FILE);
// Limit recent items to last 10 entries
if (recentContent) {
  const lines = recentContent.split('\n');
  const header = lines.filter(l => l.startsWith('#'));
  const items = lines.filter(l => l.startsWith('- '));
  const trimmed = items.slice(-10);
  recentContent = [...header, ...trimmed].join('\n');
}
let botContent = readOptional(BOT_FILE);
let userProfileContent = readOptional(USER_PROFILE_FILE);

const merged = [userLine, userProfileContent, botContent, contextContent, recentContent].filter(Boolean).join('\n\n');
if (merged) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: merged
    }
  }));
}
