'use strict';

/**
 * trib-plugin rules builder.
 *
 * Builds the injection content string that either the SessionStart hook
 * (hook mode) or the MCP boot-time writer (claude_md mode) uses.
 *
 * Pool A injection order (lead):
 *   1.  general.md        (rules/general.md)
 *   2.  memory.md         (when memory-config.json has enabled)
 *   3.  search.md         (when search-config.json has enabled)
 *   4.  channels.md       (rules/channels.md)
 *   5.  team.md           (rules/team.md)
 *   6.  workflow.md       (rules/workflow.md)
 *   7.  # Roles           (auto-rendered from DATA_DIR/user-workflow.json)
 *   8.  # User Workflow   (DATA_DIR/user-workflow.md — user customizations)
 *   9.  # User Profile    (history/user.md, auto-wrapped)
 *  10.  # Bot Persona     (history/bot.md, auto-wrapped)
 *  11.  User: <name>      (from memory-config.json)
 *
 * Core memory snapshot and session recap are injected separately by
 * hooks/session-start.cjs from memory.sqlite.
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
 * Stripped:
 *   1. The plugin-managed block (marker-delimited).
 *   2. Lead-only H1/H2 headings that must never reach a Bridge agent:
 *        H1: # Memory, # Channels, # Search, # Team, # Roles, # User Workflow
 *        H2: ## Workflow, ## User Rules  (legacy; kept for back-compat)
 *      Their entire section (heading + body down to the next same-or-higher
 *      heading) is removed.
 */
const CLAUDE_MD_EXCLUDE_H1 = new Set([
  '# General', '# Memory', '# Channels', '# Search', '# Team',
  '# Workflow', '# Roles', '# User Workflow',
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
 * Build the Pool A injection content (Lead).
 *
 * @param {object} opts
 * @param {string} opts.PLUGIN_ROOT — absolute path to the plugin root
 * @param {string} opts.DATA_DIR    — absolute path to the plugin data dir
 * @returns {string} joined injection content (parts joined with '\n\n')
 */
function buildInjectionContent({ PLUGIN_ROOT, DATA_DIR }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const HISTORY_DIR = path.join(DATA_DIR, 'history');

  const memoryConfig = readJson(path.join(DATA_DIR, 'memory-config.json'));
  const searchConfig = readJson(path.join(DATA_DIR, 'search-config.json'));
  const parts = [];

  // --- 1. General (always) ---
  const general = readOptional(path.join(RULES_DIR, 'general.md'));
  if (general) parts.push(general);

  // --- 2. Memory (when memory-config.json has enabled) ---
  if (memoryConfig.enabled) {
    const memory = readOptional(path.join(RULES_DIR, 'memory.md'));
    if (memory) parts.push(memory);
  }

  // --- 3. Search (when search-config.json has enabled) ---
  if (searchConfig.enabled) {
    const search = readOptional(path.join(RULES_DIR, 'search.md'));
    if (search) parts.push(search);
  }

  // --- 4. Channels (always) ---
  const channels = readOptional(path.join(RULES_DIR, 'channels.md'));
  if (channels) parts.push(channels);

  // --- 5. Team (always) ---
  const team = readOptional(path.join(RULES_DIR, 'team.md'));
  if (team) parts.push(team);

  // --- 6. Workflow (always) ---
  const workflow = readOptional(path.join(RULES_DIR, 'workflow.md'));
  if (workflow) parts.push(workflow);

  // --- 7. Roles (auto-rendered from DATA_DIR/user-workflow.json) ---
  const userWorkflowJsonPath = path.join(DATA_DIR, 'user-workflow.json');
  let userWorkflow = { roles: [] };
  try {
    if (fs.existsSync(userWorkflowJsonPath)) {
      userWorkflow = JSON.parse(fs.readFileSync(userWorkflowJsonPath, 'utf8'));
    }
  } catch {}
  if (Array.isArray(userWorkflow.roles) && userWorkflow.roles.length > 0) {
    const roleLines = ['# Roles', ''];
    for (const role of userWorkflow.roles) {
      roleLines.push(`- ${role.name}: ${role.preset}`);
    }
    parts.push(roleLines.join('\n'));
  }

  // --- 8. User Workflow (DATA_DIR/user-workflow.md — user customizations) ---
  const userWorkflowMdPath = path.join(DATA_DIR, 'user-workflow.md');
  const userWorkflowMd = readOptional(userWorkflowMdPath);
  if (userWorkflowMd) {
    const startsWithHeader = /^#\s+User Workflow/i.test(userWorkflowMd);
    parts.push(startsWithHeader ? userWorkflowMd : `# User Workflow\n\n${userWorkflowMd}`);
  }

  // --- 9. User Profile (Pool A only — history/user.md wrapped with H1) ---
  const userProfile = readOptional(path.join(HISTORY_DIR, 'user.md'));
  if (userProfile) parts.push(`# User Profile\n\n${userProfile}`);

  // --- 10. Bot Persona (Pool A only — history/bot.md wrapped with H1) ---
  const botPersona = readOptional(path.join(HISTORY_DIR, 'bot.md'));
  if (botPersona) parts.push(`# Bot Persona\n\n${botPersona}`);

  // --- 11. User name & title (from memory-config.json) ---
  const userName = (memoryConfig.user && memoryConfig.user.name || '').trim();
  const userTitle = (memoryConfig.user && memoryConfig.user.title || '').trim();
  if (userName) {
    parts.push(userTitle ? `User: ${userName} (${userTitle})` : `User: ${userName}`);
  }

  return parts.join('\n\n');
}

/**
 * Build the Pool B injection content (Bridge sessions — Worker / Sub / Maintenance).
 *
 * Included:
 *   - MCP instructions (rules/mcp-*.md)
 *   - Agent MD (rules/agent.md, plugin-fixed Pool B rules)
 *   - rules/memory.md (when memory enabled)
 *   - rules/search.md (when search enabled)
 *   - CLAUDE.md common sections (user-authored custom sections outside the
 *     managed block and outside the Lead-only H1/H2 blacklist)
 *   - User: <name> (<title>)
 *
 * Explicitly excluded (Pool A only):
 *   - rules/general.md / rules/channels.md / rules/team.md / rules/workflow.md
 *   - # Roles / # User Workflow
 *   - # User Profile / # Bot Persona
 *
 * @param {object} opts
 * @param {string} opts.PLUGIN_ROOT — absolute path to the plugin root
 * @param {string} opts.DATA_DIR    — absolute path to the plugin data dir
 * @returns {string} joined content (parts joined with '\n\n')
 */
function buildBridgeInjectionContent({ PLUGIN_ROOT, DATA_DIR }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const memoryConfig = readJson(path.join(DATA_DIR, 'memory-config.json'));
  const searchConfig = readJson(path.join(DATA_DIR, 'search-config.json'));
  const parts = [];

  const mcpBlocks = ['mcp-orchestration.md', 'mcp-memory.md', 'mcp-search.md']
    .map(f => readOptional(path.join(RULES_DIR, f)))
    .filter(Boolean);
  if (mcpBlocks.length > 0) {
    parts.push(['# MCP Instructions', '', mcpBlocks.join('\n\n')].join('\n'));
  }

  const agentContent = readOptional(path.join(RULES_DIR, 'agent.md'));
  if (agentContent) parts.push(agentContent);

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

  const userName = (memoryConfig.user && memoryConfig.user.name || '').trim();
  const userTitle = (memoryConfig.user && memoryConfig.user.title || '').trim();
  if (userName) {
    parts.push(userTitle ? `User: ${userName} (${userTitle})` : `User: ${userName}`);
  }

  return parts.join('\n\n');
}

module.exports = { buildInjectionContent, buildBridgeInjectionContent };
