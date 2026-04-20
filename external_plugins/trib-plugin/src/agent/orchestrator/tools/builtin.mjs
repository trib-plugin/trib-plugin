import { exec, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, statSync, existsSync, createReadStream, readdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { promisify } from 'util';
const execAsync = promisify(exec);
import { resolve, normalize, isAbsolute, relative, dirname, basename, extname, join } from 'path';

function resolveShell() {
    if (process.platform !== 'win32') return { shell: '/bin/sh', shellArg: '-c' };
    const explicit = process.env.CLAUDE_CODE_SHELL;
    if (explicit && existsSync(explicit)) return { shell: explicit, shellArg: '-c' };
    const envShell = process.env.SHELL;
    if (envShell && (envShell.includes('bash') || envShell.includes('zsh')) && existsSync(envShell)) {
        return { shell: envShell, shellArg: '-c' };
    }
    const fallbacks = [
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
        'C:\\msys64\\usr\\bin\\bash.exe',
        'C:\\cygwin64\\bin\\bash.exe',
    ];
    for (const candidate of fallbacks) {
        if (existsSync(candidate)) return { shell: candidate, shellArg: '-c' };
    }
    return { shell: process.env.ComSpec || 'cmd.exe', shellArg: '/c' };
}

export function windowsPathToPosixPath(winPath) {
    if (typeof winPath !== 'string') return winPath;
    // UNC:  \\server\share  ->  //server/share
    if (winPath.startsWith('\\\\')) return winPath.replace(/\\/g, '/');
    // Drive letter:  C:\Users\foo  ->  /C/Users/foo  (case preserved)
    const m = winPath.match(/^([a-zA-Z]):[\\\/]/);
    if (m) return `/${m[1]}/${winPath.slice(3).replace(/\\/g, '/')}`;
    // Relative or unrecognised shape: unchanged
    return winPath;
}

export function posixPathToWindowsPath(posixPath) {
    if (typeof posixPath !== 'string') return posixPath;
    // Cygwin:  /cygdrive/c/...  ->  c:\...  (case preserved)
    const cyg = posixPath.match(/^\/cygdrive\/([a-zA-Z])\//);
    if (cyg) return `${cyg[1]}:\\${posixPath.slice(11).replace(/\//g, '\\')}`;
    // MSYS/Git Bash:  /c/Users/...  ->  c:\Users\...  (case preserved)
    const m = posixPath.match(/^\/([a-zA-Z])\//);
    if (m) return `${m[1]}:\\${posixPath.slice(3).replace(/\//g, '\\')}`;
    // UNC:  //server/share  ->  \\server\share
    if (posixPath.startsWith('//')) return posixPath.replace(/\//g, '\\');
    // Relative or unrecognised shape: unchanged
    return posixPath;
}

export function normalizeInputPath(p) {
    if (typeof p !== 'string') return p;
    let out = p;
    if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(out)) {
        out = posixPathToWindowsPath(out);
    }
    try { out = out.normalize('NFC'); } catch { /* ignore */ }
    return out;
}

// Normalise output paths for display: on Windows, unify all separators to
// forward slash so `C:/.../tools\lsp.mjs`-style mixed-slash strings don't
// reach the model. Native Windows APIs accept forward slashes too, so this
// is a purely cosmetic (and downstream copy-paste friendly) normalisation.
export function normalizeOutputPath(p) {
    if (typeof p !== 'string') return p;
    return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

// Grep output lines shaped as "<path>:<lineno>:<content>" (content mode),
// "<path>:<count>" (count mode), or bare "<path>" (files_with_matches).
// Only the path portion should have separators swapped; content that
// happens to contain a backslash (regex escapes, string literals) must
// survive intact. Drive-letter colon at position 1 is skipped when
// locating the first path/value delimiter.
function normalizeGrepLine(line) {
    if (process.platform !== 'win32') return line;
    const searchFrom = /^[A-Za-z]:/.test(line) ? 2 : 0;
    const colonIdx = line.indexOf(':', searchFrom);
    if (colonIdx === -1) return line.replace(/\\/g, '/');
    return line.slice(0, colonIdx).replace(/\\/g, '/') + line.slice(colonIdx);
}

// Suggest a sibling file the caller may have meant when the requested
// path is missing: same stem with a different extension, or a same-name
// sibling differing only in case. Pure best-effort; any fs error returns
// null so the caller falls back to the bare "not found" message.
function findSimilarFile(fullPath) {
    try {
        const dir = dirname(fullPath);
        const base = basename(fullPath);
        const stem = basename(fullPath, extname(fullPath));
        const entries = readdirSync(dir);
        const sameStem = entries.find((e) => e !== base && basename(e, extname(e)) === stem);
        if (sameStem) return join(dir, sameStem);
        const caseMatch = entries.find((e) => e !== base && e.toLowerCase() === base.toLowerCase());
        if (caseMatch) return join(dir, caseMatch);
        return null;
    } catch { return null; }
}

function cwdRelativePath(fullPath, workDir) {
    try {
        const rel = relative(workDir, fullPath);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) return fullPath;
        return rel;
    } catch { return fullPath; }
}

// Node's native fs errors embed the failing path wrapped in single quotes
// using OS-native separators ('C:\\Users\\foo\\bar.mjs' on Windows). Without
// this pass, read / multi_read error bodies surface backslash paths that
// break the forward-slash convention the rest of the tool output keeps.
// Only quoted drive-letter paths are rewritten so unrelated backslash
// sequences in the message text are untouched.
function normalizeErrorMessage(msg) {
    if (process.platform !== 'win32' || typeof msg !== 'string') return msg;
    return msg.replace(
        /(['"])([A-Za-z]:[\\\/][^'"]+)\1/g,
        (_m, q, p) => `${q}${p.replace(/\\/g, '/')}${q}`,
    );
}

function extractGlobBaseDirectory(pattern) {
    const wildcardIdx = pattern.search(/[\*\?\[\{]/);
    const staticPrefix = wildcardIdx === -1 ? pattern : pattern.slice(0, wildcardIdx);
    const lastSep = Math.max(
        staticPrefix.lastIndexOf('/'),
        staticPrefix.lastIndexOf('\\'),
    );
    if (lastSep === -1) return { baseDir: null, relativePattern: pattern };
    let baseDir = staticPrefix.slice(0, lastSep);
    const relativePattern = pattern.slice(lastSep + 1);
    if (process.platform === 'win32' && /^[A-Za-z]:$/.test(baseDir)) {
        baseDir = baseDir + '\\';
    }
    return { baseDir: baseDir || null, relativePattern };
}

// Cap matches Claude Code's BashTool default (BASH_MAX_OUTPUT_DEFAULT in
// utils/shell/outputLimits.ts, 30_000 chars). Claude Code falls back to a
// persisted stdout file the model can re-read via FileRead; this orchestrator
// has no such sidecar store, so the head slice is the full record the model
// ever sees. Larger raw outputs (seen in the wild: a 160k-token Grep result on
// 2026-04-19) blow the context budget and crater the server-side prompt
// cache, so the cap is the primary guard.
const SHELL_OUTPUT_MAX_CHARS = 30_000;

// Default ignores for grep/glob shell-outs. Matches the directories ripgrep
// already skips when a repo is initialized (.gitignore-driven) plus the
// common build-artefact dirs that are almost never interesting to search.
// Without these, rg walks node_modules on plugin-source trees and spikes to
// ~10-12% CPU per process (three concurrent reviewer rg calls observed
// burning 34% CPU aggregate, 2026-04-19).
const DEFAULT_IGNORE_GLOBS = [
    '!node_modules/**',
    '!.git/**',
    '!dist/**',
    '!build/**',
    '!.next/**',
    '!coverage/**',
    '!.turbo/**',
    '!.venv/**',
    '!__pycache__/**',
];

function capShellOutput(content) {
    const s = typeof content === 'string' ? content : String(content ?? '');
    if (s.length <= SHELL_OUTPUT_MAX_CHARS) return s;
    const head = s.slice(0, SHELL_OUTPUT_MAX_CHARS);
    const tail = s.slice(SHELL_OUTPUT_MAX_CHARS);
    const remainingLines = (tail.match(/\n/g) || []).length + 1;
    return `${head}\n\n... [${remainingLines} lines truncated] ...`;
}
// Read tool caps. Two-stage protection mirrors Anthropic Claude Code's
// FileReadTool/limits.ts pattern: pre-stat byte cap throws ~100B error vs
// truncation that fills 25K tokens at the cap. Throw is decisively more
// token-efficient (Anthropic #21841 reverted truncation experiment).
const READ_MAX_SIZE_BYTES = 256 * 1024;
const READ_MAX_OUTPUT_BYTES = 100 * 1024;

// Streaming path for large files when offset/limit is provided. Mirrors
// Claude Code's FileReadTool large-file branch: instead of loading the
// whole file into memory (which blows the 256KB cap for legitimate
// targeted reads), line-stream through readline and materialise only the
// requested window. Output format matches the fast path so downstream
// line-citation parsing is unchanged.
async function streamReadRange(fullPath, offset, limit) {
    return new Promise((resolve, reject) => {
        const stream = createReadStream(fullPath, { encoding: 'utf-8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        const collected = [];
        let lineIdx = 0;
        let collectedBytes = 0;
        let truncated = false;
        rl.on('line', (line) => {
            if (lineIdx < offset) { lineIdx++; return; }
            if (collected.length >= limit) {
                rl.close();
                stream.destroy();
                return;
            }
            const rendered = `${lineIdx + 1}\t${line}`;
            collectedBytes += rendered.length + 1; // +1 for newline
            if (collectedBytes > READ_MAX_OUTPUT_BYTES) {
                truncated = true;
                rl.close();
                stream.destroy();
                return;
            }
            collected.push(rendered);
            lineIdx++;
        });
        rl.on('close', () => {
            let out = collected.join('\n');
            if (truncated) {
                out += `\n\n... [output truncated at ${Math.round(READ_MAX_OUTPUT_BYTES/1024)} KB] ...`;
            }
            resolve(out);
        });
        rl.on('error', reject);
        stream.on('error', reject);
    });
}

// --- Tool definitions for external models ---
//
// Ordered to match the previous hand-maintained tools.json entries
// (read / edit / write / bash / grep / glob / multi_edit / multi_read /
// batch_edit) so build-tools-manifest reproduces the legacy ordering.
// Shape mirrors tools.json: title + annotations + compact descriptions.
// The previous long-form descriptions have been trimmed to the tools.json
// versions — those are what external models actually saw in the prefix.
// `BUILTIN_TOOLS` name is preserved because session/manager.mjs and the
// isBuiltinTool check in this file both reference it by that symbol.
export const BUILTIN_TOOLS = [
    {
        name: 'read',
        title: 'Read',
        annotations: { title: 'Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Read a file with cat -n line numbering, size cap, optional offset/limit.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path.' },
                offset: { type: 'number', description: 'Start line (0-based).' },
                limit: { type: 'number', description: 'Max lines (default 2000).' },
            },
            required: ['path'],
        },
    },
    {
        name: 'edit',
        title: 'Edit',
        annotations: { title: 'Edit', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Replace one unique occurrence of `old_string` with `new_string`. Must match exactly once.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path.' },
                old_string: { type: 'string', description: 'Text to find (exactly once).' },
                new_string: { type: 'string', description: 'Replacement.' },
            },
            required: ['path', 'old_string', 'new_string'],
        },
    },
    {
        name: 'write',
        title: 'Write',
        annotations: { title: 'Write', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Create or overwrite a file.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path.' },
                content: { type: 'string', description: 'UTF-8 content.' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'bash',
        title: 'Bash',
        annotations: { title: 'Bash', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Execute a shell command. Destructive patterns (rm -rf /, force-push, format) are blocked.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command.' },
                timeout: { type: 'number', description: 'ms, default 30000, max 600000.' },
            },
            required: ['command'],
        },
    },
    {
        name: 'grep',
        title: 'Grep',
        annotations: { title: 'Grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'ripgrep content search. `pattern` / `glob` accept string or array (OR-joined). Output modes: `files_with_matches` (default), `content`, `count`.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Regex pattern(s). String or array (OR-joined).' },
                path: { type: 'string', description: 'Search root. Default: cwd.' },
                glob: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Glob filter(s). String or array.' },
                output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
                head_limit: { type: 'number', description: 'Default 250; 0 = unlimited.' },
                offset: { type: 'number', description: 'Skip N entries before head_limit.' },
                '-i': { type: 'boolean', description: 'Case-insensitive match.' },
                '-n': { type: 'boolean', description: 'Show line numbers (content mode, default true).' },
                '-A': { type: 'number', description: 'Lines after each match (content mode).' },
                '-B': { type: 'number', description: 'Lines before each match (content mode).' },
                '-C': { type: 'number', description: 'Lines before+after (content mode).' },
                context: { type: 'number', description: 'Alias for -C.' },
                multiline: { type: 'boolean', description: 'Allow patterns to span lines (rg -U --multiline-dotall).' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'glob',
        title: 'Glob',
        annotations: { title: 'Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'File path search via `rg --files`. `pattern` accepts string or array (OR-joined).',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Glob pattern(s).' },
                path: { type: 'string', description: 'Base dir. Default: cwd. Capped at 100.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'multi_edit',
        title: 'Multi Edit',
        annotations: { title: 'Multi Edit', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Apply ordered replacements to ONE file. Any match failure aborts the batch (no partial writes). `replace_all:true` drops uniqueness check.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path.' },
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            old_string: { type: 'string', description: 'Text to find (unique unless replace_all).' },
                            new_string: { type: 'string', description: 'Replacement.' },
                            replace_all: { type: 'boolean', description: 'Replace all, skip uniqueness.' },
                        },
                        required: ['old_string', 'new_string'],
                    },
                    minItems: 1,
                },
            },
            required: ['path', 'edits'],
        },
    },
    {
        name: 'multi_read',
        title: 'Multi Read',
        annotations: { title: 'Multi Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Read several files in parallel. Returns `### <path>` sections; per-file errors inline.',
        inputSchema: {
            type: 'object',
            properties: {
                reads: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'File path.' },
                            offset: { type: 'number' },
                            limit: { type: 'number' },
                        },
                        required: ['path'],
                    },
                    minItems: 1,
                },
            },
            required: ['reads'],
        },
    },
    {
        name: 'batch_edit',
        title: 'Batch Edit',
        annotations: { title: 'Batch Edit', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Apply edits across multiple files. Per-entry failures reported as `FAIL <path>`; batch continues.',
        inputSchema: {
            type: 'object',
            properties: {
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                            old_string: { type: 'string', description: 'Text to find (unique).' },
                            new_string: { type: 'string', description: 'Replacement.' },
                        },
                        required: ['path', 'old_string', 'new_string'],
                    },
                    minItems: 1,
                },
            },
            required: ['edits'],
        },
    },
];
// --- Short-TTL result cache for idempotent read-only tools ---
//
// Anthropic prompt cache already covers the messages layer; this layer
// dedupes back-to-back builtin tool calls with identical args so spawning
// ripgrep or re-reading the same file is avoided when the agent loops on
// the same query in a tight iter. Any mutation (write / edit / bash /
// multi_edit / batch_edit) invalidates the whole cache — safer than
// trying to invalidate a subset, and the TTL is short enough that the
// lost hit ratio is small.
const RESULT_CACHE = new Map(); // key → { ts, value }
const RESULT_CACHE_TTL_MS = 30_000;
const RESULT_CACHE_MAX_ENTRIES = 200;
function _cacheGet(key) {
    const entry = RESULT_CACHE.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > RESULT_CACHE_TTL_MS) {
        RESULT_CACHE.delete(key);
        return null;
    }
    return entry.value;
}
function _cacheSet(key, value) {
    if (RESULT_CACHE.size >= RESULT_CACHE_MAX_ENTRIES) {
        const oldest = RESULT_CACHE.keys().next().value;
        if (oldest) RESULT_CACHE.delete(oldest);
    }
    RESULT_CACHE.set(key, { ts: Date.now(), value });
}
function _cacheInvalidateAll() { RESULT_CACHE.clear(); }

// --- Read-before-Edit tracking (Claude Code parity) ---
//
// Anthropic FileEditTool enforces that a file must have been Read before
// it can be Edited. Prevents "phantom edits" where the model invents an
// old_string based on cached assumptions and accidentally rewrites a
// file that has drifted on disk. Also unblocks write-then-edit: after a
// successful Write the path is marked read-known so a subsequent Edit
// does not have to round-trip through Read.
//
// Value stores the mtime + size at read-time. Edit/multi_edit stat the
// file again and reject with error [code 7] when the current mtime has
// advanced — detects lint/formatter/external-write drift the way
// Anthropic's readFileState timestamp check does.
const _readFiles = new Map(); // fullPath → { mtimeMs, size }

function _recordReadSnapshot(fullPath, st) {
    try {
        if (st && typeof st.mtimeMs === 'number') {
            _readFiles.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size });
            return;
        }
        const fresh = statSync(fullPath);
        _readFiles.set(fullPath, { mtimeMs: fresh.mtimeMs, size: fresh.size });
    } catch {
        _readFiles.set(fullPath, { mtimeMs: Date.now(), size: 0 });
    }
}

// --- Blocked commands for safety ---
const BLOCKED_PATTERNS = [
    /\brm\s+-rf\s+[/~]/i,
    /\bgit\s+push\s+--force/i,
    /\bgit\s+reset\s+--hard/i,
    /\bformat\s+[a-z]:/i,
    /\b(shutdown|reboot|halt)\b/i,
    /\bdel\s+\/[sfq]/i,
];
function isSafePath(filePath, cwd) {
    const baseCwd = normalize(resolve(cwd));
    const normalized = normalize(resolve(baseCwd, filePath));
    // Windows file paths are case-insensitive (NTFS default), but JS string
    // comparison is case-sensitive. Without the case fold, `C:\Users\foo`
    // and `c:\Users\foo` would resolve to the same file yet be rejected
    // by the scope check.
    const caseMatch = process.platform === 'win32'
        ? (a, b) => a.toLowerCase().startsWith(b.toLowerCase())
        : (a, b) => a.startsWith(b);
    if (!caseMatch(normalized, baseCwd)) {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        if (home && caseMatch(normalized, normalize(home)))
            return true;
        return false;
    }
    return true;
}
function resolveAgainstCwd(filePath, cwd) {
    return resolve(cwd, filePath);
}

// Ripgrep wrapper. Ripgrep occasionally fails with EAGAIN on Windows when
// thread/resource pressure spikes (observed 2026-04-19 with three
// concurrent reviewer rg calls). On EAGAIN we retry once with `-j 1` to
// force single-threaded execution; the second attempt almost always
// succeeds. rg exit code 1 is "no matches" — surfaced as empty stdout
// rather than an error so callers can render "(no matches)" uniformly.
async function runRg(argsList, execOptions = {}) {
    const opts = { encoding: 'utf-8', timeout: 20000, ...execOptions };
    const quote = (a) => `"${a}"`;
    try {
        const { stdout } = await execAsync(`rg ${argsList.map(quote).join(' ')}`, opts);
        return stdout;
    } catch (err) {
        const msg = String(err?.message || err?.code || '');
        if (/EAGAIN/i.test(msg) && !argsList.includes('-j')) {
            const retryArgs = ['-j', '1', ...argsList];
            const { stdout } = await execAsync(`rg ${retryArgs.map(quote).join(' ')}`, opts);
            return stdout;
        }
        // rg exits 1 when there are no matches — treat as empty result.
        if (err?.code === 1 || /no matches|exit code 1/.test(msg)) return '';
        throw err;
    }
}
// --- Tool execution ---
export async function executeBuiltinTool(name, args, cwd) {
    const workDir = cwd || process.cwd();
    switch (name) {
        case 'bash': {
            const command = args.command;
            if (!command)
                return 'Error: command is required';
            for (const pattern of BLOCKED_PATTERNS) {
                if (pattern.test(command)) {
                    return `Error: blocked command pattern — "${command}" matches safety rule`;
                }
            }
            const timeout = args.timeout || 30000;
            try {
                const { shell, shellArg } = resolveShell();
                const result = spawnSync(shell, [shellArg, command], {
                    encoding: 'utf-8',
                    timeout,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    cwd: workDir,
                    windowsHide: true,
                });
                if (result.error) return `Error: ${result.error.message}`;
                if (result.status !== 0) return capShellOutput((result.stdout || '') + (result.stderr || '') + `\n[exit code: ${result.status}]`);
                return capShellOutput(result.stdout || '(no output)');
            }
            finally {
                _cacheInvalidateAll();
            }
        }
        case 'read': {
            args.path = normalizeInputPath(args.path);
            const filePath = args.path;
            if (!filePath)
                return 'Error: path is required';
            if (!isSafePath(filePath, workDir))
                return `Error: path outside allowed scope — ${filePath}`;
            const fullPath = resolveAgainstCwd(filePath, workDir);
            const cacheKey = `read|${fullPath}|${typeof args.offset === 'number' ? args.offset : 'd'}|${typeof args.limit === 'number' ? args.limit : 'd'}`;
            const cached = _cacheGet(cacheKey);
            if (cached !== null) return cached;
            // Pre-read size cap (Anthropic FileReadTool/limits.ts pattern):
            // throw a small error response when the file is too big rather
            // than truncating to 25K tokens of content. Throw is decisively
            // more token-efficient (Anthropic #21841 reverted truncation).
            // Large-file branch: if offset/limit is provided, stream the
            // requested line window instead of throwing (Task B). Without
            // range args the cap still throws so small-file default path
            // can't be weaponised to pull megabytes by accident.
            const offset = typeof args.offset === 'number' ? args.offset : 0;
            const limit = typeof args.limit === 'number' ? args.limit : 2000;
            const hasRangeArgs = typeof args.offset === 'number' || typeof args.limit === 'number';
            let st;
            try {
                st = statSync(fullPath);
            } catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
            if (st.size > READ_MAX_SIZE_BYTES) {
                if (!hasRangeArgs) {
                    return `Error: file size ${st.size} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap. Use offset+limit to read a range.`;
                }
                try {
                    const out = await streamReadRange(fullPath, offset, limit);
                    _cacheSet(cacheKey, out);
                    _recordReadSnapshot(fullPath, st);
                    return out;
                } catch (err) {
                    return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
                }
            }
            try {
                const content = await readFile(fullPath, 'utf-8');
                const lines = content.split('\n');
                const sliced = lines.slice(offset, offset + limit);
                const rendered = sliced.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
                // Output byte cap protects against many-line slices that
                // individually pass the file-size check but explode after
                // line-number prefixing.
                let out;
                if (rendered.length > READ_MAX_OUTPUT_BYTES) {
                    out = rendered.slice(0, READ_MAX_OUTPUT_BYTES) + `\n\n... [output truncated at ${Math.round(READ_MAX_OUTPUT_BYTES/1024)} KB] ...`;
                } else {
                    out = rendered;
                }
                _cacheSet(cacheKey, out);
                _recordReadSnapshot(fullPath, st);
                return out;
            }
            catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
        }
        case 'multi_read': {
            const reads = Array.isArray(args.reads) ? args.reads : [];
            for (const r of reads) { if (r && typeof r === 'object') r.path = normalizeInputPath(r.path); }
            if (reads.length === 0) return 'Error: reads array is required';
            // Parallel dispatch of the individual reads via the same case
            // above — reuses size cap, isSafePath, line-number formatting.
            // Per-file errors come back as their own string and are pasted
            // into the aggregate rather than aborting the whole batch.
            const results = await Promise.all(reads.map(async (entry) => {
                if (!entry || !entry.path) return { path: '(missing-path)', body: 'Error: path is required' };
                const body = await executeBuiltinTool('read', entry, workDir);
                return { path: entry.path, body };
            }));
            // Header path → forward slash; error bodies already normalised
            // inside the read case's catch blocks.
            return results.map(r => `### ${normalizeOutputPath(r.path)}\n${r.body}`).join('\n\n');
        }
        case 'multi_edit': {
            // Claude Code native MultiEdit semantics: one file, many ordered
            // replacements, all-or-nothing. We apply the chain in memory
            // first — any failure aborts before the file is written so the
            // tree never lands in a half-edited state.
            args.path = normalizeInputPath(args.path);
            const filePath = args.path;
            const edits = Array.isArray(args.edits) ? args.edits : [];
            if (!filePath) return 'Error: path is required';
            if (edits.length === 0) return 'Error: edits array is required';
            if (!isSafePath(filePath, workDir)) return `Error: path outside allowed scope — ${filePath}`;
            const fullPath = resolveAgainstCwd(filePath, workDir);
            if (!existsSync(fullPath)) {
                const similar = findSimilarFile(fullPath);
                const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                return `Error [code 4]: file not found: ${filePath}${hint}`;
            }
            const mEditSnapshot = _readFiles.get(fullPath);
            if (!mEditSnapshot) {
                return `Error [code 6]: file has not been read yet — read before editing: ${filePath}`;
            }
            try {
                const currentMtime = statSync(fullPath).mtimeMs;
                if (currentMtime > mEditSnapshot.mtimeMs + 1) {
                    return `Error [code 7]: file modified since read (lint / formatter / external write) — read it again before editing: ${filePath}`;
                }
            } catch {
                // File vanished mid-edit — fall through; readFileSync below surfaces it.
            }
            try {
                let content;
                try { content = readFileSync(fullPath, 'utf-8'); }
                catch (err) { return `Error: ${err instanceof Error ? err.message : String(err)}`; }
                for (let i = 0; i < edits.length; i++) {
                    const entry = edits[i];
                    if (!entry || typeof entry.old_string !== 'string' || typeof entry.new_string !== 'string') {
                        return `Error: edit ${i} must have old_string and new_string`;
                    }
                    const { old_string, new_string, replace_all } = entry;
                    if (replace_all === true) {
                        if (!content.includes(old_string)) {
                            return `Error [code 8]: edit ${i} — old_string not found in ${filePath}`;
                        }
                        content = content.split(old_string).join(new_string);
                    } else {
                        const count = content.split(old_string).length - 1;
                        if (count === 0) return `Error [code 8]: edit ${i} — old_string not found in ${filePath}`;
                        if (count > 1) return `Error [code 9]: edit ${i} — old_string found ${count} times in ${filePath}; set replace_all:true or provide more unique context`;
                        content = content.replace(old_string, new_string);
                    }
                }
                writeFileSync(fullPath, content, 'utf-8');
                _cacheInvalidateAll();
                _recordReadSnapshot(fullPath);
                return `Edited: ${filePath} (${edits.length} replacements applied)`;
            } catch (err) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
        }
        case 'batch_edit': {
            const edits = Array.isArray(args.edits) ? args.edits : [];
            if (edits.length === 0) return 'Error: edits array is required';
            for (const e of edits) { if (e && typeof e === 'object') e.path = normalizeInputPath(e.path); }
            // Cross-file sequential dispatch through the same `edit` case so
            // size caps, isSafePath checks, and unique-match enforcement stay
            // consistent across files. Sequential (not parallel) to avoid
            // concurrent writes to the same path.
            const lines = [];
            for (const entry of edits) {
                if (!entry || !entry.path) { lines.push('FAIL (missing-path): path is required'); continue; }
                const body = await executeBuiltinTool('edit', entry, workDir);
                const first = String(body).split('\n')[0] || '';
                // `edit` returns either "Error: <msg>" (generic) or
                // "Error [code N]: <msg>" (structured). Match either shape
                // and surface the message portion verbatim.
                if (/^Error(\s|\[)/.test(first)) {
                    const colonIdx = first.indexOf(': ');
                    const msg = colonIdx !== -1 ? first.slice(colonIdx + 2) : first;
                    lines.push(`FAIL ${entry.path}: ${msg}`);
                } else {
                    lines.push(`OK ${entry.path}`);
                }
            }
            return lines.join('\n');
        }
        case 'write': {
            args.path = normalizeInputPath(args.path);
            const filePath = args.path;
            const content = args.content;
            if (!filePath)
                return 'Error: path is required';
            if (content === undefined)
                return 'Error: content is required';
            if (!isSafePath(filePath, workDir))
                return `Error: path outside allowed scope — ${filePath}`;
            try {
                const fullPath = resolveAgainstCwd(filePath, workDir);
                writeFileSync(fullPath, content, 'utf-8');
                _cacheInvalidateAll();
                // Write establishes the on-disk state the model just
                // authored, so a subsequent Edit does not need a fresh
                // Read round-trip.
                _recordReadSnapshot(fullPath);
                return `Written: ${filePath}`;
            }
            catch (err) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
        }
        case 'edit': {
            args.path = normalizeInputPath(args.path);
            const filePath = args.path;
            const oldStr = args.old_string;
            const newStr = args.new_string;
            const replaceAll = args.replace_all === true;
            if (!filePath || !oldStr)
                return 'Error: path and old_string are required';
            if (!isSafePath(filePath, workDir))
                return `Error: path outside allowed scope — ${filePath}`;
            const fullPath = resolveAgainstCwd(filePath, workDir);
            // Error [code 4]: file does not exist on disk.
            if (!existsSync(fullPath)) {
                const similar = findSimilarFile(fullPath);
                const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                return `Error [code 4]: file not found: ${filePath}${hint}`;
            }
            // Error [code 6]: Read-before-Edit enforcement. Prevents phantom
            // edits where the model invents an old_string based on cached
            // assumptions against a file that has drifted.
            const editSnapshot = _readFiles.get(fullPath);
            if (!editSnapshot) {
                return `Error [code 6]: file has not been read yet — read before editing: ${filePath}`;
            }
            // Error [code 7]: detect stale read via mtime drift (Anthropic
            // readFileState timestamp check parity). +1ms slack absorbs
            // filesystem timestamp resolution noise on NTFS/exFAT.
            try {
                const currentMtime = statSync(fullPath).mtimeMs;
                if (currentMtime > editSnapshot.mtimeMs + 1) {
                    return `Error [code 7]: file modified since read (lint / formatter / external write) — read it again before editing: ${filePath}`;
                }
            } catch {
                // Vanished — readFileSync below surfaces it.
            }
            try {
                const content = readFileSync(fullPath, 'utf-8');
                const count = content.split(oldStr).length - 1;
                if (count === 0)
                    return `Error [code 8]: old_string not found in ${filePath}`;
                if (count > 1 && !replaceAll)
                    return `Error [code 9]: old_string found ${count} times — set replace_all:true or provide more unique context`;
                const updated = replaceAll
                    ? content.split(oldStr).join(newStr)
                    : content.replace(oldStr, newStr);
                writeFileSync(fullPath, updated, 'utf-8');
                _cacheInvalidateAll();
                // Refresh the snapshot to the post-write mtime so a chain
                // of edits against the same file doesn't trip the stale
                // check on the second hop.
                _recordReadSnapshot(fullPath);
                return `Edited: ${filePath}`;
            }
            catch (err) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
        }
        case 'grep': {
            args.path = normalizeInputPath(args.path);
            const rawPattern = args.pattern;
            const patterns = (Array.isArray(rawPattern)
                ? rawPattern.filter(p => typeof p === 'string' && p)
                : (rawPattern ? [String(rawPattern)] : [])).map(normalizeInputPath);
            if (patterns.length === 0)
                return 'Error: pattern is required';
            const searchPath = args.path || '.';
            const rawGlob = args.glob;
            const globPatterns = (Array.isArray(rawGlob)
                ? rawGlob.filter(g => typeof g === 'string' && g)
                : (rawGlob ? [String(rawGlob)] : [])).map(normalizeInputPath);
            // output_mode mirrors Anthropic GrepTool: files_with_matches
            // (default — paths only, lowest token cost), content (matched
            // lines + path + line number), count (per-file match counts).
            const outputMode = args.output_mode || 'files_with_matches';
            const headLimitRaw = args.head_limit;
            const headLimit = headLimitRaw === 0 ? Infinity : (headLimitRaw || 250);
            const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
            const cacheKey = `grep|${patterns.join('\x01')}|${searchPath}|${globPatterns.join('\x01')}|${outputMode}|${headLimit}|${offset}`;
            const cached = _cacheGet(cacheKey);
            if (cached !== null) return cached;
            // Extended rg flag decoding (Anthropic GrepTool parity): case
            // fold, line numbers, -A/-B/-C windowing, and multiline dot.
            // Context flags and line numbers are silently ignored outside
            // content mode since rg rejects them there.
            const caseInsensitive = args['-i'] === true;
            const showLineNumbers = args['-n'] !== false; // default true for content mode
            const afterN = typeof args['-A'] === 'number' ? args['-A'] : null;
            const beforeN = typeof args['-B'] === 'number' ? args['-B'] : null;
            const contextN = typeof args['-C'] === 'number'
                ? args['-C']
                : (typeof args.context === 'number' ? args.context : null);
            const multilineMode = args.multiline === true;
            try {
                const rgArgs = ['--color', 'never'];
                if (outputMode === 'files_with_matches') {
                    rgArgs.push('--files-with-matches');
                } else if (outputMode === 'count') {
                    rgArgs.push('--count');
                } else {
                    rgArgs.push('--no-heading');
                    if (showLineNumbers) rgArgs.push('--line-number');
                    if (beforeN !== null) rgArgs.push('-B', String(beforeN));
                    if (afterN !== null) rgArgs.push('-A', String(afterN));
                    if (contextN !== null) rgArgs.push('-C', String(contextN));
                }
                if (caseInsensitive) rgArgs.push('-i');
                if (multilineMode) rgArgs.push('-U', '--multiline-dotall');
                for (const ex of DEFAULT_IGNORE_GLOBS) rgArgs.push('--glob', ex);
                for (const g of globPatterns) rgArgs.push('--glob', g);
                // Use -e for each pattern so rg OR-joins them in a single
                // process. `-e` takes the pattern as a flag value, which also
                // avoids ambiguity with patterns starting with `-`.
                for (const p of patterns) rgArgs.push('-e', p);
                rgArgs.push(searchPath);
                const stdout = await runRg(rgArgs, { cwd: workDir });
                const allLines = stdout.split('\n').filter(Boolean);
                // Apply offset before head_limit so pagination is predictable:
                // page 1 = offset 0, page 2 = offset + head_limit, etc.
                const windowed = offset > 0 ? allLines.slice(offset) : allLines;
                const lines = headLimit === Infinity ? windowed : windowed.slice(0, headLimit);
                // Unify separators in the path portion so Windows results
                // don't surface mixed `C:/.../foo\bar.mjs` lines.
                const normalized = lines.map(normalizeGrepLine);
                const remaining = windowed.length - lines.length;
                const truncated = remaining > 0
                    ? `\n... [${remaining} more entries]`
                    : '';
                const out = capShellOutput((normalized.join('\n') + truncated) || '(no matches)');
                _cacheSet(cacheKey, out);
                return out;
            }
            catch (err) {
                // `runRg` swallows rg exit-1 (no match) and returns ''; any
                // error reaching here is a real failure (invalid regex,
                // permission denied, spawn error). Surface rg's stderr so
                // the caller can diagnose rather than mistake it for no-match.
                const stderr = err?.stderr ? String(err.stderr).trim() : '';
                const msg = stderr || err?.message || String(err);
                return `Error: ${msg.slice(0, 500)}`;
            }
        }
        case 'glob': {
            args.path = normalizeInputPath(args.path);
            const rawPattern = args.pattern;
            const patterns = (Array.isArray(rawPattern)
                ? rawPattern.filter(p => typeof p === 'string' && p)
                : (rawPattern ? [String(rawPattern)] : [])).map(normalizeInputPath);
            if (patterns.length === 0)
                return 'Error: pattern is required';
            const basePath = args.path || '.';
            const cacheKey = `glob|${patterns.join('\x01')}|${basePath}`;
            const cached = _cacheGet(cacheKey);
            if (cached !== null) return cached;
            // Group patterns by resolved baseDir so multiple absolute roots
            // (e.g. C:\a\**\*.js and D:\b\*.ts) each get their own rg pass.
            const groups = new Map();
            function addToGroup(root, rel) {
                if (!groups.has(root)) groups.set(root, []);
                groups.get(root).push(rel);
            }
            for (const p of patterns) {
                if (isAbsolute(p)) {
                    const { baseDir, relativePattern } = extractGlobBaseDirectory(p);
                    addToGroup(baseDir || basePath, relativePattern);
                } else {
                    addToGroup(basePath, p);
                }
            }
            const allFiles = [];
            for (const [root, rels] of groups) {
                const rgArgs = ['--files'];
                for (const ex of DEFAULT_IGNORE_GLOBS) rgArgs.push('--glob', ex);
                for (const rel of rels) rgArgs.push('--glob', rel);
                rgArgs.push(root);
                try {
                    const { stdout } = await execAsync(`rg ${rgArgs.map(a => `"${a}"`).join(' ')}`, {
                        encoding: 'utf-8',
                        timeout: 10000,
                        cwd: workDir,
                    });
                    for (const line of stdout.split('\n')) {
                        const trimmed = line.trim();
                        if (trimmed) allFiles.push(trimmed);
                    }
                } catch {
                    // rg exits 1 on no matches; best-effort ignore
                }
            }
            const unique = Array.from(new Set(allFiles));
            // Sort by mtime descending (Anthropic GlobTool parity): recent
            // edits surface first, so the agent sees the file it just
            // touched at the top of a wide match. stat failures degrade
            // to mtime=0 so missing/race-condition entries land at the
            // end rather than aborting the whole sort.
            const withStat = unique.map((p) => {
                try { return { path: p, mtime: statSync(p).mtimeMs }; }
                catch { return { path: p, mtime: 0 }; }
            });
            withStat.sort((a, b) => b.mtime - a.mtime);
            const capped = withStat.slice(0, 100).map((entry) => {
                // Relativise against workDir when the file lives inside it
                // — matches Anthropic GlobTool toRelativePath and trims the
                // redundant absolute prefix from the model's context.
                const displayed = cwdRelativePath(entry.path, workDir);
                return normalizeOutputPath(displayed);
            });
            const out = capShellOutput(capped.join('\n') || '(no files found)');
            _cacheSet(cacheKey, out);
            return out;
        }
        default:
            return `Error: unknown builtin tool "${name}"`;
    }
}
/**
 * Check if a tool name is a builtin tool.
 */
export function isBuiltinTool(name) {
    return BUILTIN_TOOLS.some(t => t.name === name);
}
