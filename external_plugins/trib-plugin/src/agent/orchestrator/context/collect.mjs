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
// --- Collect project MD (Phase B §5) ---
/**
 * Read <cwd>/PROJECT.md if present. Used to inject project-scoped guidance
 * into Tier 3 `# project-context` without polluting Tier 2 (Pool B prefix).
 */
export function collectProjectMd(cwd) {
    const projectDir = cwd || process.cwd();
    const content = readSafe(join(projectDir, 'PROJECT.md'));
    return content || '';
}

// --- Compose system prompt — Phase B Tier 2 / Tier 3 split ---
// Returns { systemTier2, tier3Reminder } where the caller places each into
// the right layer (system block vs messages <system-reminder>).
//
// Tier 2 (BP_2 cache): plugin-lifetime invariant content only.
//   - opts.bridgeRules    : rules-builder buildBridgeInjectionContent output
//                           (preferred; Pool B roles share bit-identical prefix)
//   - opts.claudeMd       : fallback when caller hasn't migrated to bridgeRules
//   - opts.userPrompt     : explicit systemPrompt override from callsite
//
// Tier 3 (messages, no cache_control): role / session / project variance.
//   - opts.role           : worker / reviewer / tester / debugger / researcher / ...
//   - opts.agentTemplate  : agents/<role>.md body when authored
//   - opts.taskBrief      : Lead-issued task description (Sub only)
//   - opts.hasSkills      : true → skills_list hint
//   - opts.projectContext : cwd's PROJECT.md content (Phase B §5)
//   - opts.memoryContext  : recap / history context (legacy — Pool B roles
//                           generally exclude recap per §4.4)
//
// `profile.skip` still filters specific buckets (claudemd, skills, memory)
// for backward compatibility with existing profiles.
export function composeSystemPrompt(opts) {
    const profile = opts.profile || null;
    const skip = profile?.skip || {};

    // ── Tier 2 block ─────────────────────────────────────────────────────
    const tier2Parts = [];
    if (opts.bridgeRules) {
        tier2Parts.push(opts.bridgeRules);
    } else if (opts.claudeMd && !skip.claudemd) {
        tier2Parts.push('# Project Instructions\n\n' + opts.claudeMd);
    }
    if (opts.userPrompt) {
        tier2Parts.push(opts.userPrompt);
    }
    const systemTier2 = tier2Parts.join('\n\n---\n\n');

    // ── Tier 3 block ─────────────────────────────────────────────────────
    const tier3Parts = [];
    if (opts.role) {
        tier3Parts.push('# role\n' + opts.role);
    }
    if (opts.agentTemplate) {
        tier3Parts.push('# agent-role\n' + opts.agentTemplate);
    }
    if (opts.taskBrief) {
        tier3Parts.push('# task-brief\n' + opts.taskBrief);
    }
    if (opts.hasSkills && !skip.skills) {
        tier3Parts.push('# skills\nCall `skills_list` to discover available skills.');
    }
    if (opts.projectContext) {
        tier3Parts.push('# project-context\n' + opts.projectContext);
    }
    if (opts.memoryContext && !skip.memory) {
        tier3Parts.push('# memory-context\n' + opts.memoryContext);
    }
    const tier3Reminder = tier3Parts.length > 0 ? tier3Parts.join('\n\n') : '';

    return { systemTier2, tier3Reminder };
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
