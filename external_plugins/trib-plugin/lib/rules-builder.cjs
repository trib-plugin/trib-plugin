'use strict';

/**
 * trib-plugin rules builder.
 *
 * Builds the injection content string that either the SessionStart hook
 * (hook mode) or the MCP boot-time writer (claude_md mode) uses.
 *
 * Lead injection order:
 *   1.  general.md        (rules/lead/01-general.md)
 *   2.  tool.md           (rules/shared/01-tool.md)
 *   3.  memory.md         (rules/shared/02-memory.md — when memory-config.json enabled)
 *   4.  search.md         (rules/shared/03-search.md — when search-config.json enabled)
 *   5.  explore.md        (rules/shared/04-explore.md — always; internal file search)
 *   6.  lsp.md            (rules/shared/05-lsp.md — always; TS/JS semantic symbol lookup)
 *   7.  channels.md       (rules/lead/02-channels.md)
 *   8.  team.md           (rules/lead/03-team.md)
 *   9.  workflow.md       (rules/lead/04-workflow.md)
 *  10.  # Roles           (auto-rendered from DATA_DIR/user-workflow.json)
 *  11.  # User Workflow   (DATA_DIR/user-workflow.md — user customizations)
 *  12.  # User Profile    (history/user.md, auto-wrapped)
 *  13.  # Bot Persona     (history/bot.md, auto-wrapped)
 *  14.  User: <name>      (from memory-config.json)
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
  '# General', '# Memory', '# Channels', '# Search', '# Explore',
  '# Code Symbols (LSP)',
  '# Team', '# Workflow', '# Roles', '# User Workflow',
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
  const SHARED_DIR = path.join(RULES_DIR, 'shared');
  const LEAD_DIR = path.join(RULES_DIR, 'lead');
  const HISTORY_DIR = path.join(DATA_DIR, 'history');

  const memoryConfig = readJson(path.join(DATA_DIR, 'memory-config.json'));
  const searchConfig = readJson(path.join(DATA_DIR, 'search-config.json'));
  const parts = [];

  // --- 1. General (always) ---
  const general = readOptional(path.join(LEAD_DIR, '01-general.md'));
  if (general) parts.push(general);

  // --- 2. Tool routing / batching (always) ---
  const tool = readOptional(path.join(SHARED_DIR, '01-tool.md'));
  if (tool) parts.push(tool);

  // --- 3. Memory (when memory-config.json has enabled) ---
  if (memoryConfig.enabled) {
    const memory = readOptional(path.join(SHARED_DIR, '02-memory.md'));
    if (memory) parts.push(memory);
  }

  // --- 4. Search (when search-config.json has enabled) ---
  if (searchConfig.enabled) {
    const search = readOptional(path.join(SHARED_DIR, '03-search.md'));
    if (search) parts.push(search);
  }

  // --- 5. Explore (always — internal codebase search) ---
  const explore = readOptional(path.join(SHARED_DIR, '04-explore.md'));
  if (explore) parts.push(explore);

  // --- 6. LSP symbol tools (always — TS/JS semantic lookup) ---
  const lsp = readOptional(path.join(SHARED_DIR, '05-lsp.md'));
  if (lsp) parts.push(lsp);

  // --- 7. Channels (always) ---
  const channels = readOptional(path.join(LEAD_DIR, '02-channels.md'));
  if (channels) parts.push(channels);

  // --- 8. Team (always) ---
  const team = readOptional(path.join(LEAD_DIR, '03-team.md'));
  if (team) parts.push(team);

  // --- 9. Workflow (always) ---
  const workflow = readOptional(path.join(LEAD_DIR, '04-workflow.md'));
  if (workflow) parts.push(workflow);

  // --- 10. Roles (auto-rendered from DATA_DIR/user-workflow.json) ---
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

  // --- 11. User Workflow (DATA_DIR/user-workflow.md — user customizations) ---
  const userWorkflowMdPath = path.join(DATA_DIR, 'user-workflow.md');
  const userWorkflowMd = readOptional(userWorkflowMdPath);
  if (userWorkflowMd) {
    const startsWithHeader = /^#\s+User Workflow/i.test(userWorkflowMd);
    parts.push(startsWithHeader ? userWorkflowMd : `# User Workflow\n\n${userWorkflowMd}`);
  }

  // --- 12. User Profile (Lead only — history/user.md wrapped with H1) ---
  const userProfile = readOptional(path.join(HISTORY_DIR, 'user.md'));
  if (userProfile) parts.push(`# User Profile\n\n${userProfile}`);

  // --- 13. Bot Persona (Lead only — history/bot.md wrapped with H1) ---
  const botPersona = readOptional(path.join(HISTORY_DIR, 'bot.md'));
  if (botPersona) parts.push(`# Bot Persona\n\n${botPersona}`);

  // --- 14. User name & title (from memory-config.json) ---
  const userName = (memoryConfig.user && memoryConfig.user.name || '').trim();
  const userTitle = (memoryConfig.user && memoryConfig.user.title || '').trim();
  if (userName) {
    parts.push(userTitle ? `User: ${userName} (${userTitle})` : `User: ${userName}`);
  }

  return parts.join('\n\n');
}

/**
 * Build the bridge injection content (Worker / Sub / Maintenance sessions).
 *
 * Included:
 *   - rules/shared/01-tool.md
 *   - rules/shared/02-memory.md (when memory enabled)
 *   - rules/shared/03-search.md (when search enabled)
 *   - rules/shared/04-explore.md (always; internal file search)
 *   - rules/shared/05-lsp.md (always; TS/JS semantic symbol lookup)
 *   - rules/bridge/00-common.md
 *   - User: <name> (<title>)
 *
 * Explicitly excluded (Lead only):
 *   - rules/lead/*
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
  const SHARED_DIR = path.join(RULES_DIR, 'shared');
  const BRIDGE_DIR = path.join(RULES_DIR, 'bridge');
  const memoryConfig = readJson(path.join(DATA_DIR, 'memory-config.json'));
  const searchConfig = readJson(path.join(DATA_DIR, 'search-config.json'));
  const parts = [];

  const tool = readOptional(path.join(SHARED_DIR, '01-tool.md'));
  if (tool) parts.push(tool);

  if (memoryConfig.enabled) {
    const memory = readOptional(path.join(SHARED_DIR, '02-memory.md'));
    if (memory) parts.push(memory);
  }

  if (searchConfig.enabled) {
    const search = readOptional(path.join(SHARED_DIR, '03-search.md'));
    if (search) parts.push(search);
  }

  const explore = readOptional(path.join(SHARED_DIR, '04-explore.md'));
  if (explore) parts.push(explore);

  const lsp = readOptional(path.join(SHARED_DIR, '05-lsp.md'));
  if (lsp) parts.push(lsp);

  const common = readOptional(path.join(BRIDGE_DIR, '00-common.md'));
  if (common) parts.push(common);

  // User-defined agent customizations (monolithic — all roles/schedules/webhooks
  // baked into the cached prefix). The active per-call task data lives in the
  // tail (user message, "# role\n<name>" header from composeSystemPrompt), not
  // here. This keeps cache shard count at 1 across every Pool B caller in the
  // workspace — each role differs only by its short tier3 header, not by the
  // shared system prefix.
  //
  // roles/ is flat (<role>.md). schedules/ and webhooks/ are keyed by name
  // with a nested prompt.md / instructions.md inside each entry, so we walk
  // the tree recursively instead of only listing the top level.
  for (const subdir of ['roles', 'schedules', 'webhooks']) {
    const dir = path.join(DATA_DIR, subdir);
    const collected = [];
    try {
      const stack = [dir];
      while (stack.length) {
        const current = stack.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.isFile() && entry.name.endsWith('.md')) collected.push(full);
        }
      }
    } catch { continue; }
    if (collected.length === 0) continue;
    collected.sort();
    const blocks = collected.map(f => readOptional(f)).filter(Boolean);
    if (blocks.length === 0) continue;
    parts.push([`# Agent ${subdir}`, '', blocks.join('\n\n')].join('\n'));
  }

  const userName = (memoryConfig.user && memoryConfig.user.name || '').trim();
  const userTitle = (memoryConfig.user && memoryConfig.user.title || '').trim();
  if (userName) {
    parts.push(userTitle ? `User: ${userName} (${userTitle})` : `User: ${userName}`);
  }

  return parts.join('\n\n');
}

module.exports = {
  buildInjectionContent,
  buildBridgeInjectionContent,
};
