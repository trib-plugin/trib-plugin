'use strict';

const fs = require('fs');
const path = require('path');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
if (!pluginRoot) process.exit(0);

const agentsSource = path.join(pluginRoot, 'agents');
const agentsTarget = path.join(require('os').homedir(), '.claude', 'agents');

if (!fs.existsSync(agentsSource)) process.exit(0);

fs.mkdirSync(agentsTarget, { recursive: true });

for (const file of fs.readdirSync(agentsSource)) {
  if (!file.endsWith('.md')) continue;
  const src = path.join(agentsSource, file);
  const dst = path.join(agentsTarget, file);
  fs.copyFileSync(src, dst);
}
