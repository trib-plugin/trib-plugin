'use strict';
/**
 * PreToolUse hook — Discord permission flow for sub-agents.
 *
 * PermissionRequest hooks don't fire for sub-agents (Claude Code bug #23983).
 * This hook intercepts sub-agent Edit/Write calls to protected paths
 * (~/.claude/) and runs the same Discord approval flow.
 *
 * - Main session: exit 0 (PermissionRequest handles it)
 * - Sub-agent + non-protected: exit 0 (bypassPermissions handles it)
 * - Sub-agent + protected path: Discord approve/deny flow
 */
if (process.env.TRIB_CHANNELS_NO_CONNECT) process.exit(0);

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { shouldRoutePermissionToDiscord } = require('./lib/permission-route.cjs');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const RUNTIME_ROOT = path.join(os.tmpdir(), 'trib-plugin');
try { fs.mkdirSync(RUNTIME_ROOT, { recursive: true }); } catch {}
const ACTIVE_INSTANCE_FILE = path.join(RUNTIME_ROOT, 'active-instance.json');

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function readActiveInstance() {
  try { return JSON.parse(fs.readFileSync(ACTIVE_INSTANCE_FILE, 'utf8')); } catch { return null; }
}

// Fast bailout: no Discord config → skip
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
  const hasToken = !!(cfg && cfg.discord && cfg.discord.token);
  const mainCh = cfg && cfg.channelsConfig && cfg.channelsConfig.main;
  const channelId = mainCh && (typeof mainCh === 'string' ? null : mainCh.channelId);
  if (!hasToken || !channelId) process.exit(0);
} catch { process.exit(0); }

const POLL_INTERVAL = 2000;
const TIMEOUT = 900000; // 15 minutes

function discordApi(method, apiPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'discord.com', path: apiPath, method, headers },
      res => { let out = ''; res.on('data', d => { out += d; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({}); } }); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function isProtectedPath(filePath) {
  if (!filePath) return false;
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  return norm.includes('/.claude/');
}

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);

    // bypassPermissions → let it through without interruption
    const mode = data.permissionMode || data.permission_mode || data.mode;
    if (mode === 'bypassPermissions') process.exit(0);

    // Accept both camelCase (CC native) and snake_case (some payload shapes)
    // so the sub-agent detector doesn't silently drop either form.
    const isSidechain = data.isSidechain ?? data.is_sidechain;
    const agentIdRaw = data.agentId ?? data.agent_id;
    const toolInput = data.tool_input ?? data.toolInput ?? {};

    // Main session → skip (PermissionRequest hook handles it)
    const isSubagent = isSidechain === true || Boolean(agentIdRaw);
    if (!isSubagent) process.exit(0);
    const agentId = agentIdRaw || 'unknown';

    // Only intercept Edit/Write to protected paths
    const toolName = data.tool_name || '';
    if (toolName !== 'Edit' && toolName !== 'Write') process.exit(0);

    const filePath = toolInput.file_path || '';
    if (!isProtectedPath(filePath)) process.exit(0);

    // Route decision: owner terminal must be live AND reachable via HTTP
    // (or channel bridge flagged active) to send to Discord. Otherwise fall
    // through to Claude Code's built-in terminal prompt.
    const route = shouldRoutePermissionToDiscord();
    if (route.route !== 'discord') process.exit(0);

    // --- Sub-agent + protected path: Discord approval flow ---
    const configPath = path.join(DATA_DIR, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = config.discord && config.discord.token;
    if (!token) process.exit(0);
    const mainCh = config.channelsConfig && config.channelsConfig.main;
    const channelId = mainCh && (typeof mainCh === 'string' ? null : mainCh.channelId);
    if (!channelId) process.exit(0);

    const uuid = crypto.randomBytes(16).toString('hex');
    const active = readActiveInstance();
    if (!active || !active.instanceId) process.exit(0);
    const instanceId = sanitize(active.instanceId);
    const pendingFile = path.join(RUNTIME_ROOT, `perm-${instanceId}-${uuid}.pending`);
    const resultFile = path.join(RUNTIME_ROOT, `perm-${instanceId}-${uuid}.result`);

    // Build message
    let detail = '';
    if (toolName === 'Edit') {
      detail = filePath + '\n' + (toolInput.old_string || '').substring(0, 200);
    } else {
      detail = filePath;
    }
    const content = `🔐 **Sub-agent Permission**\nAgent: \`${agentId}\`\nTool: \`${toolName}\`\n\`\`\`\n${detail}\n\`\`\``;

    const body = {
      content,
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Allow', custom_id: 'perm-' + uuid + '-allow' },
          { type: 2, style: 1, label: 'Session Allow', custom_id: 'perm-' + uuid + '-session' },
          { type: 2, style: 4, label: 'Deny', custom_id: 'perm-' + uuid + '-deny' },
        ]
      }]
    };

    const msgResult = await discordApi('POST', '/api/v10/channels/' + channelId + '/messages', token, body);
    const messageId = msgResult.id;
    if (!messageId) process.exit(0); // Discord failed, fall back to terminal

    fs.writeFileSync(pendingFile, JSON.stringify({ uuid, messageId, channelId, toolName, agentId, createdAt: Date.now() }));

    // File-based signal for terminal resolution (Windows SIGTERM may not fire)
    const resolvedFile = path.join(RUNTIME_ROOT, `perm-${instanceId}-${uuid}.resolved`);

    // SIGTERM handler
    process.on('SIGTERM', async () => {
      try { fs.writeFileSync(resolvedFile, String(Date.now())); } catch {}
      try { fs.unlinkSync(pendingFile); } catch {}
      try { fs.unlinkSync(resultFile); } catch {}
      if (messageId) {
        await discordApi('PATCH', '/api/v10/channels/' + channelId + '/messages/' + messageId, token, {
          content: content + '\n\n↩️ Resolved from terminal.',
          components: []
        }).catch(() => {});
      }
      try { fs.unlinkSync(resolvedFile); } catch {}
      process.exit(0);
    });

    // Poll for decision
    const startTime = Date.now();
    while (Date.now() - startTime < TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));

      if (!fs.existsSync(pendingFile)) process.exit(0);

      // Terminal resolution via .resolved file (Windows support)
      if (fs.existsSync(resolvedFile)) {
        if (messageId) {
          await discordApi('PATCH', '/api/v10/channels/' + channelId + '/messages/' + messageId, token, {
            content: content + '\n\n↩️ Resolved from terminal.',
            components: []
          }).catch(() => {});
        }
        try { fs.unlinkSync(pendingFile); } catch {}
        try { fs.unlinkSync(resultFile); } catch {}
        try { fs.unlinkSync(resolvedFile); } catch {}
        process.exit(0);
      }

      if (fs.existsSync(resultFile)) {
        let decision;
        const result = fs.readFileSync(resultFile, 'utf8').trim();
        if (result === 'allow' || result === 'session') {
          decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', decision: 'allow' } };
        } else {
          decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', decision: 'deny', reason: 'Denied from Discord' } };
        }
        try { fs.unlinkSync(pendingFile); } catch {}
        try { fs.unlinkSync(resultFile); } catch {}
        process.stdout.write(JSON.stringify(decision));
        process.exit(0);
      }
    }

    // Timeout → deny
    if (messageId) {
      await discordApi('PATCH', '/api/v10/channels/' + channelId + '/messages/' + messageId, token, {
        content: content + '\n\n⚠️ Auto-denied due to timeout.',
        components: []
      });
    }
    try { fs.unlinkSync(pendingFile); } catch {}
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', decision: 'deny', reason: 'Timeout' } }));
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
