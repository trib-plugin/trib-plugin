import { exec, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, statSync, existsSync, createReadStream, readdirSync, mkdirSync, openSync, readSync, closeSync } from 'fs';
import { readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { promisify } from 'util';
import { homedir } from 'os';
const execAsync = promisify(exec);
import { resolve, normalize, isAbsolute, relative, dirname, basename, extname, join, sep } from 'path';

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
    if (process.platform !== 'win32') return posixPath;  // safety guard — Linux paths like /c/Users are valid absolute paths
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
    // `~` expansion — callers can pass `~/.claude/...` without hardcoding
    // the user's home. Matches Claude Code's expandPath semantics so MCP
    // tool args stay portable across machines. Bare `~` and `~\` also
    // handled for Windows-quoted strings. `~user/...` (named-home) is NOT
    // expanded — POSIX-only and rarely used in MCP call sites.
    if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
        out = homedir() + out.slice(1);
    }
    if (process.platform === 'win32') {
        const looksPosixDrive = /^\/[a-zA-Z]\//.test(out);
        const looksCygdrive = /^\/cygdrive\/[a-zA-Z]\//.test(out);
        const looksUnc = out.startsWith('//');
        if (looksPosixDrive || looksCygdrive || looksUnc) {
            out = posixPathToWindowsPath(out);
        }
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
    if (process.platform !== 'win32') return p;
    // Forward-slash unify + drive letter uppercase. LSP / fileURLToPath
    // returns `c:/...` lowercase, but every other tool emits `C:/...`
    // uppercase — this single point keeps the convention consistent.
    return p.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':');
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

// Shared display helper: produce the cwd-relative, forward-slash path the
// model sees. list / tree / find_files / lsp.mjs all need the same recipe;
// exporting it here keeps the convention (relative when inside cwd, normalized
// separators) pinned to one location.
export function toDisplayPath(abs, cwd) {
    return normalizeOutputPath(cwdRelativePath(abs, cwd));
}

// ISO-ish mtime formatter shared by list / find_files. A single hyphen is
// used for zero/missing mtime so entries that failed stat still render a
// stable column.
function formatMtime(mtimeMs) {
    if (!mtimeMs) return '-';
    return new Date(mtimeMs).toISOString().slice(0, 19).replace('T', ' ');
}

// Shared file-open prologue for read-flavoured tools (tail / wc / diff).
// Consolidates the normalize → isSafePath → stat → findSimilarFile-hint →
// size-cap sequence so every consumer funnels through the same pipeline
// (F9 / F12). Throws tagged errors (code=EARG/EOUTSIDE/ENOENT/ETOOBIG)
// instead of returning strings so callers can branch on ETOOBIG for
// large-file fallbacks without resorting to message regexes.
//
// B35 note: `err.message` is returned verbatim by callers — no
// String.prototype.replace with substitution-capable strings. If a caller
// needs to massage the message, use an arrow-function replacer.
async function openForRead(filePath, workDir) {
    if (typeof filePath !== 'string' || !filePath) {
        throw Object.assign(new Error('path is required'), { code: 'EARG' });
    }
    const norm = normalizeInputPath(filePath);
    if (!isSafePath(norm, workDir)) {
        throw Object.assign(
            new Error(`path outside allowed scope — ${normalizeOutputPath(norm)}`),
            { code: 'EOUTSIDE' });
    }
    const fullPath = resolveAgainstCwd(norm, workDir);
    let st;
    try { st = statSync(fullPath); }
    catch (err) {
        const similar = findSimilarFile(fullPath);
        const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
        const msg = normalizeErrorMessage(err instanceof Error ? err.message : String(err)) + hint;
        throw Object.assign(new Error(msg), { code: 'ENOENT' });
    }
    if (st.size > READ_MAX_SIZE_BYTES) {
        throw Object.assign(
            new Error(`file size ${st.size} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap`),
            { code: 'ETOOBIG', size: st.size, fullPath, st });
    }
    const content = await readFile(fullPath, 'utf-8');
    return { fullPath, content, displayPath: normalizeOutputPath(norm), st };
}

// Simple glob-to-RegExp compiler for name filters (find_files, future
// tools). Callers pass foo*.mjs style patterns, not full brace/POSIX-class
// globs. The arrow-function form of .replace is mandatory here: B35
// (v0.6.216) demonstrated that String.prototype.replace with a string
// replacement interprets substitution sequences and silently corrupts
// patterns that happen to contain them. The arrow form opts out of
// substitution entirely.
function compileSimpleGlob(pattern) {
    if (!pattern) return null;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, (ch) => '\\' + ch);
    const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    const DOLLAR = '\x24';
    return new RegExp('^' + body + DOLLAR, 'i');
}

// Unified directory walk used by list / tree / find_files. The visitor
// callback owns the "should I record this entry?" decision; returning
// literal false aborts the whole walk (used by list / find_files to stop
// as soon as head_limit is satisfied, fixing F1 where the old loops kept
// stat-calling entries after reaching the cap).
//
// - hidden:false skips dotfiles before the visitor runs
// - maxDepth limits recursion (1 = direct children only)
// - sort runs per-directory before visiting, so ordering is stable
// - visit(ent, entPath, ctx) where ctx = { depth, index, total, isLast }
//   exposes per-level ordering so tree-style renderers can draw branch
//   prefixes without reimplementing the walk.
function walkDir(root, { hidden = false, maxDepth = Infinity, visit, sort } = {}) {
    const _walk = (dir, depth) => {
        if (depth > maxDepth) return true;
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); }
        catch { return true; }
        if (!hidden) entries = entries.filter(e => !e.name.startsWith('.'));
        if (sort) entries.sort(sort);
        const total = entries.length;
        for (let i = 0; i < total; i++) {
            const ent = entries[i];
            const entPath = join(dir, ent.name);
            const ctx = { depth, index: i, total, isLast: i === total - 1 };
            const cont = visit(ent, entPath, ctx);
            if (cont === false) return false;
            if (ent.isDirectory()) {
                if (_walk(entPath, depth + 1) === false) return false;
            }
        }
        return true;
    };
    _walk(root, 1);
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
        name: 'edit_lines',
        title: 'Edit Lines (line-number based)',
        annotations: { title: 'Edit Lines', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Replace lines [start_line, end_line] inclusive (1-based) with new_content. Use this when unique-string match in `edit` / `multi_edit` is awkward — large files, repeated substrings, or pure line-replace. Pair with `read` (note line numbers) -> `edit_lines`. mtime drift is enforced like `edit`: must `read` first; concurrent external writes return errorCode 7.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path. Supports `~` expansion.' },
                start_line: { type: 'number', description: 'First line to replace (1-based, inclusive).' },
                end_line: { type: 'number', description: 'Last line to replace (1-based, inclusive). Must be >= start_line.' },
                new_content: { type: 'string', description: 'Replacement content. Newlines inside are preserved. Set empty string to delete the range.' },
            },
            required: ['path', 'start_line', 'end_line', 'new_content'],
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
        name: 'list',
        title: 'List Directory',
        annotations: { title: 'List Directory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Directory listing with metadata (name, type, size, mtime). Faster + more useful than `bash ls` because it returns parseable rows and respects head_limit. For pure path-pattern search use `glob` (rg --files backend); for content search use `grep`. Defaults to depth 1 — increase for recursive walk.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory to list. Defaults to cwd. Supports `~` expansion.' },
                depth: { type: 'number', description: 'Recursion depth (1 = direct children only, max 10). Default 1.' },
                hidden: { type: 'boolean', description: 'Include dotfiles (`.foo`). Default false.' },
                sort: { type: 'string', enum: ['name', 'mtime', 'size'], description: 'Sort key. Default name.' },
                type: { type: 'string', enum: ['any', 'file', 'dir'], description: 'Filter by entry type. Default any.' },
                head_limit: { type: 'number', description: 'Max rows. Default 200, 0 = unlimited.' },
            },
            required: [],
        },
    },
    {
        name: 'tree',
        title: 'Directory Tree',
        annotations: { title: 'Directory Tree', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'ASCII directory tree visualization. Quick way to grasp project shape before diving in. For metadata (size/mtime) use `list`; for content search use `grep`. Defaults to depth 3.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Root directory. Defaults to cwd. Supports `~` expansion.' },
                depth: { type: 'number', description: 'Tree depth (1-6). Default 3.' },
                hidden: { type: 'boolean', description: 'Include dotfiles. Default false.' },
                head_limit: { type: 'number', description: 'Max lines. Default 200, 0 = unlimited.' },
            },
            required: [],
        },
    },
    {
        name: 'find_files',
        title: 'Find Files (metadata filter)',
        annotations: { title: 'Find Files', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Find files by metadata — name pattern, size range, modification time range, type. Complements `glob` (path patterns) and `grep` (content). Useful for "files modified in the last 24h", "files larger than 10MB", etc.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Root directory. Defaults to cwd.' },
                name: { type: 'string', description: 'Glob pattern for filename (e.g. `*.mjs`). Optional.' },
                type: { type: 'string', enum: ['any', 'file', 'dir'], description: 'Entry type filter. Default any.' },
                min_size: { type: 'number', description: 'Minimum size in bytes (file only). Optional.' },
                max_size: { type: 'number', description: 'Maximum size in bytes (file only). Optional.' },
                modified_after: { type: 'string', description: 'ISO 8601 date or relative `Nh`/`Nd` (e.g. `24h`, `7d`). Optional.' },
                modified_before: { type: 'string', description: 'ISO 8601 date or relative `Nh`/`Nd`. Optional.' },
                head_limit: { type: 'number', description: 'Max results. Default 100, 0 = unlimited.' },
            },
            required: [],
        },
    },
    {
        name: 'head',
        title: 'Head N Lines',
        annotations: { title: 'Head N Lines', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Read the first N lines of a file. Cleaner than `read` with offset:0+limit:N when you just want a quick peek at the top of a file. For middle-of-file ranges use `read` with offset/limit.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path. Supports `~` expansion.' },
                n: { type: 'number', description: 'Number of lines to read from the top. Default 20.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'tail',
        title: 'Tail N Lines',
        annotations: { title: 'Tail N Lines', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Read the last N lines of a file — typically used for log inspection. For full-file or specific ranges use `read`.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path. Supports `~` expansion.' },
                n: { type: 'number', description: 'Number of lines from the bottom. Default 20.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'wc',
        title: 'Word Count',
        annotations: { title: 'Word Count', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Count lines, words, and bytes of a file. Faster than reading the whole file when you just need size metrics. Word count is skipped for files exceeding the read cap (256 KB) — lines/bytes only.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path. Supports `~` expansion.' },
            },
            required: ['path'],
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
    {
        name: 'diff',
        title: 'Unified Diff',
        annotations: { title: 'Unified Diff', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Unified diff between two files (or two raw strings). Useful for explaining a change before applying it via `edit` / `multi_edit`. Output is standard `--- from\n+++ to\n@@ ... @@` format. Pass `from_text:true` and/or `to_text:true` to treat the value as inline text instead of a path.',
        inputSchema: {
            type: 'object',
            properties: {
                from: { type: 'string', description: 'Path of the "before" file, or raw text when `from_text:true`.' },
                to: { type: 'string', description: 'Path of the "after" file, or raw text when `to_text:true`.' },
                from_text: { type: 'boolean', description: 'Treat `from` as inline text. Default false.' },
                to_text: { type: 'boolean', description: 'Treat `to` as inline text. Default false.' },
                context: { type: 'number', description: 'Context lines around hunks. Default 3, clamp [0, 10].' },
            },
            required: ['from', 'to'],
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
// Anchor for "command start": line start, after ; && || | (with optional whitespace)
const _CMD_START = '(?:^|[;&|\\n(){}]\\s*|\\$[\\({]\\s*|[<>]\\(\\s*|`\\s*)';
const BLOCKED_PATTERNS = [
    /\brm\s+-rf\s+[/~]/i,
    /\bgit\s+push\s+--force/i,
    /\bgit\s+reset\s+--hard/i,
    /\bformat\s+[a-z]:/i,
    /\b(shutdown|reboot|halt)\b/i,
    /\bdel\s+\/[sfq]/i,
    new RegExp(_CMD_START + 'mkfs(?:\\.|\\b)', 'i'),
    new RegExp(_CMD_START + 'dd\\s+[^\\n]*\\bif=/dev/', 'i'),
    new RegExp(_CMD_START + 'diskpart\\b[^\\n]*\\bclean\\b', 'i'),
    /:\(\)\s*\{[^}]*:\|:&[^}]*\};\s*:/, // bash fork-bomb signature (idempotent string)
];
function isSafePath(filePath, cwd) {
    const baseCwd = normalize(resolve(cwd));
    const normalized = normalize(resolve(baseCwd, filePath));
    // Boundary-aware containment check: a path is "inside" baseCwd iff
    // it equals baseCwd or starts with baseCwd + separator. Without the
    // trailing-separator guard, `/home/u` would falsely contain
    // `/home/u2`. Windows uses case-insensitive compare (NTFS default).
    const isInside = (child, parent) => {
        if (!parent) return false;
        const c = process.platform === 'win32' ? child.toLowerCase() : child;
        const p = process.platform === 'win32' ? parent.toLowerCase() : parent;
        if (c === p) return true;
        return c.startsWith(p.endsWith(sep) ? p : p + sep);
    };
    if (!isInside(normalized, baseCwd)) {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        if (home && isInside(normalized, normalize(home))) return true;
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
// --- Unified diff computation (LCS-based) ---
//
// Self-contained unified diff so the plugin does not need to take on an
// external `diff` npm dep. LCS dynamic-programming table is O(n*m) memory
// and time — fine for the file sizes the builtin tools already gate
// through (read cap keeps inputs well under 10k lines in practice). For
// truly large inputs we fall back to a "files differ" summary rather
// than spending multi-GB on the DP table.
function computeUnifiedDiff(a, b, ctx, fromLabel, toLabel) {
    const n = a.length, m = b.length;
    // Guard: n * m > 4M cells (~16 MB Int32Array rows total) — bail out.
    if (n > 10000 || m > 10000 || n * m > 4_000_000) {
        if (n === m) {
            let same = true;
            for (let k = 0; k < n; k++) { if (a[k] !== b[k]) { same = false; break; } }
            if (same) return '';
        }
        return `--- ${fromLabel}\n+++ ${toLabel}\n(files too large for inline diff — ${n} vs ${m} lines)`;
    }

    // dp[i][j] = LCS length of a[i..] and b[j..].
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        const aI = a[i];
        const rowI = dp[i];
        const rowI1 = dp[i + 1];
        for (let j = m - 1; j >= 0; j--) {
            if (aI === b[j]) rowI[j] = rowI1[j + 1] + 1;
            else rowI[j] = rowI1[j] >= rowI[j + 1] ? rowI1[j] : rowI[j + 1];
        }
    }

    // Backtrack into an ops list. Each op: ['=', line] | ['-', line] | ['+', line].
    // aLine / bLine track 1-based line numbers for hunk headers.
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push(['=', a[i]]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; }
        else { ops.push(['+', b[j]]); j++; }
    }
    while (i < n) { ops.push(['-', a[i++]]); }
    while (j < m) { ops.push(['+', b[j++]]); }

    if (!ops.some(o => o[0] !== '=')) return '';

    // Split ops into hunks. A run of '=' longer than 2*ctx breaks a hunk;
    // we keep ctx leading + ctx trailing context lines around each change
    // cluster. Tracks original/target line numbers as we walk.
    const hunks = [];
    let aLine = 1, bLine = 1;
    let current = null;
    let eqRun = 0;

    const openHunk = (aStart, bStart) => ({ aStart, bStart, aCount: 0, bCount: 0, lines: [] });

    for (let k = 0; k < ops.length; k++) {
        const [op, line] = ops[k];
        if (op === '=') {
            if (current) {
                // Decide whether to absorb this context line or close the hunk.
                // Look ahead: is there another change within ctx lines?
                let nextChangeWithin = false;
                for (let la = 1; la <= ctx && k + la < ops.length; la++) {
                    if (ops[k + la][0] !== '=') { nextChangeWithin = true; break; }
                }
                if (nextChangeWithin || eqRun < ctx) {
                    current.lines.push([' ', line]);
                    current.aCount++;
                    current.bCount++;
                    eqRun++;
                } else {
                    // Close hunk; trailing ctx already appended during the
                    // first `ctx` equal lines after the last change.
                    hunks.push(current);
                    current = null;
                    eqRun = 0;
                }
            }
            aLine++;
            bLine++;
        } else {
            if (!current) {
                // Open a new hunk with up to `ctx` leading context from prior '=' ops.
                const leading = [];
                let leadA = 0, leadB = 0;
                for (let back = k - 1; back >= 0 && leading.length < ctx; back--) {
                    if (ops[back][0] !== '=') break;
                    leading.unshift([' ', ops[back][1]]);
                    leadA++; leadB++;
                }
                const aStart = aLine - leadA;
                const bStart = bLine - leadB;
                current = openHunk(aStart, bStart);
                current.lines.push(...leading);
                current.aCount += leadA;
                current.bCount += leadB;
            }
            if (op === '-') {
                current.lines.push(['-', line]);
                current.aCount++;
                aLine++;
            } else { // '+'
                current.lines.push(['+', line]);
                current.bCount++;
                bLine++;
            }
            eqRun = 0;
        }
    }
    if (current) hunks.push(current);

    const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
    for (const h of hunks) {
        const aHdr = h.aCount === 0 ? `${h.aStart - 1},0` : (h.aCount === 1 ? `${h.aStart}` : `${h.aStart},${h.aCount}`);
        const bHdr = h.bCount === 0 ? `${h.bStart - 1},0` : (h.bCount === 1 ? `${h.bStart}` : `${h.bStart},${h.bCount}`);
        out.push(`@@ -${aHdr} +${bHdr} @@`);
        for (const [sign, line] of h.lines) out.push(`${sign}${line}`);
    }
    return out.join('\n');
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
                    // spawnSync's 1MB default maxBuffer throws ENOBUFS on
                    // large outputs (e.g. 200k-line dumps). capShellOutput
                    // slices to SHELL_OUTPUT_MAX_CHARS anyway, so we just
                    // need enough headroom for the raw capture. *4 keeps
                    // the buffer proportional to the cap; cross-OS uniform.
                    maxBuffer: SHELL_OUTPUT_MAX_CHARS * 4,
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
                return `Error: path outside allowed scope — ${normalizeOutputPath(filePath)}`;
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
                const similar = findSimilarFile(fullPath);
                const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}${hint}`;
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
            if (!isSafePath(filePath, workDir)) return `Error: path outside allowed scope — ${normalizeOutputPath(filePath)}`;
            const fullPath = resolveAgainstCwd(filePath, workDir);
            // F2 fix: one stat syscall covers both existence check and mtime
            // read. existsSync + statSync was a TOCTOU window where the file
            // could vanish between probes; ENOENT from statSync now produces
            // the same file-not-found hint the existsSync branch used to.
            let mEditStat;
            try { mEditStat = statSync(fullPath); }
            catch (err) {
                if (err && err.code === 'ENOENT') {
                    const similar = findSimilarFile(fullPath);
                    const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                    return `Error [code 4]: file not found: ${filePath}${hint}`;
                }
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
            const mEditSnapshot = _readFiles.get(fullPath);
            if (!mEditSnapshot) {
                return `Error [code 6]: file has not been read yet — read before editing: ${filePath}`;
            }
            if (mEditStat.mtimeMs > mEditSnapshot.mtimeMs + 1) {
                return `Error [code 7]: file modified since read (lint / formatter / external write) — read it again before editing: ${filePath}`;
            }
            try {
                let content;
                try { content = readFileSync(fullPath, 'utf-8'); }
                catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
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
                        // B35 fix: String.prototype.replace(str, str) interprets
                        // substitution patterns (dollar-ampersand, dollar-digit,
                        // double-dollar, etc.) in the second arg and splices the
                        // matched text / capture groups / literal dollar into the
                        // result. Corrupts any new_string that legitimately contains
                        // such sequences (e.g. regex escape code in source). The
                        // function form opts out of substitution entirely.
                        content = content.replace(old_string, () => new_string);
                    }
                }
                writeFileSync(fullPath, content, 'utf-8');
                _cacheInvalidateAll();
                _recordReadSnapshot(fullPath);
                return `Edited: ${normalizeOutputPath(filePath)} (${edits.length} replacements applied)`;
            } catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
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
                    lines.push(`FAIL ${normalizeOutputPath(entry.path)}: ${msg}`);
                } else {
                    lines.push(`OK ${normalizeOutputPath(entry.path)}`);
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
                return `Error: path outside allowed scope — ${normalizeOutputPath(filePath)}`;
            try {
                const fullPath = resolveAgainstCwd(filePath, workDir);
                // Auto-create missing parent directories so deep new paths
                // like `.v0610_test/deep/nested/file.txt` succeed in one
                // shot, matching Claude Code's Write tool behaviour.
                // `recursive:true` is a no-op when the directory already
                // exists and is cross-OS safe (POSIX + NTFS).
                mkdirSync(dirname(fullPath), { recursive: true });
                writeFileSync(fullPath, content, 'utf-8');
                _cacheInvalidateAll();
                // Write establishes the on-disk state the model just
                // authored, so a subsequent Edit does not need a fresh
                // Read round-trip.
                _recordReadSnapshot(fullPath);
                return `Written: ${normalizeOutputPath(filePath)}`;
            }
            catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
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
                return `Error: path outside allowed scope — ${normalizeOutputPath(filePath)}`;
            const fullPath = resolveAgainstCwd(filePath, workDir);
            // F2 fix: single stat syscall replaces existsSync + statSync pair.
            // ENOENT -> Error [code 4] with similar-file hint; mtime drift ->
            // Error [code 7]. Collapsing the two probes also closes the TOCTOU
            // window where the file could be deleted between checks.
            let editStat;
            try { editStat = statSync(fullPath); }
            catch (err) {
                if (err && err.code === 'ENOENT') {
                    const similar = findSimilarFile(fullPath);
                    const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                    return `Error [code 4]: file not found: ${filePath}${hint}`;
                }
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
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
            if (editStat.mtimeMs > editSnapshot.mtimeMs + 1) {
                return `Error [code 7]: file modified since read (lint / formatter / external write) — read it again before editing: ${filePath}`;
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
                    : content.replace(oldStr, () => newStr);
                writeFileSync(fullPath, updated, 'utf-8');
                _cacheInvalidateAll();
                // Refresh the snapshot to the post-write mtime so a chain
                // of edits against the same file doesn't trip the stale
                // check on the second hop.
                _recordReadSnapshot(fullPath);
                return `Edited: ${normalizeOutputPath(filePath)}`;
            }
            catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
        }
        case 'edit_lines': {
            // v0.6.223: line-number based replacement. Complement to `edit` /
            // `multi_edit` for cases where unique-substring match is awkward
            // (large files, repeated lines, or pure line-replace). Shares the
            // same Read-before-Edit + mtime-drift contract as `edit`.
            args.path = normalizeInputPath(args.path);
            const filePath = args.path;
            const startLine = parseInt(args.start_line, 10);
            const endLine = parseInt(args.end_line, 10);
            const newContent = String(args.new_content ?? '');
            if (!filePath) return 'Error: path is required';
            if (!Number.isFinite(startLine) || startLine < 1) return 'Error: start_line must be >= 1';
            if (!Number.isFinite(endLine) || endLine < startLine) return 'Error: end_line must be >= start_line';
            if (!isSafePath(filePath, workDir))
                return `Error: path outside allowed scope — ${normalizeOutputPath(filePath)}`;
            const fullPath = resolveAgainstCwd(filePath, workDir);
            let elStat;
            try { elStat = statSync(fullPath); }
            catch (err) {
                if (err && err.code === 'ENOENT') {
                    const similar = findSimilarFile(fullPath);
                    const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                    return `Error [code 4]: file not found: ${filePath}${hint}`;
                }
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
            const elSnapshot = _readFiles.get(fullPath);
            if (!elSnapshot) {
                return `Error [code 6]: file has not been read yet — read before editing: ${filePath}`;
            }
            if (elStat.mtimeMs > elSnapshot.mtimeMs + 1) {
                return `Error [code 7]: file modified since read (lint / formatter / external write) — read it again before editing: ${filePath}`;
            }
            try {
                const content = readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n');
                const totalLines = lines.length;
                if (startLine > totalLines) return `Error: start_line ${startLine} exceeds file's ${totalLines} lines`;
                if (endLine > totalLines) return `Error: end_line ${endLine} exceeds file's ${totalLines} lines`;
                // Pure split/join — no String.prototype.replace second-arg
                // substitution pattern risk (B35). new_content is spliced
                // verbatim.
                const newLines = newContent === '' ? [] : newContent.split('\n');
                const updated = [
                    ...lines.slice(0, startLine - 1),
                    ...newLines,
                    ...lines.slice(endLine),
                ];
                const newFileContent = updated.join('\n');
                writeFileSync(fullPath, newFileContent, 'utf-8');
                _cacheInvalidateAll();
                _recordReadSnapshot(fullPath);
                const replacedCount = endLine - startLine + 1;
                const insertedCount = newLines.length;
                return `Edited: ${normalizeOutputPath(filePath)} (lines ${startLine}-${endLine} replaced, ${replacedCount} -> ${insertedCount} lines)`;
            }
            catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
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
        case 'list': {
            args.path = normalizeInputPath(args.path);
            const inputPath = args.path || '.';
            const depth = Math.min(Math.max(parseInt(args.depth ?? 1, 10) || 1, 1), 10);
            const hidden = Boolean(args.hidden);
            const sort = ['name', 'mtime', 'size'].includes(args.sort) ? args.sort : 'name';
            const typeFilter = ['any', 'file', 'dir'].includes(args.type) ? args.type : 'any';
            const headLimit = parseInt(args.head_limit ?? 200, 10);
            if (!isSafePath(inputPath, workDir)) {
                return `Error: path outside allowed scope — ${normalizeOutputPath(inputPath)}`;
            }
            const fullPath = resolveAgainstCwd(inputPath, workDir);
            let st;
            try { st = statSync(fullPath); }
            catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
            if (!st.isDirectory()) return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;

            const rows = [];
            // F5: walkDir handles dotfile filter, depth cap, and recursion.
            // Visitor returns false to abort the walk once headLimit is
            // satisfied (F1 fix — old loop kept stat-calling after cap).
            walkDir(fullPath, {
                hidden,
                maxDepth: depth,
                visit: (ent, entPath) => {
                    const isDir = ent.isDirectory();
                    const isFile = ent.isFile();
                    if (typeFilter === 'file' && !isFile) return;
                    if (typeFilter === 'dir' && !isDir) return;
                    const entType = isDir ? 'dir' : (isFile ? 'file' : (ent.isSymbolicLink() ? 'symlink' : 'other'));
                    let size = 0, mtimeMs = 0;
                    try { const s = statSync(entPath); size = s.size; mtimeMs = s.mtimeMs; }
                    catch { /* keep zero */ }
                    rows.push({ path: cwdRelativePath(entPath, workDir), type: entType, size, mtimeMs });
                    if (headLimit > 0 && rows.length >= headLimit) return false;
                },
            });

            if (sort === 'mtime') rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
            else if (sort === 'size') rows.sort((a, b) => b.size - a.size);
            else rows.sort((a, b) => a.path.localeCompare(b.path));

            const sliced = headLimit > 0 ? rows.slice(0, headLimit) : rows;
            const lines = sliced.map(r =>
                `${normalizeOutputPath(r.path)}\t${r.type}\t${r.size}\t${formatMtime(r.mtimeMs)}`);
            if (rows.length > sliced.length) lines.push(`... ${rows.length - sliced.length} more entries`);
            return lines.join('\n') || '(empty directory)';
        }
        case 'tree': {
            args.path = normalizeInputPath(args.path);
            const inputPath = args.path || '.';
            const depth = Math.min(Math.max(parseInt(args.depth ?? 3, 10) || 3, 1), 6);
            const hidden = Boolean(args.hidden);
            const headLimit = parseInt(args.head_limit ?? 200, 10);
            if (!isSafePath(inputPath, workDir)) {
                return `Error: path outside allowed scope — ${normalizeOutputPath(inputPath)}`;
            }
            const fullPath = resolveAgainstCwd(inputPath, workDir);
            let st;
            try { st = statSync(fullPath); }
            catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
            if (!st.isDirectory()) return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;
            const lines = [`${normalizeOutputPath(basename(fullPath))}/`];
            // F5: share walkDir with list / find_files. Prefix state lives in
            // a stack keyed by depth — walkDir exposes {depth, index, total,
            // isLast} via ctx so branch drawing works without an own walk.
            const prefixStack = [''];
            walkDir(fullPath, {
                hidden,
                maxDepth: depth,
                sort: (a, b) => {
                    const ad = a.isDirectory(), bd = b.isDirectory();
                    if (ad !== bd) return ad ? -1 : 1;
                    return a.name.localeCompare(b.name);
                },
                visit: (ent, _entPath, ctx) => {
                    const prefix = prefixStack[ctx.depth - 1] || '';
                    const branch = ctx.isLast ? '└── ' : '├── ';
                    const display = ent.isDirectory() ? `${ent.name}/` : ent.name;
                    lines.push(`${prefix}${branch}${display}`);
                    if (ent.isDirectory()) {
                        prefixStack[ctx.depth] = prefix + (ctx.isLast ? '    ' : '│   ');
                    }
                    if (headLimit > 0 && lines.length >= headLimit) return false;
                },
            });
            if (headLimit > 0 && lines.length >= headLimit) lines.push('... (truncated, increase head_limit)');
            return lines.join('\n');
        }
        case 'find_files': {
            args.path = normalizeInputPath(args.path);
            const inputPath = args.path || '.';
            const namePattern = typeof args.name === 'string' ? args.name : null;
            const typeFilter = ['any', 'file', 'dir'].includes(args.type) ? args.type : 'any';
            const minSize = typeof args.min_size === 'number' ? args.min_size : null;
            const maxSize = typeof args.max_size === 'number' ? args.max_size : null;
            const headLimit = parseInt(args.head_limit ?? 100, 10);

            const parseTime = (v) => {
                if (typeof v !== 'string') return null;
                const m = v.match(/^(\d+)([hd])$/);
                if (m) {
                    const n = parseInt(m[1], 10);
                    const unit = m[2] === 'h' ? 3600 * 1000 : 86400 * 1000;
                    return Date.now() - n * unit;
                }
                const t = Date.parse(v);
                return isNaN(t) ? null : t;
            };
            const after = parseTime(args.modified_after);
            const before = parseTime(args.modified_before);

            // F6: glob-to-regex compiler extracted so the $-escape safety
            // note lives in one place (see compileSimpleGlob).
            const nameRegex = compileSimpleGlob(namePattern);

            if (!isSafePath(inputPath, workDir)) {
                return `Error: path outside allowed scope — ${normalizeOutputPath(inputPath)}`;
            }
            const fullPath = resolveAgainstCwd(inputPath, workDir);
            let rootStat;
            try { rootStat = statSync(fullPath); }
            catch (err) { return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`; }
            if (!rootStat.isDirectory()) return `Error: not a directory — ${normalizeOutputPath(fullPath)}`;

            const matches = [];
            // F5: walkDir handles dotfile skip + recursion. Returning false
            // stops the walk as soon as headLimit is satisfied (F1 fix).
            walkDir(fullPath, {
                hidden: false,
                visit: (ent, entPath) => {
                    const isDir = ent.isDirectory();
                    const isFile = ent.isFile();
                    if (typeFilter === 'file' && !isFile) return;
                    if (typeFilter === 'dir' && !isDir) return;
                    if (nameRegex && !nameRegex.test(ent.name)) return;
                    let stat;
                    try { stat = statSync(entPath); } catch { return; }
                    if (isFile) {
                        if (minSize !== null && stat.size < minSize) return;
                        if (maxSize !== null && stat.size > maxSize) return;
                    }
                    if (after !== null && stat.mtimeMs < after) return;
                    if (before !== null && stat.mtimeMs > before) return;
                    matches.push({ path: cwdRelativePath(entPath, workDir), size: stat.size, mtimeMs: stat.mtimeMs });
                    if (headLimit > 0 && matches.length >= headLimit) return false;
                },
            });

            matches.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
            const lines = matches.map(m =>
                `${normalizeOutputPath(m.path)}\t${m.size}\t${formatMtime(m.mtimeMs)}`);
            return lines.join('\n') || '(no matches)';
        }
        case 'head': {
            // Thin wrapper around `read` with offset:0+limit:n. Keeps all
            // caching, safe-path, and size-cap semantics in one place.
            const n = Math.max(1, Math.min(parseInt(args.n ?? 20, 10) || 20, 2000));
            return executeBuiltinTool('read', { path: args.path, offset: 0, limit: n }, workDir);
        }
        case 'tail': {
            const n = Math.max(1, Math.min(parseInt(args.n ?? 20, 10) || 20, 2000));
            // F9: share normalize/isSafePath/stat/similar-hint with wc/diff
            // via openForRead. ETOOBIG escapes to the large-file fallback
            // so behaviour is unchanged for files past READ_MAX_SIZE_BYTES.
            let opened;
            try { opened = await openForRead(args.path, workDir); }
            catch (err) {
                if (err && err.code === 'ETOOBIG') {
                    try {
                        const { fullPath, st } = err;
                        // Large-file fallback: read only the trailing window. 200
                        // bytes/line is a rough average; the tail slice after split
                        // may be slightly > or < n lines — marked as (approx) so
                        // the caller knows line numbers are not from file start.
                        const tailBytes = Math.min(st.size, Math.max(n * 200, 4096));
                        const fd = openSync(fullPath, 'r');
                        const buf = Buffer.alloc(tailBytes);
                        try { readSync(fd, buf, 0, tailBytes, st.size - tailBytes); }
                        finally { closeSync(fd); }
                        const text = buf.toString('utf-8');
                        const tailLines = text.split('\n');
                        // First fragment is likely a partial line — drop it when
                        // we didn't start from byte 0 of the file.
                        if (tailBytes < st.size && tailLines.length > 1) tailLines.shift();
                        if (tailLines.length > 0 && tailLines[tailLines.length - 1] === '') tailLines.pop();
                        const sliced = tailLines.slice(-n);
                        // F10: cap large-window output so a multi-MB last-chunk
                        // doesn't blow past SHELL_OUTPUT_MAX_CHARS downstream.
                        return capShellOutput(sliced.map((l, i) => `(approx)${i + 1}\t${l}`).join('\n'));
                    } catch (err2) {
                        return `Error: ${normalizeErrorMessage(err2 instanceof Error ? err2.message : String(err2))}`;
                    }
                }
                return `Error: ${err.message}`;
            }
            const lines = opened.content.split('\n');
            // Trailing newline produces an empty element — drop it so
            // the reported line count matches what `wc -l` would show.
            if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
            const sliced = lines.slice(-n);
            const startIdx = lines.length - sliced.length;
            // F10: apply the same output cap used by shell/grep/find_files
            // so pathological single-line files (e.g. minified bundles)
            // don't dump 200 KB into the model context.
            return capShellOutput(sliced.map((l, i) => `${startIdx + i + 1}\t${l}`).join('\n'));
        }
        case 'wc': {
            // F9: share normalize/isSafePath/stat/similar-hint with tail/diff
            // via openForRead. ETOOBIG escapes to the streaming fallback so
            // files past READ_MAX_SIZE_BYTES still report lines + bytes.
            let opened;
            try { opened = await openForRead(args.path, workDir); }
            catch (err) {
                if (err && err.code === 'ETOOBIG') {
                    // F11: words are skipped for files past the cap because
                    // computing them needs the full content. The tool
                    // description advertises this limitation explicitly.
                    let lines = 0;
                    const stream = createReadStream(err.fullPath, { encoding: 'utf-8' });
                    const rl = createInterface({ input: stream, crlfDelay: Infinity });
                    for await (const _ of rl) lines++;
                    return `lines\t${lines}\twords\t-\tbytes\t${err.size}\t(words skipped: file > cap)`;
                }
                return `Error: ${err.message}`;
            }
            const { content, st } = opened;
            // Trailing newline should not inflate the line count — this
            // matches `wc -l` behaviour (final newline terminates, does
            // not begin, a new line).
            const lines = content.length === 0
                ? 0
                : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
            const words = (content.match(/\S+/g) || []).length;
            return `lines\t${lines}\twords\t${words}\tbytes\t${st.size}`;
        }
        case 'diff': {
            let fromContent, toContent;
            let fromLabel = args.from_text ? '(text)' : String(args.from ?? '');
            let toLabel = args.to_text ? '(text)' : String(args.to ?? '');
            // F12: route file-mode reads through openForRead so diff
            // inherits the same size-cap (ETOOBIG), safe-path, and
            // similar-file hint behaviour as read/tail/wc. Previously the
            // raw readFile call sidestepped all three and would happily
            // slurp a multi-MB file into memory with no hint on typos.
            try {
                if (args.from_text) {
                    fromContent = String(args.from ?? '');
                } else {
                    if (args.from == null || args.from === '') return 'Error: from is required';
                    const opened = await openForRead(args.from, workDir);
                    fromContent = opened.content;
                    fromLabel = opened.displayPath;
                }
                if (args.to_text) {
                    toContent = String(args.to ?? '');
                } else {
                    if (args.to == null || args.to === '') return 'Error: to is required';
                    const opened = await openForRead(args.to, workDir);
                    toContent = opened.content;
                    toLabel = opened.displayPath;
                }
            } catch (err) {
                // err.message is already normalized/hinted by openForRead —
                // no String.replace with substitution-capable strings (B35).
                return `Error: ${err.message}`;
            }
            const rawCtx = parseInt(args.context ?? 3, 10);
            const context = Math.max(0, Math.min(Number.isFinite(rawCtx) ? rawCtx : 3, 10));
            // Drop the trailing empty entry split produces for newline-terminated files.
            const splitLines = (s) => {
                const parts = s.split('\n');
                if (parts.length > 0 && parts[parts.length - 1] === '' && s.endsWith('\n')) parts.pop();
                return parts;
            };
            const fromLines = splitLines(fromContent);
            const toLines = splitLines(toContent);
            const out = computeUnifiedDiff(fromLines, toLines, context, fromLabel, toLabel);
            return out || '(no differences)';
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
