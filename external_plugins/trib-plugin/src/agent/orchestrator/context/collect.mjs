import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
// --- CLAUDE.md collection ---
/**
 * Collect CLAUDE.md files in priority order (same as Claude Code):
 *   1. ~/.claude/CLAUDE.md (user global)
 *   2. CLAUDE.md (project root)
 *   3. .claude/CLAUDE.md
 *   4. .claude/rules/*.md
 *   5. CLAUDE.local.md
 */
export function collectClaudeMd(cwd) {
    const projectDir = cwd || process.cwd();
    const parts = [];
    const paths = [
        join(homedir(), '.claude', 'CLAUDE.md'),
        join(projectDir, 'CLAUDE.md'),
        join(projectDir, '.claude', 'CLAUDE.md'),
        join(projectDir, 'CLAUDE.local.md'),
    ];
    for (const p of paths) {
        const content = readSafe(p);
        if (content)
            parts.push(`<!-- ${p} -->\n${content}`);
    }
    // .claude/rules/*.md
    const rulesDir = join(projectDir, '.claude', 'rules');
    if (existsSync(rulesDir)) {
        try {
            const files = readdirSync(rulesDir).filter(f => f.endsWith('.md')).sort();
            for (const f of files) {
                const content = readSafe(join(rulesDir, f));
                if (content)
                    parts.push(`<!-- ${f} -->\n${content}`);
            }
        }
        catch { /* ignore */ }
    }
    return parts.join('\n\n---\n\n');
}
// --- Agent template loading ---
/**
 * Load an agent MD file (Worker.md, Reviewer.md, etc.) as session instructions.
 * Strips frontmatter, returns the body.
 */
export function loadAgentTemplate(name, cwd) {
    const projectDir = cwd || process.cwd();
    // Search paths for agent files
    const searchPaths = [
        join(projectDir, '.claude', 'agents', `${name}.md`),
        join(homedir(), '.claude', 'agents', `${name}.md`),
    ];
    // Also search plugin directories
    const pluginBase = join(homedir(), '.claude', 'plugins', 'marketplaces');
    if (existsSync(pluginBase)) {
        try {
            walkForAgent(pluginBase, name, searchPaths);
        }
        catch { /* ignore */ }
    }
    for (const p of searchPaths) {
        const content = readSafe(p);
        if (content) {
            // Strip YAML frontmatter
            const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
            return stripped.trim();
        }
    }
    return null;
}
/**
 * Collect available skills (frontmatter only — token efficient).
 * Full content loaded on demand via loadSkillContent().
 */
export function collectSkills(cwd) {
    const projectDir = cwd || process.cwd();
    const skills = [];
    const dirs = [
        join(homedir(), '.claude', 'skills'),
        join(projectDir, '.claude', 'skills'),
    ];
    // Plugin skill directories
    const pluginBase = join(homedir(), '.claude', 'plugins', 'marketplaces');
    if (existsSync(pluginBase)) {
        try {
            walkForSkills(pluginBase, dirs);
        }
        catch { /* ignore */ }
    }
    const seen = new Set();
    for (const dir of dirs) {
        if (!existsSync(dir))
            continue;
        try {
            const files = readdirSync(dir, { recursive: true });
            for (const f of files) {
                if (!String(f).endsWith('.md'))
                    continue;
                const filePath = join(dir, String(f));
                const content = readSafe(filePath);
                if (!content)
                    continue;
                const fm = parseFrontmatter(content);
                if (!fm.name)
                    continue;
                if (seen.has(fm.name))
                    continue;
                seen.add(fm.name);
                skills.push({
                    name: fm.name,
                    description: fm.description || '',
                    filePath,
                });
            }
        }
        catch { /* ignore */ }
    }
    return skills;
}
// --- Skill cache (TTL-based) ---
let _skillsCache = null;
let _skillsCacheTime = 0;
let _skillsCacheCwd = null;
const SKILLS_CACHE_TTL = 30000; // 30 seconds
export function collectSkillsCached(cwd) {
    const now = Date.now();
    if (_skillsCache && _skillsCacheCwd === cwd && now - _skillsCacheTime < SKILLS_CACHE_TTL) {
        return _skillsCache;
    }
    _skillsCache = collectSkills(cwd);
    _skillsCacheTime = now;
    _skillsCacheCwd = cwd;
    return _skillsCache;
}
/**
 * Load full skill content by name.
 */
export function loadSkillContent(name, cwd) {
    const skills = collectSkillsCached(cwd);
    const skill = skills.find(s => s.name === name);
    if (!skill)
        return null;
    return readSafe(skill.filePath);
}
/**
 * Build slim skill tool definitions (Hermes-style 3-tool split).
 * The skill catalogue is served at runtime via `skills_list` rather than
 * inlined into tool descriptions, keeping per-session schema bytes small.
 */
export function buildSkillToolDefs(skills) {
    if (!skills.length)
        return [];
    return [
        {
            name: 'skills_list',
            description: 'List available skills with short descriptions. Call this first to discover what skills are available before using skill_view or skill_execute.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
        {
            name: 'skill_view',
            description: 'Return the full body of a skill by name (without executing it). Use this to inspect skill contents.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Skill name' },
                },
                required: ['name'],
            },
        },
        {
            name: 'skill_execute',
            description: 'Load and execute a skill by name. The skill body is injected into the conversation context.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Skill name' },
                    args: { type: 'object', description: 'Optional arguments passed to the skill', additionalProperties: true },
                },
                required: ['name'],
            },
        },
    ];
}
// --- Compose full system prompt ---
// Profile-aware: if opts.profile is provided, profile.skip[] filters out
// buckets the profile explicitly doesn't need. Backward-compatible — callers
// without a profile get the classic "include everything" behavior.
export function composeSystemPrompt(opts) {
    const parts = [];
    const profile = opts.profile || null;
    const skip = profile?.skip || {};

    if (opts.claudeMd && !skip.claudemd) {
        parts.push('# Project Instructions\n\n' + opts.claudeMd);
    }
    if (opts.agentTemplate) {
        // Agent role override is explicit — never filtered, even when profile
        // says skip:claudemd (the caller wanted this agent specifically).
        parts.push('# Agent Role\n\n' + opts.agentTemplate);
    }
    if (opts.hasSkills && !skip.skills) {
        parts.push('# Skills\n\nCall `skills_list` to discover available skills.');
    }
    if (opts.recap && !skip.recap) {
        parts.push('# Last Session Recap\n\n' + opts.recap);
    }
    if (opts.memoryContext && !skip.memory) {
        parts.push('# Memory Context\n\n' + opts.memoryContext);
    }
    if (opts.userPrompt) {
        parts.push(opts.userPrompt);
    }
    return parts.join('\n\n---\n\n');
}
// --- Helpers ---
function readSafe(path) {
    try {
        if (!existsSync(path))
            return null;
        const content = readFileSync(path, 'utf-8').trim();
        return content || null;
    }
    catch {
        return null;
    }
}
function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match)
        return {};
    const fm = match[1];
    const name = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
    const description = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
    return { name, description };
}
function walkForAgent(dir, agentName, result) {
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'node_modules')
                continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'agents') {
                    result.push(join(full, `${agentName}.md`));
                }
                else {
                    walkForAgent(full, agentName, result);
                }
            }
        }
    }
    catch { /* ignore */ }
}
function walkForSkills(dir, result) {
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'node_modules')
                continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'skills') {
                    result.push(full);
                }
                else {
                    walkForSkills(full, result);
                }
            }
        }
    }
    catch { /* ignore */ }
}
