'use strict';

/**
 * trib-plugin unified SessionStart hook
 *
 * Reads rules/*.md files and profile data, injects as additionalContext.
 * Injection order:
 *   1. workflow.md   (always)
 *   2. memory.md     (when memory-config.json has enabled)
 *   3. channels.md   (when channel backend configured)
 *   4. search.md     (when search-config.json has enabled)
 *   5. agent.md      (always)
 *   6. models        (from agent-config.json presets)
 *   7. context.md    (auto-generated core memory snapshot)
 *   8. user.md       (user profile)
 *   9. bot.md        (bot persona)
 *  10. user name     (from memory-config.json user.name)
 *  11. user title    (from memory-config.json user.title)
 */

const fs = require('fs');
const path = require('path');

// Read hook event from stdin
let _event = {};
try {
  const _input = fs.readFileSync(0, 'utf8');
  if (_input) _event = JSON.parse(_input);
} catch {}

// Only inject for main interactive sessions
if (_event.isSidechain) process.exit(0);
if (_event.agentId) process.exit(0);
if (_event.kind && _event.kind !== 'interactive') process.exit(0);

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
if (!DATA_DIR || !PLUGIN_ROOT) process.exit(0);

const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function readOptional(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

// --- Config ---
const config = readJson(CONFIG_FILE);
const memoryConfig = readJson(path.join(DATA_DIR, 'memory-config.json'));
const parts = [];

// --- 1. Workflow (always) ---
const workflow = readOptional(path.join(RULES_DIR, 'workflow.md'));
if (workflow) parts.push(workflow);

// --- 2. Memory (when memory-config.json has enabled) ---
if (memoryConfig.enabled) {
  const memory = readOptional(path.join(RULES_DIR, 'memory.md'));
  if (memory) parts.push(memory);
}

// --- 3. Channels (when backend configured) ---
if (config.backend) {
  const channels = readOptional(path.join(RULES_DIR, 'channels.md'));
  if (channels) parts.push(channels);
}

// --- 4. Search (when search-config.json has enabled) ---
const searchConfig = readJson(path.join(DATA_DIR, 'search-config.json'));
if (searchConfig.enabled) {
  const search = readOptional(path.join(RULES_DIR, 'search.md'));
  if (search) parts.push(search);
}

// --- 5. Agent (always) ---
const agent = readOptional(path.join(RULES_DIR, 'agent.md'));
if (agent) parts.push(agent);

// --- 6. Models (from agent-config.json presets) ---
const agentConfig = readJson(path.join(DATA_DIR, 'agent-config.json'));
if (agentConfig.presets && agentConfig.presets.length > 0) {
  const lines = ['# Models'];
  if (agentConfig.guide) lines.push('', agentConfig.guide);
  lines.push('', '## Available presets');
  for (const p of agentConfig.presets) {
    const detail = [p.type, p.model, p.effort].filter(Boolean).join(', ');
    lines.push(`- ${p.id} (${detail})`);
  }
  parts.push(lines.join('\n'));
}

// --- 7. Context (auto-generated core memory snapshot) ---
const contextContent = readOptional(path.join(HISTORY_DIR, 'context.md'));
if (contextContent) parts.push(contextContent);

// --- 8. User profile ---
const userProfileContent = readOptional(path.join(HISTORY_DIR, 'user.md'));
if (userProfileContent) parts.push(userProfileContent);

// --- 9. Bot persona ---
const botContent = readOptional(path.join(HISTORY_DIR, 'bot.md'));
if (botContent) parts.push(botContent);

// --- 10-11. User name & title (from memory-config.json) ---
const userName = (memoryConfig.user && memoryConfig.user.name || '').trim();
const userTitle = (memoryConfig.user && memoryConfig.user.title || '').trim();
if (userName) {
  parts.push(userTitle ? `User: ${userName} (${userTitle})` : `User: ${userName}`);
}

// --- Output ---
if (parts.length > 0) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: parts.join('\n\n')
    }
  }));
}
