'use strict';

/**
 * trib-plugin unified SessionStart hook
 *
 * Reads config.json and conditionally injects rules as additionalContext:
 *   - Channels: always (core feature)
 *   - Memory: when config.memory exists
 *   - Search: when config.search?.enabled !== false (default: enabled)
 *   - Automation: when config.nonInteractive/interactive/webhook exist
 *
 * Also loads: contextFiles, settings.local.md, bot.md, user.md, core_memory
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
if (!DATA_DIR) process.exit(0);

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOCAL_FILE = path.join(DATA_DIR, 'settings.local.md');
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

// --- Config ---
const config = readJson(CONFIG_FILE);
const parts = [];

// --- 1. Context files (always) ---
const contextFiles = config.contextFiles || [];
for (const f of contextFiles) {
  const content = readOptional(f);
  if (content) parts.push(content);
}

// --- 2. Local overrides (always) ---
const local = readOptional(LOCAL_FILE);
if (local) parts.push(local);

// --- 3. User info ---
const userName = (config.user && config.user.name || '').trim();
const userTitle = (config.user && config.user.title || '').trim();
if (userName) {
  parts.push(userTitle ? `User: ${userName} (${userTitle})` : `User: ${userName}`);
}

// --- 4. Bot personality ---
const botContent = readOptional(BOT_FILE);
if (botContent) parts.push(botContent);

// --- 5. User profile ---
const userProfileContent = readOptional(USER_PROFILE_FILE);
if (userProfileContent) parts.push(userProfileContent);

// --- 6. Conditional rules ---

// Channels: always enabled (core feature)
parts.push([
  '## Channels',
  '- Text output is auto-forwarded to Discord. Use `reply` only for files, embeds, or components.',
  '- Tools: `reply`, `react`, `edit_message`, `download_attachment`, `activate_channel_bridge`.'
].join('\n'));

// Memory: enabled when config.memory exists
if (config.memory) {
  const coreMemoryContent = loadCoreMemory();

  const memoryRules = [
    '## Memory',
    '- Use `search_memories` tool for recall. Storage is automatic.',
    '- Never write to MEMORY.md or use sqlite directly.'
  ];
  if (coreMemoryContent) {
    memoryRules.push('', '### Core Memory', coreMemoryContent);
  }
  parts.push(memoryRules.join('\n'));
}

// Search: enabled unless search-config.json has enabled === false
const searchConfig = readJson(path.join(DATA_DIR, 'search-config.json'));
const searchEnabled = searchConfig.enabled !== false;
if (searchEnabled) {
  parts.push([
    '## Search',
    '- Use `search` tool for external lookups, not built-in WebSearch/WebFetch.',
    '- 2+ lookups: use `batch`.',
    '- Unfamiliar topic: search first, never guess.'
  ].join('\n'));
}

// Automation: enabled when schedules or webhooks are configured
const scheduleItems = config.schedules && Array.isArray(config.schedules.items) ? config.schedules.items : [];
const hasSchedules = scheduleItems.length > 0;
const hasWebhooks = (() => {
  try {
    const webhooksDir = path.join(DATA_DIR, 'webhooks');
    return fs.existsSync(webhooksDir) && fs.readdirSync(webhooksDir).length > 0;
  } catch { return false; }
})();
const hasWebhook = config.webhook && config.webhook.enabled;
if (hasSchedules || hasWebhooks || hasWebhook) {
  const autoRules = ['## Automation'];
  if (hasSchedules) {
    autoRules.push('- Tools: `schedule_status`, `trigger_schedule`, `schedule_control`.');
  }
  if (hasWebhooks || hasWebhook) {
    autoRules.push('- Webhook receiver is active. Process incoming webhook events as instructed.');
  }
  parts.push(autoRules.join('\n'));
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
