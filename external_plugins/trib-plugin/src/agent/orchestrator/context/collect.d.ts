/**
 * Collect CLAUDE.md files in priority order (same as Claude Code):
 *   1. ~/.claude/CLAUDE.md (user global)
 *   2. CLAUDE.md (project root)
 *   3. .claude/CLAUDE.md
 *   4. .claude/rules/*.md
 *   5. CLAUDE.local.md
 */
export declare function collectClaudeMd(cwd?: string): string;
/**
 * Load an agent MD file (Worker.md, Reviewer.md, etc.) as session instructions.
 * Strips frontmatter, returns the body.
 */
export declare function loadAgentTemplate(name: string, cwd?: string): string | null;
export interface SkillInfo {
    name: string;
    description: string;
    filePath: string;
}
/**
 * Collect available skills (frontmatter only — token efficient).
 * Full content loaded on demand via loadSkillContent().
 */
export declare function collectSkills(cwd?: string): SkillInfo[];
/**
 * Load full skill content by name.
 */
export declare function loadSkillContent(name: string, cwd?: string): string | null;
/**
 * Build the skill tool definition for external models.
 */
export declare function buildSkillToolDef(skills: SkillInfo[]): {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
} | null;
export declare function composeSystemPrompt(opts: {
    userPrompt?: string;
    agentTemplate?: string;
    claudeMd?: string;
    skillsSummary?: string;
}): string;
