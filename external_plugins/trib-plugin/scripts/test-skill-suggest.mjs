/**
 * Tests for skill-suggest.mjs 3-axis extraction + catalog + promotion.
 *
 * Uses an in-memory sqlite DB seeded with synthetic trajectory data.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  extractPatterns3Axis,
  qualityCheck,
  getSkillCatalog,
  promoteDraft,
} from '../src/agent/orchestrator/skill-suggest.mjs';

let passed = 0;
let failed = 0;
function assert(condition, msg) {
  if (condition) passed++;
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE trajectories (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      session_id TEXT,
      scope TEXT,
      preset TEXT,
      model TEXT,
      agent_type TEXT,
      phase TEXT,
      tool_calls_json TEXT,
      iterations INTEGER DEFAULT 1,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 1,
      error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  return db;
}

function insert(db, { session, scope, chain, ts }) {
  const stmt = db.prepare(`INSERT INTO trajectories (session_id, scope, tool_calls_json, completed, ts) VALUES (?, ?, ?, 1, ?)`);
  stmt.run(session, scope, JSON.stringify((chain || []).map((n) => ({ name: n }))), ts || `2026-04-17 10:00:${String(Math.random()).slice(2,4)}`);
}

// ── 1. Basic 3-axis extraction ───────────────────────────────────────
{
  const db = makeDb();
  // 4 sessions each with the same FLOW: review -> fix -> commit
  for (let s = 1; s <= 4; s++) {
    insert(db, { session: `s${s}`, scope: 'review', chain: ['Read', 'Grep'], ts: `2026-04-1${s} 10:00:01` });
    insert(db, { session: `s${s}`, scope: 'fix', chain: ['Edit', 'Edit'], ts: `2026-04-1${s} 10:00:02` });
    insert(db, { session: `s${s}`, scope: 'commit', chain: ['Bash', 'Bash'], ts: `2026-04-1${s} 10:00:03` });
  }
  const result = extractPatterns3Axis(db, { minFreq: 3 });
  assert(result.flow.length > 0, '1. FLOW extracted');
  const reviewFixCommit = result.flow.find((f) => f.scopes.join('->') === 'review->fix->commit');
  assert(!!reviewFixCommit, '1. review->fix->commit FLOW present');
  assert(reviewFixCommit.frequency === 4, '1. FLOW frequency=4');
  assert(reviewFixCommit.consistency === 'H', '1. FLOW consistency=H (4 sessions)');
  assert(reviewFixCommit.routine === 1.0, '1. FLOW routine=1.0');
  db.close();
}

// ── 2. FLOW-absorbs-nested counting ──────────────────────────────────
{
  const db = makeDb();
  for (let s = 1; s <= 4; s++) {
    insert(db, { session: `s${s}`, scope: 'review', chain: [], ts: `2026-04-1${s} 10:00:01` });
    insert(db, { session: `s${s}`, scope: 'fix', chain: [], ts: `2026-04-1${s} 10:00:02` });
    insert(db, { session: `s${s}`, scope: 'commit', chain: [], ts: `2026-04-1${s} 10:00:03` });
  }
  const result = extractPatterns3Axis(db, { minFreq: 3 });
  // WHAT 'commit' would naturally be 4, but FLOW review->fix->commit count=4
  // absorbs it: 4 - 4 = 0 -> filtered out
  const standaloneCommit = result.what.find((w) => w.key === 'commit');
  assert(!standaloneCommit, '2. standalone WHAT "commit" is absorbed by FLOW');
  db.close();
}

// ── 3. HOW tool-chain extraction ─────────────────────────────────────
{
  const db = makeDb();
  for (let s = 1; s <= 3; s++) {
    insert(db, { session: `s${s}`, scope: 'plan', chain: ['Read', 'Grep', 'Edit'], ts: `2026-04-1${s} 10:00:01` });
  }
  const result = extractPatterns3Axis(db, { minFreq: 2 });
  const readGrep = result.how.find((h) => h.chain.join('->') === 'Read->Grep');
  assert(!!readGrep, '3. HOW Read->Grep detected');
  assert(readGrep.frequency === 3, '3. HOW frequency=3');
  db.close();
}

// ── 4. qualityCheck: valid SKILL.md ──────────────────────────────────
{
  const good = `---
name: my-skill
description: Use when you need to do X with Y in the context of Z operations
version: 0.1.0
---

# Title

## When to use
Trigger conditions.

## Procedure
1. Step one
2. Step two

## Verification
How to confirm.`;
  const r = qualityCheck(good);
  assert(r.ok === true, '4. good SKILL.md passes quality check');
  assert(r.issues.length === 0, '4. no issues reported');
}

// ── 5. qualityCheck: missing frontmatter ─────────────────────────────
{
  const bad = `# Skill without frontmatter\nJust some text.`;
  const r = qualityCheck(bad);
  assert(r.ok === false, '5. missing frontmatter fails');
  assert(r.issues.some((i) => i.includes('frontmatter')), '5. frontmatter issue flagged');
}

// ── 6. qualityCheck: short description ───────────────────────────────
{
  const short = `---
name: skill
description: too short
---
# X
## When to use
x`;
  const r = qualityCheck(short);
  assert(r.ok === false, '6. too-short description fails');
  assert(r.issues.some((i) => i.includes('< 20')), '6. length-20 issue flagged');
}

// ── 7. Catalog + promotion (filesystem) ──────────────────────────────
{
  const tmp = mkdtempSync(join(tmpdir(), 'test-skill-suggest-'));
  const autoDrafts = join(tmp, 'auto-drafts');
  const autoPromoted = join(tmp, 'auto');
  mkdirSync(join(autoDrafts, 'my-flow'), { recursive: true });
  writeFileSync(join(autoDrafts, 'my-flow', 'SKILL.md'), `---\nname: my-flow\ndescription: Use when flow happens in session\nversion: 0.1.0\n---\n# X\n## When to use\nA\n## Procedure\n1. B\n`);
  // Redirect: copy listing logic via getSkillCatalog with pluginRoot pointing at tmp.
  const catalog = getSkillCatalog(tmp);
  assert(Array.isArray(catalog.bundled), '7. catalog has bundled array');
  assert(Array.isArray(catalog.auto), '7. catalog has auto array');
  assert(Array.isArray(catalog.drafts), '7. catalog has drafts array');
  // promoteDraft operates on user-home paths — sanity check the return shape only.
  const res = promoteDraft('__nonexistent__');
  assert(res.ok === false, '7. promoteDraft returns ok=false for missing draft');
  assert(typeof res.error === 'string', '7. promoteDraft returns error string');
  rmSync(tmp, { recursive: true, force: true });
}

// ── 8. Dedup against existing skills ─────────────────────────────────
{
  const db = makeDb();
  // seed a pattern that would match one of the existing skill directory names,
  // though in this test environment there's no collision, this confirms the
  // filter does not crash when the catalog lookup returns an empty set.
  for (let s = 1; s <= 4; s++) {
    insert(db, { session: `s${s}`, scope: 'never-heard-of-pattern', chain: [], ts: `2026-04-1${s} 10:00` });
  }
  const result = extractPatterns3Axis(db, { minFreq: 3 });
  // The pattern may or may not appear depending on home-dir skills; just confirm no crash.
  assert(Array.isArray(result.what), '8. extractPatterns3Axis runs without crashing when dedup active');
  db.close();
}

console.log(`test-skill-suggest: ${passed} pass / ${failed} fail`);
process.exit(failed ? 1 : 0);
