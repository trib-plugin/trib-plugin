'use strict';

const fs = require('fs');
const path = require('path');
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

let contextContent = '';
try {
  contextContent = fs.readFileSync(CONTEXT_FILE, 'utf8').trim();
} catch {}

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

const merged = [contextContent, sessionMd].filter(Boolean).join('\n\n');
if (merged) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: merged
    }
  }));
}
