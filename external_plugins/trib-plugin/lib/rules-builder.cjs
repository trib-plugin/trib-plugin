'use strict';

/**
 * trib-plugin rules builder (pure function extracted from hooks/session-start.cjs).
 *
 * Builds the injection content string that either the SessionStart hook
 * (hook mode) or the MCP boot-time writer (claude_md mode) uses.
 *
 * Injection order for static rules (core memory snapshot and session recap
 * are injected separately by hooks/session-start.cjs from memory.sqlite):
 *   1. user-workflow.md (always)
 *   1a. user workflow (scopes from agent-config.json + description from user-workflow.md)
 *   2. memory.md     (when memory-config.json has enabled)
 *   3. channels.md   (when channel backend configured)
 *   4. search.md     (when search-config.json has enabled)
 *   5. team.md       (always)
 *   6. models        (from agent-config.json presets)
 *   7. user.md       (user profile)
 *   8. bot.md        (bot persona)
 *   9. user name     (from memory-config.json user.name)
 *  10. user title    (from memory-config.json user.title)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function readOptional(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

/**
 * Extract Pool B — safe CLAUDE.md sections (blacklist filter).
 *
 * Two things are stripped; everything else — including any custom section
 * the user adds in the future — is kept verbatim so the Pool B prefix
 * tracks CLAUDE.md edits automatically.
 *
 *   1. The plugin-managed block (marker-delimited). Its content is already
 *      reassembled by `buildBridgeInjectionContent` and by other steps in
 *      the Pool B pipeline; re-injecting it here would duplicate tone /
 *      user / Lead-only prose into the Bridge prefix.
 *   2. Lead-only headings that Claude Code auto-loads via Pool A and that
 *      must never reach a Bridge agent:
 *        H1: # Memory, # Channels, # Search, # Team, # Models
 *        H2: ## Workflow, ## User Rules
 *      Their entire section (heading + body down to the next same-or-higher
 *      heading) is removed.
 */
const CLAUDE_MD_EXCLUDE_H1 = new Set([
  '# Memory', '# Channels', '# Search', '# Team', '# Models',
]);
const CLAUDE_MD_EXCLUDE_H2 = new Set([
  '## Workflow', '## User Rules',
]);

function extractCommonClaudeMdSections(content) {
  if (!content) return '';
  const stripped = content
    .replace(/<!-- BEGIN trib-plugin managed -->[\s\S]*?<!-- END trib-plugin managed -->/g, '')
    .trim();
  if (!stripped) return '';
  const lines = stripped.split('\n');
  const out = [];
  let skipH1 = false;
  let skipH2 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const isH1 = /^# [^#]/.test(trimmed);
    const isH2 = /^## [^#]/.test(trimmed);
    if (isH1) {
      skipH2 = false;
      skipH1 = CLAUDE_MD_EXCLUDE_H1.has(trimmed);
    } else if (isH2 && !skipH1) {
      skipH2 = CLAUDE_MD_EXCLUDE_H2.has(trimmed);
    }
    if (!skipH1 && !skipH2) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Build the injection content from rules/*.md, history/*.md, and config JSON files.
 *
 * @param {object} opts
 * @param {string} opts.PLUGIN_ROOT — absolute path to the plugin root
 * @param {string} opts.DATA_DIR    — absolute path to the plugin data dir
 * @returns {string} joined injection content (parts joined with '\n\n')
 */
function buildInjectionContent({ PLUGIN_ROOT, DATA_DIR }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const HISTORY_DIR = path.join(DATA_DIR, 'history');
  const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

  // --- Config ---
  const config = readJson(CONFIG_FILE);
  const memoryConfig = readJson(path.join(DATA_DIR, 'memory-config.json'));
  const parts = [];

  // --- 1. Workflow (always) ---
  const workflow = readOptional(path.join(RULES_DIR, 'user-workflow.md'));
  if (workflow) parts.push(workflow);

  // --- 1a. User Workflow (roles from user-workflow.json + description from user-workflow.md) ---
  const userWorkflowPath = path.join(DATA_DIR, 'user-workflow.json');
  const userWorkflowMdPath = path.join(DATA_DIR, 'user-workflow.md');
  let userWorkflow = { roles: [] };
  try {
    if (fs.existsSync(userWorkflowPath)) {
      userWorkflow = JSON.parse(fs.readFileSync(userWorkflowPath, 'utf8'));
    }
  } catch {}
  const wfDescription = readOptional(userWorkflowMdPath);
  const wfLines = ['## User Rules', ''];
  if (wfDescription) wfLines.push(wfDescription, '');
  if (Array.isArray(userWorkflow.roles) && userWorkflow.roles.length > 0) {
    // Phase B §10 — all Pool B agents spawn through the Bridge MCP (the
    // native Agent-tool path was retired in Ship 4). Label accordingly.
    wfLines.push('Roles:');
    for (const role of userWorkflow.roles) {
      wfLines.push(`- ${role.name} → ${role.preset} (Bridge)`);
    }
  }
  parts.push(wfLines.join('\n'));

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

  // --- 5. Team (always) ---
  const agent = readOptional(path.join(RULES_DIR, 'team.md'));
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

  // Core memory / user model snapshot (context) and session recap are both
  // injected by hooks/session-start.cjs, reading directly from memory.sqlite.
  // This keeps them always fresh with no intermediate file.

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

  return parts.join('\n\n');
}

/**
 * Build injection content for Pool B (Bridge sessions — Worker / Sub / Maintenance).
 *
 * Only common sections are included. Lead-only sections (channels, team,
 * user-workflow, Models) live in Pool A and are excluded here so the Pool B
 * prefix stays bit-identical across every Bridge role.
 *
 * Included:
 *   - rules/memory.md       (when memory enabled)
 *   - rules/search.md       (when search enabled)
 *   - Common MD             (user-editable text from data/common.md, new in v0.6.47)
 *   - history/user.md       (user persona)
 *   - history/bot.md        (bot persona)
 *   - User: <name> (<title>)
 *
 * Explicitly excluded (stay in Pool A via buildInjectionContent):
 *   - rules/user-workflow.md, rules/channels.md, rules/team.md
 *   - # Models block (agent-config presets)
 *   - ## User Rules (role→preset mapping)
 *
 * @param {object} opts
 * @param {string} opts.PLUGIN_ROOT — absolute path to the plugin root
 * @param {string} opts.DATA_DIR    — absolute path to the plugin data dir
 * @returns {string} joined content (parts joined with '\n\n')
 */
function buildBridgeInjectionContent({ PLUGIN_ROOT, DATA_DIR }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const HISTORY_DIR = path.join(DATA_DIR, 'history');
  const memoryConfig = readJson(path.join(DATA_DIR, 'memory-config.json'));
  const searchConfig = readJson(path.join(DATA_DIR, 'search-config.json'));
  const parts = [];

  // Per design spec §3.3, Pool B order:
  //   1. MCP instructions
  //   2. Common MD (data/common.md)
  //   3. rules/memory.md
  //   4. rules/search.md
  //   5. CLAUDE.md common sections (whitelist: Core Rules / Writing /
  //      Non-negotiable / # Tone)
  //   6. profile rendered as "User: <name> (<title>)"
  // Everything the Bridge should not see (Channels / Team / Models / User
  // Rules / Workflow / Memory ops) is filtered at step 5. Pool A still gets
  // the full surface via buildInjectionContent + Claude Code auto-load.

  const mcpInstructions = readOptional(path.join(RULES_DIR, 'mcp.md'));
  if (mcpInstructions) parts.push(mcpInstructions);

  const commonContent = readOptional(path.join(DATA_DIR, 'common.md'));
  if (commonContent) parts.push(commonContent);

  if (memoryConfig.enabled) {
    const memory = readOptional(path.join(RULES_DIR, 'memory.md'));
    if (memory) parts.push(memory);
  }

  if (searchConfig.enabled) {
    const search = readOptional(path.join(RULES_DIR, 'search.md'));
    if (search) parts.push(search);
  }

  const userClaudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const claudeMdCommon = extractCommonClaudeMdSections(readOptional(userClaudeMdPath));
  if (claudeMdCommon) parts.push(claudeMdCommon);

  const userProfileContent = readOptional(path.join(HISTORY_DIR, 'user.md'));
  if (userProfileContent) parts.push(userProfileContent);

  const botContent = readOptional(path.join(HISTORY_DIR, 'bot.md'));
  if (botContent) parts.push(botContent);

  const userName = (memoryConfig.user && memoryConfig.user.name || '').trim();
  const userTitle = (memoryConfig.user && memoryConfig.user.title || '').trim();
  if (userName) {
    parts.push(userTitle ? `User: ${userName} (${userTitle})` : `User: ${userName}`);
  }

  return parts.join('\n\n');
}

module.exports = { buildInjectionContent, buildBridgeInjectionContent };
