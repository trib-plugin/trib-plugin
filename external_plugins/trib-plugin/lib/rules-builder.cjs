'use strict';

/**
 * trib-plugin rules builder (pure function extracted from hooks/session-start.cjs).
 *
 * Builds the injection content string that either the SessionStart hook
 * (hook mode) or the MCP boot-time writer (claude_md mode) uses.
 *
 * Injection order (must match hooks/session-start.cjs exactly):
 *   1. workflow.md   (always)
 *   1a. user workflow (scopes from agent-config.json + description from user-workflow.md)
 *   2. memory.md     (when memory-config.json has enabled)
 *   3. channels.md   (when channel backend configured)
 *   4. search.md     (when search-config.json has enabled)
 *   5. team.md       (always)
 *   6. models        (from agent-config.json presets)
 *   7. context.md    (auto-generated core memory snapshot)
 *   8. user.md       (user profile)
 *   9. bot.md        (bot persona)
 *  10. user name     (from memory-config.json user.name)
 *  11. user title    (from memory-config.json user.title)
 */

const fs = require('fs');
const path = require('path');

function readOptional(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
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
  const workflow = readOptional(path.join(RULES_DIR, 'workflow.md'));
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
  const wfLines = ['## User Workflow', ''];
  if (wfDescription) wfLines.push(wfDescription, '');
  if (Array.isArray(userWorkflow.roles) && userWorkflow.roles.length > 0) {
    const agentCfg = readJson(path.join(DATA_DIR, 'agent-config.json'));
    const typeMap = {};
    if (Array.isArray(agentCfg.presets)) {
      for (const p of agentCfg.presets) typeMap[p.id] = p.type || 'native';
    }
    wfLines.push('Roles:');
    for (const role of userWorkflow.roles) {
      const label = (typeMap[role.preset] || 'native') === 'bridge' ? 'Bridge' : 'Native';
      wfLines.push(`- ${role.name} → ${role.preset} (${label})`);
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

  // --- 7. Context (auto-generated core memory snapshot) ---
  const contextContent = readOptional(path.join(HISTORY_DIR, 'context.md'));
  if (contextContent) parts.push(contextContent);

  // --- 7a. Session recap (previous session summary) ---
  const recapContent = readOptional(path.join(HISTORY_DIR, 'session-recap.md'));
  if (recapContent) parts.push('## Session Recap\n\n' + recapContent);

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

module.exports = { buildInjectionContent };
