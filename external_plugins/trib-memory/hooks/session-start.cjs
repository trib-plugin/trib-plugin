'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

let _event = {};
try {
  const _input = fs.readFileSync(0, 'utf8');
  if (_input) _event = JSON.parse(_input);
} catch {}

if (_event.isSidechain) process.exit(0);
if (_event.agentId) process.exit(0);
if (_event.kind && _event.kind !== 'interactive') process.exit(0);

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const CONTEXT_FILE = path.join(DATA_DIR, 'history', 'context.md');
const PORT_FILE = path.join(os.tmpdir(), 'trib-memory', 'memory-port');

let contextContent = '';
try {
  contextContent = fs.readFileSync(CONTEXT_FILE, 'utf8').trim();
} catch {}

function respond(content) {
  if (!content) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: content
    }
  }));
}

// Find latest SESSION-*.md in project root
let sessionMd = '';
try {
  const projectDirs = [
    process.env.TRIB_MEMORY_WORKSPACE || '',
    path.join(os.homedir(), 'Project'),
  ].filter(Boolean);
  for (const dir of projectDirs) {
    try {
      const files = fs.readdirSync(dir)
        .filter(f => /^SESSION-\d{4}-\d{2}-\d{2}\.md$/i.test(f))
        .sort()
        .reverse();
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim();
        if (content.length > 50) {
          sessionMd = `## Previous Session\n${content.slice(0, 2000)}`;
          break;
        }
      }
    } catch {}
  }
} catch {}

// Try to fetch fresh Recent from HTTP service
let port;
try {
  port = fs.readFileSync(PORT_FILE, 'utf8').trim();
} catch {
  // Service not running — inject context.md + session md
  const merged = [contextContent, sessionMd].filter(Boolean).join('\n\n');
  respond(merged);
  process.exit(0);
}

const url = `http://localhost:${port}/recent`;
const req = http.get(url, { timeout: 5000 }, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    try {
      const data = JSON.parse(body);
      const recent = data.recent || '';
      const merged = [contextContent, recent, sessionMd].filter(Boolean).join('\n\n');
      respond(merged);
    } catch {
      const merged = [contextContent, sessionMd].filter(Boolean).join('\n\n');
      respond(merged);
    }
  });
});
req.on('error', () => {
  const merged = [contextContent, sessionMd].filter(Boolean).join('\n\n');
  respond(merged);
});
req.on('timeout', () => {
  req.destroy();
  const merged = [contextContent, sessionMd].filter(Boolean).join('\n\n');
  respond(merged);
});
