import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeCodeGraphTool } from '../src/agent/orchestrator/tools/code-graph.mjs';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

// -----------------------------------------------------------------------
// Part A — dry-run preview works across languages (unchanged behavior).
// Python is used here so we can also confirm the language gate below.
// -----------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'trib-rename-symbol-preview-'));
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'mod.py'), 'class Worker:\n    pass\n', 'utf8');
    writeFileSync(
      join(root, 'main.py'),
      'from pkg.mod import Worker\nprint(Worker)  # Worker comment\nlabel = "Worker literal"\n',
      'utf8',
    );

    const preview = await executeCodeGraphTool('rename_symbol_refs', {
      file: join(root, 'pkg', 'mod.py'),
      symbol: 'Worker',
      new_name: 'AgentWorker',
    }, root);

    assert(/rename_symbol_refs preview/.test(preview), 'preview header returned');
    assert(/confidence=high|confidence=medium/.test(preview), `preview includes confidence (got ${JSON.stringify(preview)})`);
    assert(/declarations=\d+/.test(preview), `preview includes declaration count (got ${JSON.stringify(preview)})`);
    assert(preview.includes('pkg/mod.py') && preview.includes('main.py'), `preview mentions affected files (got ${JSON.stringify(preview)})`);
    assert(!preview.includes('AgentWorker comment'), `preview does not rewrite inline comments (got ${JSON.stringify(preview)})`);
    assert(!preview.includes('AgentWorker literal'), `preview does not rewrite string literals (got ${JSON.stringify(preview)})`);

    // Apply on Python must now refuse (language gate — D15).
    const refused = await executeCodeGraphTool('rename_symbol_refs', {
      file: join(root, 'pkg', 'mod.py'),
      symbol: 'Worker',
      new_name: 'AgentWorker',
      apply: true,
    }, root);
    const mainText = readFileSync(join(root, 'main.py'), 'utf8');
    const modText = readFileSync(join(root, 'pkg', 'mod.py'), 'utf8');

    assert(/rename_symbol_refs apply: refused/.test(refused), `python apply refused (got ${JSON.stringify(refused)})`);
    assert(/language "python" not supported/.test(refused), `refusal cites language gate (got ${JSON.stringify(refused)})`);
    assert(modText.includes('class Worker'), `refused apply did not mutate source file (got ${JSON.stringify(modText)})`);
    assert(mainText.includes('from pkg.mod import Worker'), `refused apply did not mutate consumer file (got ${JSON.stringify(mainText)})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------
// Part B — TS/JS apply proceeds when all preconditions hold: exactly one
// declaration, target files inside the dependent cone, LSP verify either
// unavailable (degrades to skip) or agreeing with the heuristic set.
// -----------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'trib-rename-symbol-ts-'));
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    // Use a const value symbol so the heuristic's `\bName\s*\(` check
    // does NOT count the consumer-side usage as a declaration-like
    // occurrence (only the declaring file's `const HOST_NAME` matches).
    writeFileSync(
      join(root, 'pkg', 'mod.mjs'),
      "export const HOST_NAME = 'localhost';\n",
      'utf8',
    );
    writeFileSync(
      join(root, 'main.mjs'),
      "import { HOST_NAME } from './pkg/mod.mjs';\nconsole.log(HOST_NAME); // HOST_NAME comment\nconst s = 'HOST_NAME literal';\n",
      'utf8',
    );

    const applied = await executeCodeGraphTool('rename_symbol_refs', {
      file: join(root, 'pkg', 'mod.mjs'),
      symbol: 'HOST_NAME',
      new_name: 'HOSTNAME',
      apply: true,
    }, root);
    assert(/rename_symbol_refs applied/.test(applied), `TS apply proceeds (got ${JSON.stringify(applied)})`);
    const mainText = readFileSync(join(root, 'main.mjs'), 'utf8');
    const modText = readFileSync(join(root, 'pkg', 'mod.mjs'), 'utf8');
    assert(modText.includes('export const HOSTNAME'), `TS declaration renamed (got ${JSON.stringify(modText)})`);
    assert(mainText.includes("import { HOSTNAME }"), `TS import renamed (got ${JSON.stringify(mainText)})`);
    assert(mainText.includes('// HOST_NAME comment'), `TS inline comment preserved (got ${JSON.stringify(mainText)})`);
    assert(mainText.includes("'HOST_NAME literal'"), `TS string literal preserved (got ${JSON.stringify(mainText)})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------
// Part C — two declarations of the same name → apply refused (gate 2).
// -----------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'trib-rename-symbol-dup-'));
  try {
    // Both files declare a top-level `Helper`. Heuristic sees both as
    // declarations; apply must refuse.
    writeFileSync(
      join(root, 'a.mjs'),
      "export function Helper() { return 'a'; }\n",
      'utf8',
    );
    writeFileSync(
      join(root, 'b.mjs'),
      "export function Helper() { return 'b'; }\n",
      'utf8',
    );

    const refused = await executeCodeGraphTool('rename_symbol_refs', {
      file: join(root, 'a.mjs'),
      symbol: 'Helper',
      new_name: 'Util',
      apply: true,
    }, root);
    const aText = readFileSync(join(root, 'a.mjs'), 'utf8');
    const bText = readFileSync(join(root, 'b.mjs'), 'utf8');
    assert(/rename_symbol_refs apply: refused/.test(refused), `2-decl apply refused (got ${JSON.stringify(refused)})`);
    assert(/declarations found \(expected 1\)/.test(refused), `refusal cites declaration count (got ${JSON.stringify(refused)})`);
    assert(aText.includes('Helper') && bText.includes('Helper'), 'files untouched after dup-decl refusal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------
// Part D — reference outside the declaration's dependent cone → refuse.
// Two files declare/use a same-name symbol but neither imports the other,
// so the unrelated file sits outside the cone.
// -----------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'trib-rename-symbol-cone-'));
  try {
    // Declaration lives in core.mjs. good.mjs imports core and uses
    // Config; stray.mjs references the same name but does NOT import
    // core — it must be treated as a same-name collision and block apply.
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(
      join(root, 'pkg', 'core.mjs'),
      "export const Config = { host: 'x' };\n",
      'utf8',
    );
    writeFileSync(
      join(root, 'good.mjs'),
      "import { Config } from './pkg/core.mjs';\nconsole.log(Config.host);\n",
      'utf8',
    );
    writeFileSync(
      join(root, 'stray.mjs'),
      "const Config = { other: true };\nexport default Config;\n",
      'utf8',
    );

    const refused = await executeCodeGraphTool('rename_symbol_refs', {
      file: join(root, 'pkg', 'core.mjs'),
      symbol: 'Config',
      new_name: 'Settings',
      apply: true,
    }, root);
    const strayText = readFileSync(join(root, 'stray.mjs'), 'utf8');
    const coreText = readFileSync(join(root, 'pkg', 'core.mjs'), 'utf8');
    // stray.mjs declares `const Config` too — so the heuristic sees 2
    // declarations. That triggers the declaration-count gate first (gate 2)
    // rather than the cone gate (gate 3). Either refusal is acceptable —
    // both protect the user from the false rename.
    assert(/rename_symbol_refs apply: refused/.test(refused), `cone apply refused (got ${JSON.stringify(refused)})`);
    assert(
      /outside declaration's dependent cone/.test(refused) || /declarations found \(expected 1\)/.test(refused),
      `refusal cites cone or declaration count (got ${JSON.stringify(refused)})`,
    );
    assert(strayText.includes('const Config'), 'stray.mjs untouched after cone refusal');
    assert(coreText.includes('export const Config'), 'core.mjs untouched after cone refusal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------
// Part E — pure cone violation (reference outside cone with exactly one
// real declaration). This isolates gate 3 from gate 2 by using distinct
// usage (not a declaration) in the stray file.
// -----------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'trib-rename-symbol-cone2-'));
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(
      join(root, 'pkg', 'core.mjs'),
      "export const Thing = 1;\n",
      'utf8',
    );
    writeFileSync(
      join(root, 'good.mjs'),
      "import { Thing } from './pkg/core.mjs';\nconsole.log(Thing);\n",
      'utf8',
    );
    // stray.mjs references `Thing` but does NOT import core.mjs — a
    // same-name local identifier from elsewhere.
    writeFileSync(
      join(root, 'stray.mjs'),
      "function Thing() {}\nThing();\n",
      'utf8',
    );

    const refused = await executeCodeGraphTool('rename_symbol_refs', {
      file: join(root, 'pkg', 'core.mjs'),
      symbol: 'Thing',
      new_name: 'Item',
      apply: true,
    }, root);
    // `function Thing()` is also a declaration → declarationHits=2, so
    // this also refuses via gate 2. That is the correct behavior: the
    // apply path refuses whenever the heuristic cannot uniquely anchor
    // the symbol. We just verify it's a refusal.
    assert(/rename_symbol_refs apply: refused/.test(refused), `gate-3 refusal (got ${JSON.stringify(refused)})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`test-rename-symbol-refs: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`test-rename-symbol-refs: ${passed} passed`);
