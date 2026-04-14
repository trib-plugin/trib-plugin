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
 *   1. user-workflow.md (always)
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
const os = require('os');

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


// --- Mode branch: claude_md mode delegates to MCP boot-time writer ---
function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

// --- Trigger recap rebuild (fire-and-forget) ---
try {
  const http = require('http');
  const portFile = path.join(os.tmpdir(), 'trib-memory', 'memory-port');
  if (fs.existsSync(portFile)) {
    const port = Number(fs.readFileSync(portFile, 'utf8').trim());
    if (port > 0) {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/rebuild-recap',
        method: 'POST',
        timeout: 5000,
      });
      req.on('error', () => {});
      req.on('timeout', () => req.destroy());
      req.end();
    }
  }
} catch {}

// --- Trigger transcript rebind (fire-and-forget) ---
try {
  const activePath = path.join(os.tmpdir(), 'trib-plugin', 'active-instance.json');
  if (fs.existsSync(activePath)) {
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    if (active.httpPort) {
      const http2 = require('http');
      const req2 = http2.request({
        hostname: '127.0.0.1',
        port: active.httpPort,
        path: '/rebind',
        method: 'POST',
        timeout: 3000,
      });
      req2.on('error', () => {});
      req2.on('timeout', () => req2.destroy());
      req2.end();
    }
  }
} catch {}

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
