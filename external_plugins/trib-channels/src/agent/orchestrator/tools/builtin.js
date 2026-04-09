import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, normalize } from 'path';
// --- Tool definitions for external models ---
export const BUILTIN_TOOLS = [
    {
        name: 'bash',
        description: 'Execute a shell command and return stdout/stderr. Use for running tests, git status, npm commands, etc.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The shell command to execute' },
                timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
            },
            required: ['command'],
        },
    },
    {
        name: 'read',
        description: 'Read a file and return its contents.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to read' },
                offset: { type: 'number', description: 'Start line (0-based)' },
                limit: { type: 'number', description: 'Max lines to read' },
            },
            required: ['path'],
        },
    },
    {
        name: 'write',
        description: 'Write content to a file (creates or overwrites).',
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
        description: 'Replace a string in a file. old_string must be unique in the file.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to edit' },
                old_string: { type: 'string', description: 'Exact text to find' },
                new_string: { type: 'string', description: 'Replacement text' },
            },
            required: ['path', 'old_string', 'new_string'],
        },
    },
    {
        name: 'grep',
        description: 'Search file contents with regex. Returns matching lines with file paths and line numbers.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Regex pattern to search for' },
                path: { type: 'string', description: 'Directory or file to search in (default: cwd)' },
                glob: { type: 'string', description: 'File pattern filter (e.g., "*.ts")' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'glob',
        description: 'Find files matching a glob pattern. Returns file paths.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.js")' },
                path: { type: 'string', description: 'Base directory (default: cwd)' },
            },
            required: ['pattern'],
        },
    },
];
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
export function executeBuiltinTool(name, args, cwd) {
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
                return result || '(no output)';
            }
            catch (err) {
                const e = err;
                return `${e.stdout || ''}${e.stderr || e.message || 'Command failed'}`.trim();
            }
        }
        case 'read': {
            const filePath = args.path;
            if (!filePath)
                return 'Error: path is required';
            if (!isSafePath(filePath, workDir))
                return `Error: path outside allowed scope — ${filePath}`;
            try {
                const content = readFileSync(resolveAgainstCwd(filePath, workDir), 'utf-8');
                const lines = content.split('\n');
                const offset = args.offset || 0;
                const limit = args.limit || 2000;
                const sliced = lines.slice(offset, offset + limit);
                return sliced.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
            }
            catch (err) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
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
                return `Edited: ${filePath}`;
            }
            catch (err) {
                return `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
        }
        case 'grep': {
            const pattern = args.pattern;
            if (!pattern)
                return 'Error: pattern is required';
            const searchPath = args.path || '.';
            const fileGlob = args.glob;
            try {
                const rgArgs = ['--no-heading', '--line-number', '--color', 'never'];
                if (fileGlob)
                    rgArgs.push('--glob', fileGlob);
                rgArgs.push(pattern, searchPath);
                const result = execSync(`rg ${rgArgs.map(a => `"${a}"`).join(' ')}`, {
                    encoding: 'utf-8',
                    timeout: 10000,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    cwd: workDir,
                });
                const lines = result.split('\n').slice(0, 100);
                return lines.join('\n') || '(no matches)';
            }
            catch {
                return '(no matches)';
            }
        }
        case 'glob': {
            const pattern = args.pattern;
            if (!pattern)
                return 'Error: pattern is required';
            const basePath = args.path || '.';
            try {
                // Use rg --files with glob for cross-platform compatibility
                const result = execSync(`rg --files --glob "${pattern}" "${basePath}"`, {
                    encoding: 'utf-8',
                    timeout: 10000,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    cwd: workDir,
                });
                const files = result.split('\n').filter(Boolean).slice(0, 100);
                return files.join('\n') || '(no files found)';
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
