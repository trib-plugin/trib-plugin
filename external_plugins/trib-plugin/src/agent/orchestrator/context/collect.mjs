import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
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
// Skills folders rarely change within a session. A 5-minute TTL keeps the
// recursive readdirSync + frontmatter parse off the hot path for most
// bridge/Pool C invocations. Bench harness or tests can invalidate by
// boot; long-running plugin server picks up changes on next window.
let _skillsCache = null;
let _skillsCacheTime = 0;
let _skillsCacheCwd = null;
const SKILLS_CACHE_TTL = 5 * 60_000;
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
 *
 * The structure is constant regardless of how many skills are in scope —
 * the 3-tool shape only shows up when `skills.length > 0`, and the slot
 * contents never change. Memoise so every createSession doesn't rebuild
 * identical objects (trivial work, but the allocation noise shows up in
 * repeated Pool C fan-out).
 */
let _skillToolDefsCache = null;
export function buildSkillToolDefs(skills) {
    if (!skills.length) return [];
    if (_skillToolDefsCache) return _skillToolDefsCache;
    _skillToolDefsCache = [
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
    return _skillToolDefsCache;
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

// --- Role template loading (Phase B §4 — UI-managed) ---
/**
 * Read <dataDir>/roles/<role>.md, parse frontmatter (name, description,
 * permission) and body. Returns { description, permission, body } or null.
 *
 * The role md is created/edited from the Config UI; runtime parses it on
 * each spawn and injects the result into the Tier 3 system-reminder via
 * composeSystemPrompt's `roleTemplate` slot.
 */
export function loadRoleTemplate(role, dataDir) {
    if (!role || !dataDir) return null;
    const path = join(dataDir, 'roles', `${role}.md`);
    const content = readSafe(path);
    if (!content) return null;
    const fm = parseFrontmatter(content);
    const body = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
    const description = (fm.description || '').trim();
    const permission = (fm.permission || '').trim().toLowerCase();
    return {
        description: description || null,
        permission: permission || null,
        body: body || null,
    };
}

// --- Compose system prompt — Phase B Tier 2 / Tier 3 split ---
// Returns { systemTier2, tier3Reminder } where the caller places each into
// the right layer (system block vs messages <system-reminder>).
//
// Tier 2 (BP_2 cache): plugin-lifetime invariant content only.
//   - opts.bridgeRules    : rules-builder buildBridgeInjectionContent output
//                           (Pool B roles share bit-identical prefix)
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

    // ── BP2: systemBase ──────────────────────────────────────────────────
    // Bit-identical across every role in the same provider. This is what
    // BP_2 pins for prompt cache. Contains bridgeRules (MCP instructions,
    // Pool B shared agent md, _shared/memory|search|explore, CLAUDE.md
    // common sections, user agents) and any explicit systemPrompt override.
    const baseParts = [];
    if (opts.bridgeRules) baseParts.push(opts.bridgeRules);
    if (opts.userPrompt) baseParts.push(opts.userPrompt);
    const systemBase = baseParts.join('\n\n---\n\n');

    // ── BP3: systemRole ──────────────────────────────────────────────────
    // Role-specific invariant. Permission, role template, and Pool C role
    // snippet ride here (previously they were prepended to the user message,
    // which fragmented the shard prefix per role). Anthropic cache_control
    // can pin BP3 so the role-specific chunk caches independently of the
    // shared BP2.
    const roleParts = [];
    const permission = opts.permission || opts.roleTemplate?.permission || null;
    if (permission) {
        const allow =
            permission === 'read'
                ? 'Allowed: read-only tools. Bash, write, and edit are rejected at call time for this session.'
                : permission === 'read-write'
                    ? 'Allowed: read and read-write tools.'
                    : `Unknown permission "${permission}" — treat as read-only and report.`;
        roleParts.push(`# permission\n${permission}\n${allow}`);
    }
    if (opts.role && !opts.skipRoleReminder) {
        roleParts.push('# role\n' + opts.role);
    }
    if (opts.roleTemplate) {
        const t = opts.roleTemplate;
        const segs = [];
        if (t.description) segs.push(t.description);
        if (t.body) segs.push(t.body);
        if (segs.length > 0) roleParts.push('# agent-role\n' + segs.join('\n\n'));
    } else if (opts.agentTemplate) {
        roleParts.push('# agent-role\n' + opts.agentTemplate);
    }
    if (opts.roleSnippet) {
        roleParts.push(`# agent-snippet\n${opts.roleSnippet}`);
    }
    const systemRole = roleParts.length > 0 ? roleParts.join('\n\n') : '';

    // ── BP4-adjacent: tier3Reminder (messages user, not system) ─────────
    // Per-call variance only — task brief, skills hint, project context,
    // memory recap, effective cwd. This rides in the user message as
    // <system-reminder> so the tool user sees it once up front without
    // polluting the per-turn prompt body.
    const tier3Parts = [];
    if (opts.cwd) tier3Parts.push('# cwd\n' + opts.cwd);
    if (opts.taskBrief) tier3Parts.push('# task-brief\n' + opts.taskBrief);
    if (opts.hasSkills && !skip.skills) {
        tier3Parts.push('# skills\nCall `skills_list` to discover available skills.');
    }
    if (opts.projectContext) tier3Parts.push('# project-context\n' + opts.projectContext);
    if (opts.memoryContext && !skip.memory) {
        tier3Parts.push('# memory-context\n' + opts.memoryContext);
    }
    const tier3Reminder = tier3Parts.length > 0 ? tier3Parts.join('\n\n') : '';

    // `systemTier2` kept as a back-compat alias for the older single-block
    // consumer (= systemBase + systemRole concatenated). Prefer the split
    // fields on new callers.
    const systemTier2 = [systemBase, systemRole].filter(Boolean).join('\n\n---\n\n');

    return { systemBase, systemRole, systemTier2, tier3Reminder };
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
    const permission = fm.match(/^permission:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
    return { name, description, permission };
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
