#!/usr/bin/env node
/**
 * SessionStart hook — clear active session pointer + reset memory boot timestamp.
 * Fires on: new session, /clear, /resume.
 * Stored sessions on disk are NOT deleted — only the pointer is cleared.
 */
import { unlinkSync, existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import http from 'http';

function resolveDataDir() {
    if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (root) {
        const pluginName = basename(root);
        const marketplace = basename(join(root, '..', '..'));
        return join(homedir(), '.claude', 'plugins', 'data', `${pluginName}-${marketplace}`);
    }
    return join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin');
}

const dataDir = resolveDataDir();

// 1. Clear active session pointer
try {
    const p = join(dataDir, 'active-session.txt');
    if (existsSync(p)) unlinkSync(p);
} catch {}

// 2. Signal memory server to reset boot timestamp (best-effort, non-blocking)
try {
    const portFile = join(homedir(), '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin', 'runtime', 'memory-port');
    if (existsSync(portFile)) {
        const port = Number(readFileSync(portFile, 'utf8').trim());
        if (port > 0) {
            const req = http.request({ hostname: '127.0.0.1', port, path: '/session-reset', method: 'POST' }, () => {});
            req.on('error', () => {}); // ignore — server may not be up yet
            req.end();
        }
    }
} catch {}

process.exit(0);
