#!/usr/bin/env node
// One-off Pool B / Pool C BP2 split simulation — dollar-cost impact over last 7d.
// Standalone: only node:fs, node:readline, node:path stdlib.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const TRACE = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.claude', 'plugins', 'data', 'trib-plugin-trib-plugin', 'history', 'bridge-trace.jsonl'
);

const CUTOFF_TS = '2026-04-14T00:00:00Z';

const POOL_B = new Set(['worker','reviewer','debugger','tester','researcher']);
const POOL_C = new Set(['cycle1','cycle1-agent','cycle2-agent','explorer','recall-agent','search-agent','proactive','시세']);

// Per-million-token pricing
const PRICING = {
  'claude-opus-4-7':          { input: 15.00, cacheRead: 1.50,  cacheWrite1h: 30.00, output: 75.00 },
  'claude-sonnet-4-6':        { input:  3.00, cacheRead: 0.30,  cacheWrite1h:  6.00, output: 15.00 },
  'claude-haiku-4-5-20251001':{ input:  1.00, cacheRead: 0.10,  cacheWrite1h:  2.00, output:  5.00 },
  'gpt-5.4':                  { input:  1.25, cacheRead: 0.125, cacheWrite1h:  0,    output: 10.00 },
  'gpt-5.4-mini':             { input:  0.25, cacheRead: 0.025, cacheWrite1h:  0,    output:  2.00 },
};

const BP2_FULL_TOK  = 4307;   // current single shard
const BP2_POOL_B_TOK = 593;   // trimmed BP2 for pool B
const BP2_DELTA_TOK = BP2_FULL_TOK - BP2_POOL_B_TOK; // 3714 tok removed from pool B roles

function roleOfRow(r) {
  return r.sourceName || r.profileId || null;
}

function poolOf(role) {
  if (!role) return null;
  if (POOL_B.has(role)) return 'B';
  if (POOL_C.has(role)) return 'C';
  return null;
}

// Cost from tokens for a given model/usage breakdown
function cost(model, { cacheRead = 0, cacheWrite = 0, input = 0, output = 0 }) {
  const p = PRICING[model];
  if (!p) return null;
  return (
    (cacheRead   * p.cacheRead    / 1_000_000) +
    (cacheWrite  * p.cacheWrite1h / 1_000_000) +
    (input       * p.input        / 1_000_000) +
    (output      * p.output       / 1_000_000)
  );
}

// Derive the "fresh input" portion of a row.
// promptTokens, when present, = cacheRead + cacheWrite + fresh-input.
// When absent, inputTokens field already represents fresh input on most rows.
function freshInput(r) {
  const cr = r.cacheReadTokens  || 0;
  const cw = r.cacheWriteTokens || 0;
  if (typeof r.promptTokens === 'number' && r.promptTokens > 0) {
    return Math.max(0, r.promptTokens - cr - cw);
  }
  // Fallback: inputTokens is fresh input (not including cached)
  return Math.max(0, (r.inputTokens || 0));
}

function fmt$(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '   n/a   ';
  const abs = Math.abs(n);
  if (abs >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function pad(s, w, right = false) {
  s = String(s);
  if (s.length >= w) return s;
  const pad = ' '.repeat(w - s.length);
  return right ? pad + s : s + pad;
}

async function main() {
  const rl = createInterface({
    input: createReadStream(TRACE),
    crlfDelay: Infinity,
  });

  const rows = [];
  const unknownModels = new Map(); // model -> count

  for await (const line of rl) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.kind !== 'usage') continue;
    if (!j.ts || j.ts < CUTOFF_TS) continue;

    const role = roleOfRow(j);
    const pool = poolOf(role);
    if (!pool) continue; // ignore rows whose role isn't mapped to a pool

    if (!PRICING[j.model]) {
      unknownModels.set(j.model, (unknownModels.get(j.model) || 0) + 1);
      continue;
    }

    rows.push({
      ts: j.ts,
      tsMs: Date.parse(j.ts),
      role,
      pool,
      model: j.model,
      input: j.inputTokens || 0,
      output: j.outputTokens || 0,
      cacheRead: j.cacheReadTokens || 0,
      cacheWrite: j.cacheWriteTokens || 0,
      promptTokens: typeof j.promptTokens === 'number' ? j.promptTokens : null,
      freshInput: freshInput(j),
      costUsd: typeof j.costUsd === 'number' ? j.costUsd : null,
    });
  }

  rows.sort((a, b) => a.tsMs - b.tsMs);

  // Warn unknown models
  for (const [m, n] of unknownModels) {
    process.stderr.write(`[warn] unknown model ${JSON.stringify(m)} skipped: ${n} row(s)\n`);
  }

  // Scenario helpers ------------------------------------------------------

  // current$: recomputed from tokens using PRICING (authoritative for apples-to-apples).
  const currentCost = (r) => cost(r.model, {
    cacheRead: r.cacheRead,
    cacheWrite: r.cacheWrite,
    input: r.freshInput,
    output: r.output,
  });

  // Scenario A: Pool B rows shed up to 3714 tok of cacheRead; freshInput unchanged
  // (the trimmed BP2 content just isn't sent at all — so promptTokens shrinks,
  //  and specifically cacheRead shrinks because the pruned content was part of the
  //  cached prefix). Pool C rows unchanged.
  const scenACost = (r) => {
    if (r.pool === 'C') return currentCost(r);
    const shed = Math.min(r.cacheRead, BP2_DELTA_TOK);
    return cost(r.model, {
      cacheRead: r.cacheRead - shed,
      cacheWrite: r.cacheWrite,
      input: r.freshInput,
      output: r.output,
    });
  };

  // Identify cross-pool transitions (any interval) and TTL-bounded (<1h)
  const crossAny = new Array(rows.length).fill(false);
  const crossTtl = new Array(rows.length).fill(false);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].pool !== rows[i - 1].pool) {
      crossAny[i] = true;
      if (rows[i].tsMs - rows[i - 1].tsMs < 3_600_000) crossTtl[i] = true;
    }
  }

  // Row cost under pessimistic cross-pool miss model
  //   - cross-pool first call: cacheRead -> max(0, cacheRead - 3714)
  //     cacheWrite += 593 (pool B) or 4307 (pool C)
  //     freshInput unchanged
  //   - otherwise: behave like scenario A (pool B shed) / pool C unchanged
  function crossPoolCost(r, isCross) {
    if (!isCross) return scenACost(r);
    const newCacheRead = Math.max(0, r.cacheRead - BP2_DELTA_TOK);
    const shardWrite = r.pool === 'B' ? BP2_POOL_B_TOK : BP2_FULL_TOK;
    const newCacheWrite = r.cacheWrite + shardWrite;
    // fresh input: if pool B, the trimmed BP2 content (3714 tok) was never going
    // to be part of fresh input anyway (it was cached prefix) — so freshInput is unchanged.
    return cost(r.model, {
      cacheRead: newCacheRead,
      cacheWrite: newCacheWrite,
      input: r.freshInput,
      output: r.output,
    });
  }

  const scenBCost = (r, i) => crossPoolCost(r, crossAny[i]);
  const scenCCost = (r, i) => crossPoolCost(r, crossTtl[i]);

  // Aggregations ---------------------------------------------------------
  const perPool = {
    B: { rows: 0, promptSum: 0, cacheReadSum: 0, cur: 0, A: 0, B: 0, C: 0 },
    C: { rows: 0, promptSum: 0, cacheReadSum: 0, cur: 0, A: 0, B: 0, C: 0 },
  };
  const perModel = new Map(); // model -> { cur, C, rows }
  const rowDeltas = []; // for top cross-pool B transitions

  let totalCur = 0, totalA = 0, totalB = 0, totalC = 0;
  let nBrows = 0, nCrows = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cur = currentCost(r);
    const a   = scenACost(r);
    const b   = scenBCost(r, i);
    const c   = scenCCost(r, i);

    totalCur += cur; totalA += a; totalB += b; totalC += c;
    if (r.pool === 'B') nBrows++; else nCrows++;

    const p = perPool[r.pool];
    p.rows++;
    p.promptSum    += (r.promptTokens ?? (r.freshInput + r.cacheRead + r.cacheWrite));
    p.cacheReadSum += r.cacheRead;
    p.cur += cur; p.A += a; p.B += b; p.C += c;

    const pm = perModel.get(r.model) || { cur: 0, C: 0, rows: 0 };
    pm.cur += cur; pm.C += c; pm.rows++;
    perModel.set(r.model, pm);

    if (crossAny[i]) {
      rowDeltas.push({
        ts: r.ts,
        prevPool: rows[i - 1].pool,
        curPool: r.pool,
        delta: b - cur,
      });
    }
  }

  const xAny = crossAny.reduce((s, v) => s + (v ? 1 : 0), 0);
  const xTtl = crossTtl.reduce((s, v) => s + (v ? 1 : 0), 0);

  // Output ----------------------------------------------------------------
  const out = [];
  out.push('Pool Split Simulation — last 7 days');
  out.push('===================================');
  out.push('');
  out.push(`Rows analyzed: ${rows.length}`);
  out.push(`Pool B rows: ${nBrows}   Pool C rows: ${nCrows}`);
  out.push(`Cross-pool transitions (any interval): ${xAny}`);
  out.push(`Cross-pool transitions within 1h TTL: ${xTtl}`);
  out.push('');
  out.push('=== Per-pool summary ===');
  out.push(
    pad('', 10) +
    pad('rows', 8, true) +
    pad('promptTok(sum)', 18, true) +
    pad('cacheReadTok(sum)', 20, true) +
    pad('current$', 12, true) +
    pad('scenA$', 12, true) +
    pad('scenB$', 12, true) +
    pad('scenC$', 12, true)
  );
  for (const key of ['B', 'C']) {
    const p = perPool[key];
    out.push(
      pad(`Pool ${key}`, 10) +
      pad(p.rows, 8, true) +
      pad(p.promptSum.toLocaleString('en-US'), 18, true) +
      pad(p.cacheReadSum.toLocaleString('en-US'), 20, true) +
      pad(fmt$(p.cur), 12, true) +
      pad(fmt$(p.A), 12, true) +
      pad(fmt$(p.B), 12, true) +
      pad(fmt$(p.C), 12, true)
    );
  }
  out.push('');
  out.push('=== Totals ===');
  const pct = (x) => totalCur > 0 ? ((x - totalCur) / totalCur * 100) : 0;
  out.push(
    pad('', 34) + pad('current$', 12, true) + pad('scen$', 12, true) + pad('Δ vs current', 16, true)
  );
  out.push(
    pad('Scenario A (optimistic)', 34) +
    pad(fmt$(totalCur), 12, true) +
    pad(fmt$(totalA),   12, true) +
    pad(`(${pct(totalA) >= 0 ? '+' : ''}${pct(totalA).toFixed(1)}%)`, 16, true)
  );
  out.push(
    pad('Scenario B (pessimistic)', 34) +
    pad(fmt$(totalCur), 12, true) +
    pad(fmt$(totalB),   12, true) +
    pad(`(${pct(totalB) >= 0 ? '+' : ''}${pct(totalB).toFixed(1)}%)`, 16, true)
  );
  out.push(
    pad('Scenario C (realistic TTL-aware)', 34) +
    pad(fmt$(totalCur), 12, true) +
    pad(fmt$(totalC),   12, true) +
    pad(`(${pct(totalC) >= 0 ? '+' : ''}${pct(totalC).toFixed(1)}%)`, 16, true)
  );
  out.push('');
  out.push('=== Breakdown by provider ===');
  out.push(
    pad('provider/model', 30) +
    pad('current$', 12, true) +
    pad('scenC$',   12, true) +
    pad('Δ',        12, true) +
    pad('Δ%',       10, true)
  );
  const models = [...perModel.entries()].sort((a, b) => b[1].cur - a[1].cur);
  for (const [m, s] of models) {
    const d = s.C - s.cur;
    const dp = s.cur > 0 ? (d / s.cur * 100) : 0;
    out.push(
      pad(m, 30) +
      pad(fmt$(s.cur), 12, true) +
      pad(fmt$(s.C),   12, true) +
      pad((d >= 0 ? '+' : '') + fmt$(d), 12, true) +
      pad(`${dp >= 0 ? '+' : ''}${dp.toFixed(1)}%`, 10, true)
    );
  }
  out.push('');
  out.push('=== Break-even analysis ===');
  const weeklySaving = totalCur - totalC;
  const annualSaving = weeklySaving * 52;
  // one-time establishment cost: each pool shard must be written once.
  // pool B shard (593 tok) and pool C shard (4307 tok), priced against the
  // most expensive active provider in the dataset (opus 4.7: $30/Mtok write).
  // But OpenAI rows dominate, and OpenAI cache-write is free ($0). Take a
  // weighted estimate: price each shard using the cost-weighted mix of models.
  const modelWeight = new Map();
  let weightTotal = 0;
  for (const [m, s] of perModel) { modelWeight.set(m, s.cur); weightTotal += s.cur; }
  let shardEstablishCost = 0;
  for (const [m, w] of modelWeight) {
    const p = PRICING[m]; if (!p) continue;
    const frac = weightTotal > 0 ? (w / weightTotal) : 0;
    const oneShot = (BP2_POOL_B_TOK + BP2_FULL_TOK) * p.cacheWrite1h / 1_000_000;
    shardEstablishCost += frac * oneShot;
  }
  const weeks = weeklySaving > 0 ? shardEstablishCost / weeklySaving : Infinity;
  out.push(`Scenario C weekly saving:       ${fmt$(weeklySaving)}`);
  out.push(`Implied annual saving:          ${fmt$(annualSaving)}  (×52)`);
  out.push(`One-time shard establishment:   ${fmt$(shardEstablishCost)}`);
  out.push(`Break-even point:               ${Number.isFinite(weeks) ? weeks.toFixed(2) + ' weeks' : 'never (no saving)'}`);
  out.push('');
  out.push('=== Top 5 cross-pool transitions contributing to scenario B cost ===');
  out.push(
    pad('ts', 26) +
    pad('prev_pool → cur_pool', 22) +
    pad('row cost delta', 16, true)
  );
  rowDeltas.sort((a, b) => b.delta - a.delta);
  for (const d of rowDeltas.slice(0, 5)) {
    out.push(
      pad(d.ts.replace('T', ' ').replace('Z', '').slice(0, 19), 26) +
      pad(`${d.prevPool} → ${d.curPool}`, 22) +
      pad((d.delta >= 0 ? '+' : '') + fmt$(d.delta), 16, true)
    );
  }

  process.stdout.write(out.join('\n') + '\n');
}

main().catch(err => {
  process.stderr.write(`[fatal] ${err && err.stack || err}\n`);
  process.exit(1);
});
