import { exec, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, statSync, existsSync, createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { promisify } from 'util';
const execAsync = promisify(exec);
import { resolve, normalize, isAbsolute } from 'path';

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
        description: 'Read a file from disk with cat -n line-numbered output, byte-size cap, and optional offset/limit windowing.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or cwd-relative file path.' },
                offset: { type: 'number', description: 'Start line (0-based).' },
                limit: { type: 'number', description: 'Max lines to read.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'edit',
        title: 'Edit',
        annotations: { title: 'Edit', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Replace one unique occurrence of `old_string` with `new_string` in a file. `old_string` must match exactly once.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or cwd-relative file path.' },
                old_string: { type: 'string', description: 'Must appear exactly once.' },
                new_string: { type: 'string', description: 'Replacement text.' },
            },
            required: ['path', 'old_string', 'new_string'],
        },
    },
    {
        name: 'write',
        title: 'Write',
        annotations: { title: 'Write', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Create or overwrite a file with the provided content.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or cwd-relative file path. File is created if missing, overwritten if it exists.' },
                content: { type: 'string', description: 'Full file content to write (UTF-8).' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'bash',
        title: 'Bash',
        annotations: { title: 'Bash', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Execute a shell command with a configurable timeout. A small blocked-pattern safety list rejects `rm -rf /`, `git push --force`, `format c:`, etc.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to execute in the workspace cwd. Rejected if it matches a blocked safety pattern (e.g. `rm -rf /`, `git push --force`, `format c:`).' },
                timeout: { type: 'number', description: 'Milliseconds (default 30000, max 600000).' },
            },
            required: ['command'],
        },
    },
    {
        name: 'grep',
        title: 'Grep',
        annotations: { title: 'Grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'ripgrep-backed content search. `pattern` and `glob` both accept a string or an array of strings (OR-joined in one invocation). Output modes: `files_with_matches` (default), `content`, `count`; `head_limit` caps the return set.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Regex pattern(s) passed to ripgrep via `-e`. A string searches for one pattern; an array OR-joins multiple patterns in a single rg invocation.' },
                path: { type: 'string', description: 'Directory or file to search under. Defaults to the workspace cwd (`.`).' },
                glob: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Optional glob filter(s) applied on top of the default ignore list (node_modules, .git, dist, build, etc.). String or array of strings.' },
                output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'], description: '`files_with_matches` (default, paths only), `content` (matched lines with path and line number), or `count` (per-file match counts).' },
                head_limit: { type: 'number', description: 'Cap on returned entries. Default 100; pass 0 for no limit. Extra entries are summarised as `... [N more entries]`.' },
                offset: { type: 'number', description: 'Skip the first N entries from the ripgrep result before applying `head_limit`. Default 0. Paginate large result sets by combining with `head_limit`.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'glob',
        title: 'Glob',
        annotations: { title: 'Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'File name / path search via ripgrep --files. `pattern` accepts a string or an array of globs (OR-joined in one invocation).',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Glob pattern(s) passed to `rg --files --glob`. A string matches one glob; an array OR-joins multiple globs in a single rg invocation.' },
                path: { type: 'string', description: 'Base directory to walk. Defaults to the workspace cwd (`.`). Results are capped at 100 files.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'multi_edit',
        title: 'Multi Edit',
        annotations: { title: 'Multi Edit', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Apply several ordered replacements to ONE file in a single call. Edits are chained in memory first; if any `old_string` fails to match uniquely (or at all) the file is left untouched. `replace_all:true` per entry drops the uniqueness requirement.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or cwd-relative path to the single file receiving all edits.' },
                edits: {
                    type: 'array',
                    description: 'Ordered list of replacements applied in sequence to the in-memory content. Any failure aborts before the file is written, so the tree never lands in a half-edited state.',
                    items: {
                        type: 'object',
                        properties: {
                            old_string: { type: 'string', description: 'Exact text to find. Must be unique in the current (post-prior-edits) content unless `replace_all:true`.' },
                            new_string: { type: 'string', description: 'Replacement text.' },
                            replace_all: { type: 'boolean', description: 'When true, replace every occurrence and skip the uniqueness check. Defaults to false.' },
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
        description: 'Read several files in one call. Each entry in `reads` is { path, offset?, limit? } with the same semantics as a single read. Returns `### <path>` delimited sections; per-file errors appear inline and do not abort the batch.',
        inputSchema: {
            type: 'object',
            properties: {
                reads: {
                    type: 'array',
                    description: 'List of read requests dispatched in parallel. Each entry reuses the single-read size cap and line-number formatting; per-file errors are inlined into the aggregate instead of aborting the batch.',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Absolute file path (relative paths resolve against the plugin server cwd).' },
                            offset: { type: 'number', description: 'Start line (0-based).' },
                            limit: { type: 'number', description: 'Max lines to read.' },
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
        description: 'Apply edits across several files in one call. Each entry in `edits` is { path, old_string, new_string } with the same unique-match rule as a single edit. Per-entry failures are reported inline (`FAIL <path>: <reason>`) and do not abort the batch.',
        inputSchema: {
            type: 'object',
            properties: {
                edits: {
                    type: 'array',
                    description: 'Cross-file edits dispatched sequentially through the single-edit path. Each entry is independent; failures are reported inline as `FAIL <path>: <reason>` and the batch continues.',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Absolute file path.' },
                            old_string: { type: 'string', description: 'Exact text to find (must be unique in the file).' },
                            new_string: { type: 'string', description: 'Replacement text.' },
                        },
                        required: ['path', 'old_string', 'new_string'],
                    },
                    minItems: 1,
                },
            },
            required: ['edits'],
        },
    },
    {
        name: 'skill_load',
        title: 'Skill Load',
        annotations: { title: 'Skill Load', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Load a Pool C role playbook by name. Internal dispatch only — normal callers should ignore.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Playbook name without extension (e.g. "explorer-playbook").' },
            },
            required: ['name'],
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
const _readFiles = new Set();

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
    if (!normalized.startsWith(baseCwd)) {
        // Allow home dir paths for reading configs
        const home = process.env.HOME || process.env.USERPROFILE || '';
        if (home && normalized.startsWith(normalize(home)))
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
            const cacheKey = `read|${fullPath}|${args.offset || 0}|${args.limit || 2000}`;
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
                return `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
            if (st.size > READ_MAX_SIZE_BYTES) {
                if (!hasRangeArgs) {
                    return `Error: file size ${st.size} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap. Use offset+limit to read a range.`;
                }
                try {
                    const out = await streamReadRange(fullPath, offset, limit);
                    _cacheSet(cacheKey, out);
                    _readFiles.add(fullPath);
                    return out;
                } catch (err) {
                    return `Error: ${err instanceof Error ? err.message : String(err)}`;
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
                _readFiles.add(fullPath);
                return out;
            }
            catch (err) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`;
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
            return results.map(r => `### ${r.path}\n${r.body}`).join('\n\n');
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
                return `Error [code 4]: file not found: ${filePath}`;
            }
            if (!_readFiles.has(fullPath)) {
                return `Error [code 6]: file has not been read yet — read before editing: ${filePath}`;
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
                _readFiles.add(fullPath);
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
                if (first.startsWith('Error:')) lines.push(`FAIL ${entry.path}: ${first.slice(7)}`);
                else lines.push(`OK ${entry.path}`);
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
                _readFiles.add(fullPath);
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
                return `Error [code 4]: file not found: ${filePath}`;
            }
            // Error [code 6]: Read-before-Edit enforcement. Prevents phantom
            // edits where the model invents an old_string based on cached
            // assumptions against a file that has drifted.
            if (!_readFiles.has(fullPath)) {
                return `Error [code 6]: file has not been read yet — read before editing: ${filePath}`;
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
                // Keep the entry: file is still known to this session and
                // subsequent edits against the just-written state are safe.
                _readFiles.add(fullPath);
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
            const headLimit = headLimitRaw === 0 ? Infinity : (headLimitRaw || 100);
            const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
            const cacheKey = `grep|${patterns.join('\x01')}|${searchPath}|${globPatterns.join('\x01')}|${outputMode}|${headLimit}|${offset}`;
            const cached = _cacheGet(cacheKey);
            if (cached !== null) return cached;
            try {
                const rgArgs = ['--color', 'never'];
                if (outputMode === 'files_with_matches') {
                    rgArgs.push('--files-with-matches');
                } else if (outputMode === 'count') {
                    rgArgs.push('--count');
                } else {
                    rgArgs.push('--no-heading', '--line-number');
                }
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
                const remaining = windowed.length - lines.length;
                const truncated = remaining > 0
                    ? `\n... [${remaining} more entries]`
                    : '';
                const out = capShellOutput((lines.join('\n') + truncated) || '(no matches)');
                _cacheSet(cacheKey, out);
                return out;
            }
            catch {
                return '(no matches)';
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
            const capped = unique.slice(0, 100);
            const out = capShellOutput(capped.join('\n') || '(no files found)');
            _cacheSet(cacheKey, out);
            return out;
        }
        case 'skill_load': {
            const rawName = String(args?.name || '').trim();
            if (!rawName) return 'Error: name is required';
            // Whitelist: only pool-c playbooks, kebab/underscore case ending in "-playbook"
            if (!/^[a-z0-9_-]+-playbook$/i.test(rawName)) {
                return `Error: playbook name must match /^[a-z0-9_-]+-playbook$/i — got ${JSON.stringify(rawName)}`;
            }
            const root = process.env.CLAUDE_PLUGIN_ROOT
                || resolve(process.env.HOME || process.env.USERPROFILE || '', '.claude/plugins/marketplaces/trib-plugin/external_plugins/trib-plugin');
            const filePath = resolve(root, 'skills/pool-c', `${rawName}.md`);
            try {
                const raw = readFileSync(filePath, 'utf8');
                // Strip YAML frontmatter if present (--- ... ---)
                const m = raw.match(/^---\n[\s\S]*?\n---\n/);
                const body = m ? raw.slice(m[0].length) : raw;
                return `Base directory for this playbook: ${resolve(root, 'skills/pool-c')}\n\n${body.trim()}`;
            } catch (err) {
                return `Error: failed to load playbook "${rawName}" — ${err instanceof Error ? err.message : String(err)}`;
            }
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
