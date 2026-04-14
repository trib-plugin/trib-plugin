'use strict';

/**
 * trib-plugin unified SessionStart hook
 *
 * Two injection layers:
 *   1. Static rules (workflow/team/memory/etc.)
 *        - claude_md mode: MCP server writes them into CLAUDE.md
 *        - hook mode: this hook emits them via additionalContext
 *   2. Session recap (latest N episodes from memory.sqlite)
 *        - Always emitted by this hook via additionalContext — read
 *          directly from the DB so content is always fresh, with
 *          no intermediate file and no race with the MCP boot writer.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

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


function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

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

// --- Read memory.sqlite (shared helper, fail-soft) ---
function openMemoryDb() {
  try {
    const dbPath = path.join(DATA_DIR, 'memory.sqlite');
    if (!fs.existsSync(dbPath)) return null;
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    process.stderr.write(`[session-start] open memory.sqlite failed: ${e.message}\n`);
    return null;
  }
}

// --- Build context (core memory + user model) directly from sqlite ---
function buildContext() {
  let db = null;
  try {
    db = openMemoryDb();
    if (!db) return '';
    const parts = [];

    const coreItems = db.prepare(`
      SELECT topic, element
      FROM core_memory
      WHERE status = 'active'
      ORDER BY final_score DESC, mention_count DESC
    `).all();
    if (coreItems.length > 0) {
      const lines = coreItems.map(r => `- ${r.topic} — ${r.element}`);
      parts.push(`## Core Memory\n${lines.join('\n')}`);
    }

    const userModel = db.prepare(`
      SELECT category, hypothesis, confidence
      FROM user_model
      WHERE status = 'active' AND confidence >= 0.5
      ORDER BY confidence DESC
    `).all();
    if (userModel.length > 0) {
      const lines = userModel.map(m =>
        `- [${m.category}] ${m.hypothesis} (confidence: ${Number(m.confidence).toFixed(2)})`
      );
      parts.push(`## User Model\n${lines.join('\n')}`);
    }

    return parts.join('\n\n').trim();
  } catch (e) {
    process.stderr.write(`[session-start] context build failed: ${e.message}\n`);
    return '';
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

// --- Build session recap directly from memory.sqlite ---
function buildRecap() {
  let db = null;
  try {
    const memCfg = readJson(path.join(DATA_DIR, 'memory-config.json'));
    const recapCfg = memCfg.sessionRecap || {};
    if (recapCfg.enabled === false) return '';
    const limit = recapCfg.limit || 20;

    db = openMemoryDb();
    if (!db) return '';

    const rows = db.prepare(`
      SELECT e.ts, e.role, e.content AS episode_content,
             c.classification, c.topic, c.element, c.state
      FROM episodes e
      LEFT JOIN classifications c ON c.episode_id = e.id AND c.status = 'active'
      WHERE e.kind IN ('message', 'turn')
      ORDER BY e.ts DESC, e.id DESC
      LIMIT ?
    `).all(limit);

    const lines = rows.map(r => {
      const ts = String(r.ts || '').slice(0, 16);
      if (r.topic) {
        const cls = [r.classification, r.topic, r.element, r.state].filter(Boolean).join(' | ');
        return `[${ts}] ${cls.slice(0, 500)}`;
      }
      const prefix = r.role === 'user' ? 'u' : 'a';
      return `[${ts}] ${prefix}: ${cleanText(String(r.episode_content)).slice(0, 300)}`;
    });
    const text = lines.join('\n');
    return text.length > 20 ? '## Session Recap\n\n' + text : '';
  } catch (e) {
    process.stderr.write(`[session-start] recap build failed: ${e.message}\n`);
    return '';
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

// Mirrors src/memory/lib/memory-extraction.mjs#cleanMemoryText so recap output
// stays consistent with what the memory worker would produce.
function cleanText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<memory-context>[\s\S]*?<\/memory-context>/gi, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, '')
    .replace(/<tool-use-id>[\s\S]*?<\/tool-use-id>/gi, '')
    .replace(/<output-file>[\s\S]*?<\/output-file>/gi, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<schedule-context>[\s\S]*?<\/schedule-context>/gi, '')
    .replace(/<teammate-message[\s\S]*?<\/teammate-message>/gi, '')
    .replace(/<channel[^>]*>\n?([\s\S]*?)\n?<\/channel>/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^This session is being continued from a previous conversation[\s\S]*?(?=\n\n|$)/gim, '')
    .replace(/^\s*●\s.*$/gm, '')
    .replace(/^\s*Ran .*$/gm, '')
    .replace(/^\s*Command: .*$/gm, '')
    .replace(/^\s*Process exited .*$/gm, '')
    .replace(/^\s*Full transcript available at: .*$/gm, '')
    .replace(/<\/?[a-z][-a-z]*(?:\s[^>]*)?\/?>/gi, '')
    .replace(/[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// --- Build additionalContext ---
const mainConfig = readJson(path.join(DATA_DIR, 'config.json'));
const claudeMdMode = mainConfig.promptInjection && mainConfig.promptInjection.mode === 'claude_md';

let additionalContext = '';

if (!claudeMdMode) {
  // Hook mode: rules-builder provides the static rules too
  try {
    const { buildInjectionContent } = require(path.join(PLUGIN_ROOT, 'lib', 'rules-builder.cjs'));
    additionalContext = buildInjectionContent({ PLUGIN_ROOT, DATA_DIR }) || '';
  } catch {}
}

const blocks = [additionalContext, buildContext(), buildRecap()].filter(Boolean);
additionalContext = blocks.join('\n\n');

if (additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
}
