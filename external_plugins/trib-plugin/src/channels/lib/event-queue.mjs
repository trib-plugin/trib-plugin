import { readdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./config.mjs";
import { ensureDir } from "./state-file.mjs";
import {
  logEvent,
  spawnClaudeP,
  runScript
} from "./executor.mjs";
const QUEUE_DIR = join(DATA_DIR, "events", "queue");
const PROCESSED_DIR = join(DATA_DIR, "events", "processed");
class EventQueue {
  config;
  channelsConfig;
  tickTimer = null;
  batchTimer = null;
  runningCount = 0;
  injectFn = null;
  sendFn = null;
  sessionStateGetter = null;
  notifiedFiles = /* @__PURE__ */ new Set();
  // track files already notified during active state
  constructor(config, channelsConfig) {
    this.config = config ?? {};
    this.channelsConfig = channelsConfig ?? null;
  }
  setInjectHandler(fn) {
    this.injectFn = fn;
  }
  setSendHandler(fn) {
    this.sendFn = fn;
  }
  setSessionStateGetter(fn) {
    this.sessionStateGetter = fn;
  }
  // ── Lifecycle ─────────────────────────────────────────────────────
  start() {
    if (this.tickTimer) return;
    ensureDir(QUEUE_DIR);
    ensureDir(PROCESSED_DIR);
    const tickMs = (this.config.tickInterval ?? 10) * 1e3;
    this.tickTimer = setInterval(() => this.processQueue(), tickMs);
    setTimeout(() => this.processQueue(), 3e3);
    const batchMs = (this.config.batchInterval ?? 30) * 6e4;
    this.batchTimer = setInterval(() => this.processBatch(), batchMs);
    logEvent("queue started");
  }
  stop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }
  reloadConfig(config, channelsConfig) {
    this.stop();
    this.config = config ?? {};
    this.channelsConfig = channelsConfig ?? null;
    this.start();
  }
  // ── Enqueue ───────────────────────────────────────────────────────
  enqueue(item) {
    ensureDir(QUEUE_DIR);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const filename = `${item.priority === "high" ? "0" : item.priority === "normal" ? "1" : "2"}-${id}.json`;
    writeFileSync(join(QUEUE_DIR, filename), JSON.stringify(item, null, 2));
    logEvent(`${item.name}: enqueued (${item.priority}, ${item.exec})`);
    if (item.priority === "high") {
      this.processQueue();
    }
  }
  // ── Process queue ─────────────────────────────────────────────────
  processQueue() {
    const maxConcurrent = this.config.maxConcurrent ?? 2;
    const files = this.readQueueFiles();
    if (files.length === 0) return;
    const sessionState = this.sessionStateGetter?.() ?? "idle";
    const interactiveFiles = [];
    for (const file of files) {
      const item = this.readItem(file);
      if (!item) continue;
      if (item.priority === "low") continue;
      if (item.exec === "interactive") {
        interactiveFiles.push({ file, item });
        continue;
      }
      if (this.runningCount >= maxConcurrent) return;
      this.executeItem(item, file);
    }
    if (interactiveFiles.length === 0) return;
    if (sessionState === "idle") {
      this.notifiedFiles.clear();
      for (const { file, item } of interactiveFiles) {
        this.executeItem(item, file);
      }
    } else {
      const unnotified = interactiveFiles.filter((f) => !this.notifiedFiles.has(f.file));
      if (unnotified.length > 0 && this.injectFn) {
        const count = interactiveFiles.length;
        this.injectFn("", "queue", " ", {
          instruction: `There are ${count} pending webhook/event items in the queue. The user is currently busy. Do not process them now \u2014 just be aware they exist. When the user seems available, briefly mention "${count} pending items" naturally.`,
          type: "queue"
        });
        for (const { file } of unnotified) {
          this.notifiedFiles.add(file);
        }
        logEvent(`queue: notified ${count} pending interactive items (session=${sessionState})`);
      }
    }
  }
  processBatch() {
    const files = this.readQueueFiles();
    const lowFiles = files.filter((f) => f.startsWith("2-"));
    if (lowFiles.length === 0) return;
    const groups = /* @__PURE__ */ new Map();
    for (const file of lowFiles) {
      const item = this.readItem(file);
      if (!item) continue;
      const group = groups.get(item.name) ?? { items: [], files: [] };
      group.items.push(item);
      group.files.push(file);
      groups.set(item.name, group);
    }
    for (const [name, group] of groups) {
      const combined = group.items.length === 1 ? group.items[0].prompt : `Batch of ${group.items.length} events:

${group.items.map((it, i) => `--- Event ${i + 1} ---
${it.prompt}`).join("\n\n")}`;
      const batchItem = {
        ...group.items[0],
        prompt: combined
      };
      logEvent(`${name}: processing batch of ${group.items.length}`);
      this.executeItem(batchItem, null);
      for (const file of group.files) {
        this.moveToProcessed(file, "batched");
      }
    }
  }
  // ── Execute ───────────────────────────────────────────────────────
  executeItem(item, file) {
    if (item.exec === "interactive") {
      if (this.injectFn) {
        const opts = { type: item.source === "webhook" ? "webhook" : "event" };
        if (item.instruction) {
          opts.instruction = `${item.instruction}\n\n${item.prompt}`;
          this.injectFn("", `event:${item.name}`, " ", opts);
        } else {
          opts.instruction = item.prompt;
          this.injectFn("", `event:${item.name}`, " ", opts);
        }
      }
      if (file) this.moveToProcessed(file, "injected");
      return;
    }
    const channelId = this.resolveChannel(item.channel);
    if (item.exec === "non-interactive") {
      this.runningCount++;
      spawnClaudeP(item.name, item.prompt, (result, _code) => {
        this.runningCount--;
        if (result && this.sendFn) {
          this.sendFn(channelId, result).catch(
            (err) => logEvent(`${item.name}: send failed: ${err}`)
          );
        }
        logEvent(`${item.name}: result=${result.substring(0, 200)}`);
        if (file) this.moveToProcessed(file, "done");
      });
      return;
    }
    if (item.exec === "script" && item.script) {
      this.runningCount++;
      runScript(item.name, item.script, (result, _code) => {
        this.runningCount--;
        if (result && this.sendFn) {
          this.sendFn(channelId, result).catch(
            (err) => logEvent(`${item.name}: send failed: ${err}`)
          );
        }
        logEvent(`${item.name}: result=${result.substring(0, 200)}`);
        if (file) this.moveToProcessed(file, "done");
      });
      return;
    }
    logEvent(`${item.name}: unknown exec type: ${item.exec}`);
    if (file) this.moveToProcessed(file, "error");
  }
  // ── Helpers ───────────────────────────────────────────────────────
  readQueueFiles() {
    try {
      return readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }
  readItem(file) {
    try {
      return JSON.parse(readFileSync(join(QUEUE_DIR, file), "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") {
        logEvent(`queue: corrupt file ${file}`);
      }
      return null;
    }
  }
  moveToProcessed(file, status) {
    try {
      ensureDir(PROCESSED_DIR);
      renameSync(join(QUEUE_DIR, file), join(PROCESSED_DIR, `${status}-${file}`));
    } catch {
    }
  }
  resolveChannel(label) {
    if (!label || !this.channelsConfig) return "";
    const entry = this.channelsConfig?.[label];
    return entry?.channelId ?? label;
  }
  /** Remove items from queue — after processing, dismissal, or any resolution */
  resolveItems(name, status = "done") {
    const files = this.readQueueFiles();
    let count = 0;
    for (const file of files) {
      const item = this.readItem(file);
      if (!item) continue;
      if (item.name === name || name === "*") {
        this.moveToProcessed(file, status);
        this.notifiedFiles.delete(file);
        count++;
      }
    }
    if (count > 0) logEvent(`queue: resolved ${count} items (name=${name}, status=${status})`);
    return count;
  }
  /** Get queue status */
  getStatus() {
    const pending = this.readQueueFiles().length;
    return { pending, running: this.runningCount };
  }
  /** List pending interactive items */
  getPendingInteractive() {
    return this.readQueueFiles().map((f) => this.readItem(f)).filter((item) => item !== null && item.exec === "interactive");
  }
}
export {
  EventQueue
};
