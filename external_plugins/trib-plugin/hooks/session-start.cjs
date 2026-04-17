'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

let _event = {};
try {
  const _input = fs.readFileSync(0, 'utf8');
  if (_input) _event = JSON.parse(_input);
} catch {}

if (_event.isSidechain) process.exit(0);
if (_event.agentId) process.exit(0);
if (_event.kind && _event.kind !== 'interactive') process.exit(0);

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
if (!DATA_DIR || !PLUGIN_ROOT) process.exit(0);

// Clear active orchestrator session pointer (merged from clear-active-session.mjs)
try {
  const asp = path.join(DATA_DIR, 'active-session.txt');
  if (fs.existsSync(asp)) fs.unlinkSync(asp);
} catch {}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

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

function formatTs(ts) {
  const n = Number(ts);
  if (Number.isFinite(n) && n > 1e12) {
    return new Date(n).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16) + ' KST';
  }
  return String(ts ?? '').slice(0, 16);
}

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

function buildContext(db) {
  try {
    const rows = db.prepare(`
      SELECT element, category, summary
      FROM entries
      WHERE is_root = 1 AND status = 'active'
      ORDER BY score DESC, last_seen_at DESC
    `).all();
    if (rows.length === 0) return '';
    const lines = rows.map(r => {
      const cat = r.category ? `[${r.category}] ` : '';
      const element = r.element ?? '';
      const summary = r.summary ?? '';
      return `- ${cat}${element}${summary ? ' — ' + summary : ''}`;
    });
    return `## Core Memory\n${lines.join('\n')}`;
  } catch (e) {
    process.stderr.write(`[session-start] context build failed: ${e.message}\n`);
    return '';
  }
}

function buildRecap(db) {
  try {
    const rows = db.prepare(`
      SELECT id, ts, role, content, chunk_root, is_root,
             element, category, summary
      FROM entries
      ORDER BY ts DESC, id DESC
      LIMIT 20
    `).all();
    if (rows.length === 0) return '';
    const lines = rows.map(r => {
      const tsStr = formatTs(r.ts);
      if (r.is_root === 1) {
        const cat = r.category ? `[${r.category}] ` : '';
        const element = r.element ?? '';
        const summary = r.summary ?? '';
        const combined = `${cat}${element}${summary ? ' — ' + summary : ''}`;
        return `[${tsStr}] ${combined.slice(0, 1000)}`;
      }
      const prefix = r.role === 'user' ? 'u' : r.role === 'assistant' ? 'a' : (r.role || '?');
      return `[${tsStr}] ${prefix}: ${cleanText(String(r.content || '')).slice(0, 1000)}`;
    });
    const text = lines.reverse().join('\n');
    return text.length > 20 ? '## Session Recap\n\n' + text : '';
  } catch (e) {
    process.stderr.write(`[session-start] recap build failed: ${e.message}\n`);
    return '';
  }
}

function buildMemoryBlocks() {
  let db = null;
  try {
    db = openMemoryDb();
    if (!db) return { context: '', recap: '' };
    return { context: buildContext(db), recap: buildRecap(db) };
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

const mainConfig = readJson(path.join(DATA_DIR, 'config.json'));
const claudeMdMode = mainConfig.promptInjection && mainConfig.promptInjection.mode === 'claude_md';

let additionalContext = '';

if (!claudeMdMode) {
  try {
    const { buildInjectionContent } = require(path.join(PLUGIN_ROOT, 'lib', 'rules-builder.cjs'));
    additionalContext = buildInjectionContent({ PLUGIN_ROOT, DATA_DIR }) || '';
  } catch {}
}

const memoryBlocks = buildMemoryBlocks();
const blocks = [additionalContext, memoryBlocks.context, memoryBlocks.recap].filter(Boolean);
additionalContext = blocks.join('\n\n');

if (additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
}
