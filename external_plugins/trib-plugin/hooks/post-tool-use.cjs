/**
 * trib-plugin PostToolUse hook
 *
 * Dual-purpose: resolves both the legacy file-based permission flow and the
 * new channel-notification-based flow.
 *
 * Legacy flow (file-based):
 *   1. PermissionRequest hook creates perm-{instance}-{uuid}.pending
 *   2. User approves in terminal → tool executes → this hook fires
 *   3. This hook writes perm-{instance}-{uuid}.resolved
 *   4. PermissionRequest hook's polling detects .resolved → updates Discord
 *
 * Channel-notification flow (new):
 *   1. CC sends notifications/claude/channel/permission_request to server.mjs
 *   2. server.mjs forwards to channels worker; worker posts Discord prompt
 *   3. User approves in terminal → tool executes → this hook fires
 *   4. This hook writes tool-exec-{ts}-{rand}.signal with { toolName }
 *   5. channels worker watches RUNTIME_ROOT, matches oldest pendingPermRequest
 *      by toolName, edits Discord message to "Allowed (terminal)"
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const RUNTIME_ROOT = path.join(os.tmpdir(), 'trib-plugin');

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  // Parse tool_name from hook stdin payload (PostToolUse sends JSON).
  let toolName = '';
  try {
    if (input) {
      const payload = JSON.parse(input);
      toolName = payload?.tool_name || payload?.toolName || '';
    }
  } catch { /* ignore parse errors */ }

  try {
    if (!fs.existsSync(RUNTIME_ROOT)) fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  } catch { /* best-effort */ }

  // Channel-notification flow: drop a signal file for the channels worker.
  if (toolName) {
    try {
      const rand = crypto.randomBytes(4).toString('hex');
      const signalFile = path.join(RUNTIME_ROOT, `tool-exec-${Date.now()}-${rand}.signal`);
      fs.writeFileSync(signalFile, JSON.stringify({ toolName, ts: Date.now() }));
    } catch (err) {
      process.stderr.write(`[post-tool-use] Failed to write signal file: ${err.message}\n`);
    }
  }

  // Legacy file-based flow: mark any recent .pending without .result as .resolved.
  try {
    const files = fs.readdirSync(RUNTIME_ROOT);
    const pendingFiles = files.filter(f => f.startsWith('perm-') && f.endsWith('.pending'));

    for (const pf of pendingFiles) {
      const base = pf.replace('.pending', '');
      const resultFile = path.join(RUNTIME_ROOT, base + '.result');
      const resolvedFile = path.join(RUNTIME_ROOT, base + '.resolved');

      if (fs.existsSync(resultFile)) continue;
      if (fs.existsSync(resolvedFile)) continue;

      try {
        const stat = fs.statSync(path.join(RUNTIME_ROOT, pf));
        if (Date.now() - stat.mtimeMs > 15 * 60 * 1000) continue;
      } catch { continue; }

      try {
        fs.writeFileSync(resolvedFile, String(Date.now()));
      } catch (err) {
        process.stderr.write(`[post-tool-use] Failed to write ${resolvedFile}: ${err.message}\n`);
        try {
          fs.writeFileSync(resolvedFile, String(Date.now()));
        } catch (retryErr) {
          process.stderr.write(`[post-tool-use] Retry also failed for ${resolvedFile}: ${retryErr.message}\n`);
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[post-tool-use] Outer error: ${err.message}\n`);
  }
  process.exit(0);
});
