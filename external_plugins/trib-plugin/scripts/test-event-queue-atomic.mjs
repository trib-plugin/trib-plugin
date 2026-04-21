// Repro for Fix 2 — EventQueue atomic claim.
//
// Drops 2 distinct items in the queue dir and simulates two overlapping
// processQueue() ticks before either execution finishes. Each item should
// be claimed by exactly one tick (total executions = 2, not 4).
//
// Uses a scratch DATA_DIR so we don't touch the real one.

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.CLAUDE_PLUGIN_DATA = mkdtempSync(join(tmpdir(), "eq-atomic-"));

const { EventQueue } = await import("../src/channels/lib/event-queue.mjs");

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
const QUEUE_DIR = join(DATA_DIR, "events", "queue");
const IN_PROGRESS_DIR = join(DATA_DIR, "events", "in-progress");
const PROCESSED_DIR = join(DATA_DIR, "events", "processed");

mkdirSync(QUEUE_DIR, { recursive: true });

// Drop 2 distinct non-interactive items into queue/.
function dropItem(name, idSuffix) {
  const fname = `1-${Date.now()}-${idSuffix}.json`;
  const item = {
    name,
    source: "test",
    priority: "normal",
    prompt: `prompt-${name}`,
    exec: "non-interactive",
    channel: "test",
    script: null,
    timestamp: Date.now(),
  };
  writeFileSync(join(QUEUE_DIR, fname), JSON.stringify(item));
  return fname;
}

const f1 = dropItem("alpha", "aaaa");
// ensure deterministic ordering / distinct ts
await new Promise((r) => setTimeout(r, 5));
const f2 = dropItem("beta", "bbbb");

const q = new EventQueue({ tickInterval: 3600, maxConcurrent: 10 }, {});

// Count how many times executeItem gets invoked across both ticks.
let executions = 0;
const executed = [];
const origExec = q.executeItem.bind(q);
q.executeItem = function (item, file) {
  executions++;
  executed.push({ name: item.name, file });
  // Simulate a slow send — do NOT move to processed synchronously; the
  // second overlapping tick fires while the "work" is in flight.
  // Leave the file under in-progress/ until end of test.
};

// Fire two overlapping ticks.
q.processQueue();
q.processQueue();

let pass = true;
const reasons = [];

if (executions !== 2) {
  pass = false;
  reasons.push(`expected 2 executions, got ${executions} (items=${JSON.stringify(executed)})`);
}

const names = new Set(executed.map((e) => e.name));
if (!(names.has("alpha") && names.has("beta") && names.size === 2)) {
  pass = false;
  reasons.push(`expected both alpha and beta exactly once, got ${[...names].join(",")}`);
}

// After claim, queue/ should be empty; in-progress/ should have both items.
const stillQueued = readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json"));
if (stillQueued.length !== 0) {
  pass = false;
  reasons.push(`expected queue/ empty after claims, has: ${stillQueued.join(",")}`);
}
let inProgress = [];
try {
  inProgress = readdirSync(IN_PROGRESS_DIR).filter((f) => f.endsWith(".json"));
} catch {}
if (inProgress.length !== 2) {
  pass = false;
  reasons.push(`expected 2 files under in-progress/, got ${inProgress.length}`);
}

// cleanup
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}

if (pass) {
  console.log("  ok  two overlapping ticks claim 2 items exactly once");
  console.log(`  ok  queue/ empty post-claim; in-progress/ holds ${inProgress.length} file(s)`);
  console.log("\nPASS 2/2");
  process.exit(0);
} else {
  console.log("FAIL:");
  for (const r of reasons) console.log("  -", r);
  process.exit(1);
}
