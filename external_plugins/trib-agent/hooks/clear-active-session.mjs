#!/usr/bin/env node
/**
 * SessionStart hook — clear the active orchestrator session pointer.
 * Each Claude Code session starts fresh; users opt back in via /trib-agent:resume
 * or /trib-agent:new (or simply call /trib-agent:ask to auto-create).
 *
 * Stored sessions on disk are NOT deleted — only the pointer is cleared.
 */
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

try {
    const dir = process.env.CLAUDE_PLUGIN_DATA
        || join(homedir(), '.config', 'trib-orchestrator');
    const path = join(dir, 'active-session.txt');
    if (existsSync(path)) unlinkSync(path);
} catch {
    // best-effort, never fail the session start
}
process.exit(0);
