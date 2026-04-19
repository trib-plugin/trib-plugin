import { execSync, exec } from 'child_process';
import { readFileSync, writeFileSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
const execAsync = promisify(exec);
import { resolve, normalize } from 'path';

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

// --- Tool definitions for external models ---
// `searchHint` mirrors Anthropic's Tool.searchHint — short capability phrase
// for keyword-based discovery (used by future ToolSearch integration).
export const BUILTIN_TOOLS = [
    {
        name: 'bash',
        searchHint: 'shell command terminal execute',
        description: 'Executes a given bash command and returns its output.\n\nIMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands when a dedicated tool would work — use `glob` for filename patterns, `grep` for content search, `read` for file contents. Bash is for shell operations that require command composition (git, npm, build scripts, multi-step pipelines).',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The shell command to execute' },
                timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000, max: 600000)' },
            },
            required: ['command'],
        },
    },
    {
        name: 'read',
        searchHint: 'read file contents lines',
        description: `Reads a file from the local filesystem and returns its contents.\n\nUsage:\n- Pass an absolute path. Reads up to 2000 lines starting from the beginning by default.\n- For large files, use offset (0-based start line) and limit (max lines) to read targeted slices.\n- Hard cap: files larger than ${Math.round(READ_MAX_SIZE_BYTES/1024)} KB are rejected pre-read with a small error response. Output is truncated at ${Math.round(READ_MAX_OUTPUT_BYTES/1024)} KB.\n- This tool reads files only, not directories. Use \`glob\` to enumerate directory contents.\n- Results are returned in cat -n format (line number + tab + content).`,
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or cwd-relative file path to read' },
                offset: { type: 'number', description: 'Start line (0-based). Defaults to 0.' },
                limit: { type: 'number', description: 'Max lines to read. Defaults to 2000.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'write',
        searchHint: 'write create file content',
        description: 'Write content to a file (creates or overwrites). Path must be within the working directory scope.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to write' },
                content: { type: 'string', description: 'Content to write' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'edit',
        searchHint: 'edit replace string file modify',
        description: 'Replace a string in a file. `old_string` must appear exactly once in the file (unique match required).',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to edit' },
                old_string: { type: 'string', description: 'Exact text to find (must be unique in the file)' },
                new_string: { type: 'string', description: 'Replacement text' },
            },
            required: ['path', 'old_string', 'new_string'],
        },
    },
    {
        name: 'multi_edit',
        searchHint: 'edit same file many replacements',
        description: 'Apply several replacements to ONE file in a single tool call. Each entry in `edits` is {old_string, new_string, replace_all?} and is applied in order against the same path; each old_string must match uniquely at its turn (unless `replace_all:true`). If any entry fails, the call reports the error and leaves the file untouched — all-or-nothing semantics (matches Claude Code native MultiEdit).',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to edit' },
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            old_string: { type: 'string', description: 'Exact text to find (must be unique at apply time unless replace_all is true)' },
                            new_string: { type: 'string', description: 'Replacement text' },
                            replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
                        },
                        required: ['old_string', 'new_string'],
                    },
                    minItems: 1,
                    description: 'Replacements applied in order to the same file.',
                },
            },
            required: ['path', 'edits'],
        },
    },
    {
        name: 'batch_edit',
        searchHint: 'edit multiple files batch replace cross',
        description: 'Apply edits across SEVERAL files in a single tool call — each entry is {path, old_string, new_string} with the same unique-match rules as `edit`. Per-entry errors are reported inline and do not abort the batch; subsequent entries still run. Use this when the change set touches many files; use `multi_edit` when it is many replacements inside one file.\n\nReturns one line per edit: `OK <path>` or `FAIL <path>: <reason>`.',
        inputSchema: {
            type: 'object',
            properties: {
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'File path to edit' },
                            old_string: { type: 'string', description: 'Exact text to find (must be unique in the file)' },
                            new_string: { type: 'string', description: 'Replacement text' },
                        },
                        required: ['path', 'old_string', 'new_string'],
                    },
                    minItems: 1,
                    description: 'Edits in apply order across any paths. Same file can appear multiple times — each entry re-reads the file.',
                },
            },
            required: ['edits'],
        },
    },
    {
        name: 'multi_read',
        searchHint: 'read multiple files batch parallel',
        description: 'Read several files in a single tool call — each entry in `reads` is processed with the same rules as `read` (size cap, offset/limit, cat -n formatting). Prefer this over chaining multiple `read` calls when you already know the paths you want, because it collapses N iterations into 1 and saves a round-trip of prompt growth per file.\n\nReturns a single string with each file delimited by a `### <path>` header. Per-file errors are surfaced inline and do not abort the batch.',
        inputSchema: {
            type: 'object',
            properties: {
                reads: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Absolute or cwd-relative file path to read' },
                            offset: { type: 'number', description: 'Start line (0-based). Defaults to 0.' },
                            limit: { type: 'number', description: 'Max lines to read. Defaults to 2000.' },
                        },
                        required: ['path'],
                    },
                    minItems: 1,
                    description: 'Per-file read specs. Each entry accepts the same arguments as `read`.',
                },
            },
            required: ['reads'],
        },
    },
    {
        name: 'grep',
        searchHint: 'search regex content ripgrep',
        description: 'A powerful search tool built on ripgrep.\n\nUsage:\n- ALWAYS use grep for content search. NEVER invoke `grep` or `rg` via the bash tool.\n- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+").\n- `pattern` accepts a single regex or an array of regexes — an array is OR-joined inside one rg invocation (a single turn replaces N separate grep calls).\n- Filter files with the `glob` parameter (e.g., "*.ts", "*.{js,jsx}"); `glob` also accepts an array for multi-extension OR filtering.\n- Output modes: "files_with_matches" (default — paths only, lowest token cost), "content" (matched lines with path+line number), "count" (per-file match counts). Prefer `files_with_matches` for broad searches and chase down specific files with `read` afterwards.\n- `head_limit` caps output entries (default 100 across all modes).',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Regex pattern (or array for OR-join).',
                },
                path: { type: 'string', description: 'Directory or file to search in (default: cwd)' },
                glob: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'File pattern filter — string or array of globs (OR-joined).',
                },
                output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'], description: 'Output mode. Defaults to "files_with_matches".' },
                head_limit: { type: 'number', description: 'Max entries to return (default 100). Pass 0 for unlimited.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'glob',
        searchHint: 'find files filename pattern wildcard',
        description: 'Find files matching a glob pattern.\n\nUsage:\n- Use for filename / path-pattern search. NEVER invoke `find` or `ls` via the bash tool when glob suffices.\n- Returns file paths only (not contents). Use `grep` for content search and `read` to inspect specific files.\n- `pattern` accepts a single glob or an array of globs — an array is OR-joined (one call replaces N separate glob calls).\n- Patterns like "**/*.ts" or "src/**/*.{js,jsx}" are supported.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Glob pattern or array of patterns (OR-joined).',
                },
                path: { type: 'string', description: 'Base directory (default: cwd)' },
            },
            required: ['pattern'],
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
                const result = execSync(command, {
                    encoding: 'utf-8',
                    timeout,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    cwd: workDir,
                });
                return capShellOutput(result || '(no output)');
            }
            catch (err) {
                const e = err;
                const combined = `${e.stdout || ''}${e.stderr || e.message || 'Command failed'}`.trim();
                _cacheInvalidateAll();
                return capShellOutput(combined);
            }
            finally {
                _cacheInvalidateAll();
            }
        }
        case 'read': {
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
            try {
                const st = statSync(fullPath);
                if (st.size > READ_MAX_SIZE_BYTES) {
                    return `Error: file size ${st.size} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap. Use offset/limit for targeted reads, or grep for content search.`;
                }
            } catch (err) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
            try {
                const content = await readFile(fullPath, 'utf-8');
                const lines = content.split('\n');
                const offset = args.offset || 0;
                const limit = args.limit || 2000;
                const sliced = lines.slice(offset, offset + limit);
                const rendered = sliced.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
                // Output byte cap protects against many-line slices that
                // individually pass the file-size check but explode after
                // line-number prefixing.
                if (rendered.length > READ_MAX_OUTPUT_BYTES) {
                    return rendered.slice(0, READ_MAX_OUTPUT_BYTES) + `\n\n... [output truncated at ${Math.round(READ_MAX_OUTPUT_BYTES/1024)} KB] ...`;
                }
                return rendered;
            }
            catch (err) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
        }
        case 'multi_read': {
            const reads = Array.isArray(args.reads) ? args.reads : [];
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
            const filePath = args.path;
            const edits = Array.isArray(args.edits) ? args.edits : [];
            if (!filePath) return 'Error: path is required';
            if (edits.length === 0) return 'Error: edits array is required';
            if (!isSafePath(filePath, workDir)) return `Error: path outside allowed scope — ${filePath}`;
            try {
                const fullPath = resolveAgainstCwd(filePath, workDir);
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
                            return `Error: edit ${i} — old_string not found in ${filePath}`;
                        }
                        content = content.split(old_string).join(new_string);
                    } else {
                        const count = content.split(old_string).length - 1;
                        if (count === 0) return `Error: edit ${i} — old_string not found in ${filePath}`;
                        if (count > 1) return `Error: edit ${i} — old_string found ${count} times in ${filePath}; use replace_all:true or a more specific old_string`;
                        content = content.replace(old_string, new_string);
                    }
                }
                writeFileSync(fullPath, content, 'utf-8');
                _cacheInvalidateAll();
                return `Edited: ${filePath} (${edits.length} replacements applied)`;
            } catch (err) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
        }
        case 'batch_edit': {
            const edits = Array.isArray(args.edits) ? args.edits : [];
            if (edits.length === 0) return 'Error: edits array is required';
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
            const filePath = args.path;
            const content = args.content;
            if (!filePath)
                return 'Error: path is required';
            if (content === undefined)
                return 'Error: content is required';
            if (!isSafePath(filePath, workDir))
                return `Error: path outside allowed scope — ${filePath}`;
            try {
                writeFileSync(resolveAgainstCwd(filePath, workDir), content, 'utf-8');
                _cacheInvalidateAll();
                return `Written: ${filePath}`;
            }
            catch (err) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
        }
        case 'edit': {
            const filePath = args.path;
            const oldStr = args.old_string;
            const newStr = args.new_string;
            if (!filePath || !oldStr)
                return 'Error: path and old_string are required';
            if (!isSafePath(filePath, workDir))
                return `Error: path outside allowed scope — ${filePath}`;
            try {
                const fullPath = resolveAgainstCwd(filePath, workDir);
                const content = readFileSync(fullPath, 'utf-8');
                const count = content.split(oldStr).length - 1;
                if (count === 0)
                    return `Error: old_string not found in ${filePath}`;
                if (count > 1)
                    return `Error: old_string found ${count} times — must be unique`;
                const updated = content.replace(oldStr, newStr);
                writeFileSync(fullPath, updated, 'utf-8');
                _cacheInvalidateAll();
                return `Edited: ${filePath}`;
            }
            catch (err) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
        }
        case 'grep': {
            const rawPattern = args.pattern;
            const patterns = Array.isArray(rawPattern)
                ? rawPattern.filter(p => typeof p === 'string' && p)
                : (rawPattern ? [String(rawPattern)] : []);
            if (patterns.length === 0)
                return 'Error: pattern is required';
            const searchPath = args.path || '.';
            const rawGlob = args.glob;
            const globPatterns = Array.isArray(rawGlob)
                ? rawGlob.filter(g => typeof g === 'string' && g)
                : (rawGlob ? [String(rawGlob)] : []);
            // output_mode mirrors Anthropic GrepTool: files_with_matches
            // (default — paths only, lowest token cost), content (matched
            // lines + path + line number), count (per-file match counts).
            const outputMode = args.output_mode || 'files_with_matches';
            const headLimitRaw = args.head_limit;
            const headLimit = headLimitRaw === 0 ? Infinity : (headLimitRaw || 100);
            const cacheKey = `grep|${patterns.join('\x01')}|${searchPath}|${globPatterns.join('\x01')}|${outputMode}|${headLimit}`;
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
                const { stdout } = await execAsync(`rg ${rgArgs.map(a => `"${a}"`).join(' ')}`, {
                    encoding: 'utf-8',
                    timeout: 10000,
                    cwd: workDir,
                });
                const allLines = stdout.split('\n').filter(Boolean);
                const lines = headLimit === Infinity ? allLines : allLines.slice(0, headLimit);
                const truncated = allLines.length > lines.length
                    ? `\n... [${allLines.length - lines.length} more entries]`
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
            const rawPattern = args.pattern;
            const patterns = Array.isArray(rawPattern)
                ? rawPattern.filter(p => typeof p === 'string' && p)
                : (rawPattern ? [String(rawPattern)] : []);
            if (patterns.length === 0)
                return 'Error: pattern is required';
            const basePath = args.path || '.';
            const cacheKey = `glob|${patterns.join('\x01')}|${basePath}`;
            const cached = _cacheGet(cacheKey);
            if (cached !== null) return cached;
            try {
                // Use rg --files with glob for cross-platform compatibility.
                // Default ignores keep rg from walking node_modules / .git /
                // build artefacts — without these, a single glob on a repo
                // with node_modules spikes to ~10% CPU per rg process and
                // Defender piggybacks on every file open.
                const rgArgs = ['--files'];
                for (const ex of DEFAULT_IGNORE_GLOBS) rgArgs.push('--glob', ex);
                for (const p of patterns) rgArgs.push('--glob', p);
                rgArgs.push(basePath);
                const { stdout } = await execAsync(`rg ${rgArgs.map(a => `"${a}"`).join(' ')}`, {
                    encoding: 'utf-8',
                    timeout: 10000,
                    cwd: workDir,
                });
                const files = stdout.split('\n').filter(Boolean).slice(0, 100);
                const out = capShellOutput(files.join('\n') || '(no files found)');
                _cacheSet(cacheKey, out);
                return out;
            }
            catch {
                return '(no files found)';
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
