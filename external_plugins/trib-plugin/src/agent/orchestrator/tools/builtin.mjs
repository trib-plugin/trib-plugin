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
                path: { type: 'string' },
                old_string: { type: 'string', description: 'Must appear exactly once.' },
                new_string: { type: 'string' },
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
                path: { type: 'string' },
                content: { type: 'string' },
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
                command: { type: 'string' },
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
                pattern: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] },
                path: { type: 'string' },
                glob: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] },
                output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
                head_limit: { type: 'number' },
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
                pattern: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] },
                path: { type: 'string' },
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
                path: { type: 'string' },
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            old_string: { type: 'string' },
                            new_string: { type: 'string' },
                            replace_all: { type: 'boolean' },
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
