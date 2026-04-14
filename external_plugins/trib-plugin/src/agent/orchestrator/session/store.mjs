/**
 * File-based session store.
 * Sessions are saved to disk so CLI and MCP server can share state,
 * and sessions survive server restarts (resume).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { getPluginData } from '../config.mjs';
function getStoreDir() {
    const dir = join(getPluginData(), 'sessions');
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return dir;
}
function sessionPath(id) {
    return join(getStoreDir(), `${id}.json`);
}
/** Module-level map tracking in-flight saves per session ID to prevent concurrent write corruption. */
const _savePending = new Map();

export function saveSession(session) {
    const id = session.id;
    if (_savePending.get(id)) {
        // A save for this session is already in progress — queue the latest state.
        // We store the session object; when the current write finishes it will
        // pick up the queued value and write again.
        _savePending.set(id, { queued: session });
        return;
    }
    _savePending.set(id, { writing: true });
    _doSave(session);
}

function _doSave(session) {
    const id = session.id;
    const target = sessionPath(id);
    const tmp = target + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
        writeFileSync(tmp, JSON.stringify(session), 'utf-8');
        renameSync(tmp, target);
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
        _savePending.delete(id);
        throw err;
    }
    // Check if another save was queued while we were writing
    const pending = _savePending.get(id);
    if (pending && pending.queued) {
        const next = pending.queued;
        _savePending.set(id, { writing: true });
        _doSave(next);
    } else {
        _savePending.delete(id);
    }
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
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes idle

export function listStoredSessions(ttlMs) {
    const maxAge = ttlMs || DEFAULT_SESSION_TTL_MS;
    const dir = getStoreDir();
    if (!existsSync(dir))
        return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const sessions = [];
    const now = Date.now();
    for (const f of files) {
        try {
            const session = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
            if (now - (session.updatedAt || session.createdAt || 0) > maxAge) {
                try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
                continue;
            }
            sessions.push(session);
        }
        catch { /* skip corrupt */ }
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Proactive sweep: delete session files idle longer than ttlMs.
 * Returns { cleaned, remaining, details } for logging.
 */
export function sweepStaleSessions(ttlMs) {
    const maxAge = ttlMs || DEFAULT_SESSION_TTL_MS;
    const dir = getStoreDir();
    if (!existsSync(dir))
        return { cleaned: 0, remaining: 0, details: [] };
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const now = Date.now();
    let cleaned = 0;
    let remaining = 0;
    const details = [];
    for (const f of files) {
        try {
            const session = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
            const lastActive = session.updatedAt || session.createdAt || 0;
            if (now - lastActive > maxAge) {
                try { unlinkSync(join(dir, f)); } catch { continue; }
                cleaned++;
                details.push({
                    id: session.id,
                    owner: session.owner || 'unknown',
                    idleMinutes: Math.round((now - lastActive) / 60000),
                });
            } else {
                remaining++;
            }
        }
        catch { /* skip corrupt */ }
    }
    return { cleaned, remaining, details };
}
