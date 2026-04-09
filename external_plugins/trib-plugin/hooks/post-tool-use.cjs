/**
 * trib-channels PostToolUse hook
 * When a tool finishes execution, resolve any pending permission request
 * so the PermissionRequest hook can update the Discord message.
 *
 * Flow:
 * 1. PermissionRequest hook creates perm-{instance}-{uuid}.pending
 * 2. User approves in terminal → tool executes → this hook fires
 * 3. This hook writes perm-{instance}-{uuid}.resolved
 * 4. PermissionRequest hook's polling detects .resolved → updates Discord
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = path.join(os.tmpdir(), 'trib-channels');

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    // Find all .pending files that don't have a matching .result or .resolved
    const files = fs.readdirSync(RUNTIME_ROOT);
    const pendingFiles = files.filter(f => f.startsWith('perm-') && f.endsWith('.pending'));

    for (const pf of pendingFiles) {
      const base = pf.replace('.pending', '');
      const resultFile = path.join(RUNTIME_ROOT, base + '.result');
      const resolvedFile = path.join(RUNTIME_ROOT, base + '.resolved');

      // Skip if already resolved via Discord button (.result exists)
      if (fs.existsSync(resultFile)) continue;
      // Skip if already resolved
      if (fs.existsSync(resolvedFile)) continue;

      // Check if pending file is recent (within last 15 minutes)
      try {
        const stat = fs.statSync(path.join(RUNTIME_ROOT, pf));
        if (Date.now() - stat.mtimeMs > 15 * 60 * 1000) continue;
      } catch { continue; }

      // Tool executed → permission was granted from terminal. Write .resolved.
      try {
        fs.writeFileSync(resolvedFile, String(Date.now()));
      } catch (err) {
        process.stderr.write(`[post-tool-use] Failed to write ${resolvedFile}: ${err.message}\n`);
        // Synchronous retry — one attempt
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
