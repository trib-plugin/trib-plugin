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
const CONTEXT_FILE = path.join(HISTORY_DIR, 'context.md');
const RECENT_FILE = path.join(HISTORY_DIR, 'recent.md');
const BOT_FILE = path.join(HISTORY_DIR, 'bot.md');
const USER_PROFILE_FILE = path.join(HISTORY_DIR, 'user_profile.md');

function readOptional(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

let contextContent = readOptional(CONTEXT_FILE);
let recentContent = readOptional(RECENT_FILE);
let botContent = readOptional(BOT_FILE);
let userProfileContent = readOptional(USER_PROFILE_FILE);

const merged = [botContent, userProfileContent, contextContent, recentContent].filter(Boolean).join('\n\n');
if (merged) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: merged
    }
  }));
}
