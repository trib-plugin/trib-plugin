'use strict';

/**
 * trib-plugin unified SessionStart hook
 *
 * Reads rules/*.md files and profile data, injects as additionalContext.
 *
 * Content is built by lib/rules-builder.cjs so that the MCP boot-time
 * writer (claude_md mode) and this hook (hook mode) produce identical
 * output.
 *
 * If config.promptInjection.mode === 'claude_md', this hook becomes a
 * no-op — the block is written directly into CLAUDE.md by the MCP
 * server at boot, giving the content OVERRIDE-level enforcement.
 *
 * Injection order (see lib/rules-builder.cjs):
 *   1. workflow.md   (always)
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

// --- Ensure team exists (reuse or create) ---
try {
  const os = require('os');
  const TEAMS_ROOT = path.join(os.homedir(), '.claude', 'teams');
  const TASKS_ROOT = path.join(os.homedir(), '.claude', 'tasks');
  const TEAM_NAME = 'main';
  const teamDir = path.join(TEAMS_ROOT, TEAM_NAME);
  const tasksDir = path.join(TASKS_ROOT, TEAM_NAME);
  const configPath = path.join(teamDir, 'config.json');
  const sessionId = _event.session_id || _event.sessionId || '';

  fs.mkdirSync(teamDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.leadSessionId !== sessionId && sessionId) {
      config.leadSessionId = sessionId;
      config.members = (config.members || []).filter(m => m.agentType === 'team-lead');
      if (config.members[0]) config.members[0].cwd = _event.cwd || process.cwd();
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
  } else {
    fs.writeFileSync(configPath, JSON.stringify({
      name: TEAM_NAME,
      description: 'Default reusable team',
      createdAt: Date.now(),
      leadAgentId: `team-lead@${TEAM_NAME}`,
      leadSessionId: sessionId,
      members: [{
        agentId: `team-lead@${TEAM_NAME}`,
        name: 'team-lead',
        agentType: 'team-lead',
        joinedAt: Date.now(),
        tmuxPaneId: '',
        cwd: _event.cwd || process.cwd(),
        subscriptions: [],
      }],
    }, null, 2));
  }
} catch {}

// --- Mode branch: claude_md mode delegates to MCP boot-time writer ---
function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

const mainConfig = readJson(path.join(DATA_DIR, 'config.json'));
if (mainConfig.promptInjection && mainConfig.promptInjection.mode === 'claude_md') {
  // Managed block is written into CLAUDE.md by the MCP server at boot.
  // No hook-level injection in this mode.
  process.exit(0);
}

// --- Hook mode: build content and emit as additionalContext ---
let buildInjectionContent;
try {
  ({ buildInjectionContent } = require(path.join(PLUGIN_ROOT, 'lib', 'rules-builder.cjs')));
} catch {
  // Builder not available — exit quietly rather than breaking the session.
  process.exit(0);
}

const additionalContext = buildInjectionContent({ PLUGIN_ROOT, DATA_DIR });
if (additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
}
