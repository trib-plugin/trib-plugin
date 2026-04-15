/**
 * Skill suggestion engine.
 *
 * Analyzes trajectory patterns to detect repeating successful workflows,
 * then generates skill .md files for human approval.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const AUTO_SKILLS_DIR = join(homedir(), '.claude', 'skills', 'auto');

/**
 * Query trajectory DB for completed entries and group by scope.
 * Returns an array of pattern summaries.
 * @param {object|null} trajectoryDb - SQLite DatabaseSync instance
 * @returns {Array<{scope: string, totalCalls: number, avgDuration: number, avgTokensIn: number, avgTokensOut: number, successRate: number, topToolChains: string[], samplePrompts: string[]}>}
 */
export function detectPatterns(trajectoryDb) {
  if (!trajectoryDb) return [];

  try {
    const rows = trajectoryDb.prepare(`
      SELECT scope,
             COUNT(*)                          AS totalCalls,
             ROUND(AVG(duration_ms))           AS avgDuration,
             ROUND(AVG(tokens_in))             AS avgTokensIn,
             ROUND(AVG(tokens_out))            AS avgTokensOut,
             ROUND(COUNT(CASE WHEN completed = 1 THEN 1 END) * 100.0 / COUNT(*)) AS successRate
      FROM trajectories
      GROUP BY scope
      ORDER BY totalCalls DESC
    `).all();

    return rows.map((row) => {
      // Extract top tool chains from tool_calls_json
      let topToolChains = [];
      let samplePrompts = [];
      try {
        const details = trajectoryDb.prepare(`
          SELECT tool_calls_json
          FROM trajectories
          WHERE completed = 1 AND scope = ?
          ORDER BY created_at DESC
          LIMIT 10
        `).all(row.scope);

        const chainCounts = {};
        for (const d of details) {
          if (!d.tool_calls_json) continue;
          try {
            const tools = JSON.parse(d.tool_calls_json);
            const chain = (Array.isArray(tools) ? tools.map((t) => t.name || t).join(' -> ') : String(tools));
            chainCounts[chain] = (chainCounts[chain] || 0) + 1;
          } catch { /* skip malformed json */ }
        }
        topToolChains = Object.entries(chainCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([chain]) => chain);
      } catch { /* query failed, leave empty */ }

      return {
        scope: row.scope,
        totalCalls: row.totalCalls,
        avgDuration: row.avgDuration || 0,
        avgTokensIn: row.avgTokensIn || 0,
        avgTokensOut: row.avgTokensOut || 0,
        successRate: row.successRate || 0,
        topToolChains,
        samplePrompts,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Use an LLM to generate a SKILL.md from a detected pattern.
 *
 * @param {{scope: string, totalCalls: number, avgDuration: number, topToolChains: string[], samplePrompts: string[]}} pattern
 * @param {(systemPrompt: string, userPrompt: string) => Promise<string>} llmCallFn
 * @returns {Promise<string>} Generated markdown content
 */
export async function suggestSkillFromPattern(pattern, llmCallFn) {
  const systemPrompt = 'You are a skill file generator for Claude Code. Generate concise, actionable skill definitions in markdown format.';

  const userPrompt = `Based on this recurring workflow pattern, generate a Claude Code skill file in markdown.

Pattern:
- Scope: ${pattern.scope}
- Used ${pattern.totalCalls} times successfully
- Average duration: ${pattern.avgDuration}ms
- Common tool chains: ${pattern.topToolChains.join(', ') || 'N/A'}

Generate a skill with this format:
---
name: auto-${pattern.scope}-workflow
description: [brief description based on the pattern]
version: 1.0.0
---
# [Skill Title]
## When to Use
[conditions]
## Procedure
[step by step]
## Verification
[how to confirm it worked]`;

  return await llmCallFn(systemPrompt, userPrompt);
}

/**
 * Save a generated skill file to ~/.claude/skills/auto/{name}/SKILL.md
 * @param {string} name - Skill directory name
 * @param {string} content - Markdown content
 * @returns {string} Absolute path to the saved file
 */
export function saveAutoSkill(name, content) {
  const dir = join(AUTO_SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'SKILL.md');
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * List existing auto-generated skills.
 * @returns {Array<{name: string, path: string, description: string}>}
 */
export function listAutoSkills() {
  if (!existsSync(AUTO_SKILLS_DIR)) return [];

  const results = [];
  let entries;
  try { entries = readdirSync(AUTO_SKILLS_DIR, { withFileTypes: true }); } catch { return results; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(AUTO_SKILLS_DIR, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    let description = '';
    try {
      const content = readFileSync(skillPath, 'utf-8');
      const descMatch = content.match(/^description:\s*(.+)$/m);
      if (descMatch) description = descMatch[1].trim();
    } catch { /* skip read errors */ }

    results.push({
      name: entry.name,
      path: skillPath,
      description,
    });
  }
  return results;
}

/**
 * Generate a human-readable report of skill candidates from trajectory data.
 * Scopes with 5+ successful calls are flagged as candidates.
 * @param {object|null} trajectoryDb - SQLite DatabaseSync instance
 * @returns {string} Formatted report
 */
export function getSkillSuggestionReport(trajectoryDb) {
  const patterns = detectPatterns(trajectoryDb);
  if (patterns.length === 0) {
    return 'No trajectory data available for analysis.';
  }

  const lines = ['Skill Candidates:'];
  let hasCandidates = false;

  for (const p of patterns) {
    const durationLabel = p.avgDuration >= 1000
      ? `${(p.avgDuration / 1000).toFixed(0)}s`
      : `${p.avgDuration}ms`;

    if (p.totalCalls >= 5) {
      hasCandidates = true;
      lines.push(`- ${p.scope}: ${p.totalCalls} calls, ${p.successRate}% success, avg ${durationLabel} -> candidate for auto-skill`);
    } else {
      lines.push(`- ${p.scope}: ${p.totalCalls} calls -> not enough data yet`);
    }
  }

  if (!hasCandidates) {
    lines.push('');
    lines.push('No scopes have reached the 5-call threshold yet.');
  }

  // Append existing auto-skills info
  const existing = listAutoSkills();
  if (existing.length > 0) {
    lines.push('');
    lines.push('Existing auto-skills:');
    for (const s of existing) {
      lines.push(`- ${s.name}: ${s.description || '(no description)'}`);
    }
  }

  return lines.join('\n');
}
