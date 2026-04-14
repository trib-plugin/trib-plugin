import { loadConfig } from './config.mjs';
import { getTrajectoryDb, getTrajectoryStats, findRepeatingPatterns } from './trajectory.mjs';
import { getSkillSuggestionReport } from './skill-suggest.mjs';

let _timer = null;

function parseInterval(str) {
  const match = String(str || '30m').match(/^(\d+)(m|h)$/);
  if (!match) return 30 * 60 * 1000;
  const [, n, unit] = match;
  return Number(n) * (unit === 'h' ? 3600000 : 60000);
}

export function startAgentMaintenance() {
  const config = loadConfig();
  if (!config.agentMaintenance?.enabled) return;

  const interval = parseInterval(config.agentMaintenance?.interval);

  _timer = setInterval(async () => {
    try {
      await runAgentMaintenance();
    } catch (err) {
      process.stderr.write(`[agent-maintenance] error: ${err.message}\n`);
    }
  }, interval);

  process.stderr.write(`[agent-maintenance] started (interval: ${config.agentMaintenance?.interval || '30m'})\n`);
}

export function stopAgentMaintenance() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export async function runAgentMaintenance() {
  const config = loadConfig();
  const db = getTrajectoryDb();
  if (!db) return;

  // 1. Log stats
  const stats = getTrajectoryStats(null, new Date(Date.now() - 86400000).toISOString());
  if (stats.total > 0) {
    process.stderr.write(`[agent-maintenance] 24h stats: ${stats.total} calls, ${stats.successRate}% success, avg ${stats.avgDuration}ms\n`);
  }

  // 2. Pattern detection
  const patterns = findRepeatingPatterns(3);
  if (patterns.length > 0) {
    process.stderr.write(`[agent-maintenance] ${patterns.length} repeating pattern(s) detected\n`);
  }

  // 3. Skill suggestion report (logged, not auto-created)
  if (config.skillSuggest?.autoDetect && patterns.length > 0) {
    const report = getSkillSuggestionReport(db);
    process.stderr.write(`[agent-maintenance] skill report: ${report}\n`);
  }
}
