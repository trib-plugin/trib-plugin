/**
 * File-based session store.
 * Sessions are saved to disk so CLI and MCP server can share state,
 * and sessions survive server restarts (resume).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
function getStoreDir() {
    const dir = process.env.CLAUDE_PLUGIN_DATA
        ? join(process.env.CLAUDE_PLUGIN_DATA, 'sessions')
        : join(homedir(), '.config', 'trib-orchestrator', 'sessions');
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return dir;
}
function sessionPath(id) {
    return join(getStoreDir(), `${id}.json`);
}
export function saveSession(session) {
    writeFileSync(sessionPath(session.id), JSON.stringify(session), 'utf-8');
}
export function loadSession(id) {
    const path = sessionPath(id);
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
export function deleteSession(id) {
    const path = sessionPath(id);
    if (!existsSync(path))
        return false;
    try {
        unlinkSync(path);
        return true;
    }
    catch {
        return false;
    }
}
export function listStoredSessions() {
    const dir = getStoreDir();
    if (!existsSync(dir))
        return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const sessions = [];
    for (const f of files) {
        try {
            sessions.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')));
        }
        catch { /* skip corrupt */ }
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}
