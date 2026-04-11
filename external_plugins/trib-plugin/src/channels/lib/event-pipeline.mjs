import { basename } from "path";
import { EventQueue } from "./event-queue.mjs";
import { applyParser, evaluateFilter, applyTemplate, logEvent } from "./executor.mjs";
class EventPipeline {
  rules;
  queue;
  constructor(config, channelsConfig) {
    this.rules = (config?.rules ?? []).filter((r) => r.enabled !== false);
    this.queue = new EventQueue(config?.queue, channelsConfig);
  }
  getQueue() {
    return this.queue;
  }
  start() {
    this.queue.start();
  }
  stop() {
    this.queue.stop();
  }
  reloadConfig(config, channelsConfig) {
    this.rules = (config?.rules ?? []).filter((r) => r.enabled !== false);
    this.queue.reloadConfig(config?.queue, channelsConfig);
  }
  // ── Source: webhook ───────────────────────────────────────────────
  /** Handle an incoming webhook event */
  handleWebhook(endpointName, body, headers) {
    const rule = this.rules.find((r) => r.source === "webhook" && r.name === endpointName);
    if (!rule) return false;
    const data = applyParser(rule.parser, body, headers);
    if (rule.filter && !evaluateFilter(rule.filter, data)) {
      return true;
    }
    const prompt = applyTemplate(rule.execute, data);
    this.enqueue(rule, prompt);
    return true;
  }
  // ── Source: watcher ───────────────────────────────────────────────
  /** Handle an incoming chat message — check all watcher rules */
  handleMessage(text, user, channelId, isBot) {
    if (isBot) return;
    for (const rule of this.rules) {
      if (rule.source !== "watcher") continue;
      if (!rule.match) continue;
      try {
        const regex = new RegExp(rule.match, "i");
        if (!regex.test(text)) continue;
      } catch {
        logEvent(`${rule.name}: invalid match regex: ${rule.match}`);
        continue;
      }
      const data = {
        text,
        user,
        channel: channelId,
        match: text.match(new RegExp(rule.match, "i"))?.[0] ?? ""
      };
      const prompt = applyTemplate(rule.execute, data);
      logEvent(`${rule.name}: watcher matched "${rule.match}" from ${user}`);
      this.enqueue(rule, prompt);
    }
  }
  // ── Source: file (placeholder) ────────────────────────────────────
  /** Handle a file change event */
  handleFileChange(filePath, eventType) {
    for (const rule of this.rules) {
      if (rule.source !== "file") continue;
      if (!rule.path) continue;
      const pattern = rule.path.replace(/\*/g, ".*");
      if (!new RegExp(pattern).test(filePath)) continue;
      const data = {
        path: filePath,
        event: eventType,
        filename: basename(filePath)
      };
      const prompt = applyTemplate(rule.execute, data);
      logEvent(`${rule.name}: file ${eventType}: ${filePath}`);
      this.enqueue(rule, prompt);
    }
  }
  // ── Direct enqueue (folder-based webhooks) ─────────────────────────
  enqueueDirect(name, prompt, channel, exec = "interactive", instruction) {
    const item = {
      name,
      source: "webhook",
      priority: "normal",
      prompt,
      instruction,
      exec,
      channel,
      timestamp: Date.now()
    };
    this.queue.enqueue(item);
  }
  // ── Common enqueue ────────────────────────────────────────────────
  enqueue(rule, prompt) {
    const item = {
      name: rule.name,
      source: rule.source,
      priority: rule.priority,
      prompt,
      exec: rule.exec,
      channel: rule.channel,
      script: rule.script,
      timestamp: Date.now()
    };
    this.queue.enqueue(item);
  }
  // ── Status ────────────────────────────────────────────────────────
  getRules() {
    return this.rules;
  }
  getStatus() {
    return {
      rules: this.rules.length,
      queue: this.queue.getStatus()
    };
  }
}
export {
  EventPipeline
};
