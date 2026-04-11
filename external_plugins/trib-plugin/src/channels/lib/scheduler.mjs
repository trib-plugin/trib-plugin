import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join, isAbsolute } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { DATA_DIR, PLUGIN_ROOT } from "./config.mjs";
import { appendFileSync } from "fs";
import { spawn } from "child_process";
import { spawnClaudeP, runScript as execScript, ensureNopluginDir } from "./executor.mjs";
const DELEGATE_CLI = join(PLUGIN_ROOT, "scripts", "delegate-cli.mjs");
const SCHEDULE_LOG = join(DATA_DIR, "schedule.log");
function logSchedule(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  process.stderr.write(`trib-plugin scheduler: ${msg}
`);
  try {
    appendFileSync(SCHEDULE_LOG, line);
  } catch {
  }
}
import { isHoliday } from "./holidays.mjs";
import { tryRead } from "./settings.mjs";
const TICK_INTERVAL = 6e4;
const FREQUENCY_MAP = {
  1: { daily: 3, idleMinutes: 180 },
  // 3/day, 3h guard
  2: { daily: 5, idleMinutes: 120 },
  // 5/day, 2h guard
  3: { daily: 7, idleMinutes: 90 },
  // 7/day, 1.5h guard
  4: { daily: 10, idleMinutes: 60 },
  // 10/day, 1h guard
  5: { daily: 15, idleMinutes: 30 }
  // 15/day, 30m guard
};
class Scheduler {
  nonInteractive;
  interactive;
  proactive;
  channelsConfig;
  promptsDir;
  tickTimer = null;
  lastFired = /* @__PURE__ */ new Map();
  // name -> "YYYY-MM-DDTHH:MM"
  running = /* @__PURE__ */ new Set();
  injectFn = null;
  sendFn = null;
  // Activity tracking
  lastActivity = 0;
  // timestamp of last inbound message
  // Proactive state
  proactiveSlots = [];
  // minute-of-day slots for today
  proactiveSlotsDate = "";
  // "YYYY-MM-DD" when slots were generated
  proactiveLastFire = 0;
  // timestamp of last proactive fire
  proactiveFiredToday = 0;
  // count of proactive fires today
  deferred = /* @__PURE__ */ new Map();
  // name -> deferred-until timestamp
  skippedToday = /* @__PURE__ */ new Set();
  // names skipped for today
  holidayCountry = null;
  // ISO country code for holiday check
  holidayChecked = "";
  // "YYYY-MM-DD" last checked date
  todayIsHoliday = false;
  // cached result for today
  quietSchedule = null;
  // global quiet hours "HH:MM-HH:MM"
  constructor(nonInteractive, interactive, proactive, channelsConfig, botConfig) {
    this.nonInteractive = nonInteractive.filter((s) => s.enabled !== false);
    this.interactive = interactive.filter((s) => s.enabled !== false);
    this.proactive = proactive ?? null;
    this.channelsConfig = channelsConfig ?? null;
    this.promptsDir = join(DATA_DIR, "prompts");
    const hol = botConfig?.quiet?.holidays;
    if (hol === true) {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
      this.holidayCountry = locale.split("-")[1] || locale.toUpperCase().slice(0, 2);
    } else if (typeof hol === "string" && hol) {
      this.holidayCountry = hol;
    } else {
      this.holidayCountry = null;
    }
    this.quietSchedule = botConfig?.quiet?.schedule ?? null;
  }
  setInjectHandler(fn) {
    this.injectFn = fn;
  }
  setSendHandler(fn) {
    this.sendFn = fn;
  }
  noteActivity() {
    this.lastActivity = Date.now();
  }
  /** Defer a schedule by N minutes from now */
  defer(name, minutes) {
    this.deferred.set(name, Date.now() + minutes * 6e4);
  }
  /** Skip a schedule for the rest of today */
  skipToday(name) {
    this.skippedToday.add(name);
  }
  /** Check if a schedule should be skipped (deferred or skipped today) */
  shouldSkip(name) {
    if (this.skippedToday.has(name)) return true;
    const until = this.deferred.get(name);
    if (until && Date.now() < until) return true;
    if (until && Date.now() >= until) this.deferred.delete(name);
    return false;
  }
  /** Get current session state based on activity */
  getSessionState() {
    if (this.lastActivity === 0) return "idle";
    const elapsed = Date.now() - this.lastActivity;
    if (elapsed < 2 * 6e4) return "active";
    if (elapsed < 5 * 6e4) return "recent";
    return "idle";
  }
  /** Get time context for prompt enrichment */
  getTimeContext() {
    const now = /* @__PURE__ */ new Date();
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dow = now.getDay();
    return {
      hour: now.getHours(),
      dayOfWeek: days[dow],
      isWeekend: dow === 0 || dow === 6
    };
  }
  /** Wrap prompt with session context metadata */
  wrapPrompt(name, prompt, type) {
    const state = this.getSessionState();
    const time = this.getTimeContext();
    const header = [
      `[schedule: ${name} | type: ${type} | session: ${state}]`,
      `[time: ${time.dayOfWeek} ${String(time.hour).padStart(2, "0")}:${String((/* @__PURE__ */ new Date()).getMinutes()).padStart(2, "0")} | weekend: ${time.isWeekend}]`,
      `Before starting any work, briefly tell the user what you're about to do in one short sentence.`
    ].join("\n");
    return `${header}

${prompt}`;
  }
  static SCHEDULER_LOCK = join(tmpdir(), "trib-plugin-scheduler.lock");
  static INSTANCE_UUID = randomUUID();
  start() {
    if (this.tickTimer) return;
    const total = this.nonInteractive.length + this.interactive.length + (this.proactive?.items.length ?? 0);
    if (total === 0) {
      process.stderr.write("trib-plugin scheduler: no schedules configured\n");
      return;
    }
    ensureNopluginDir();
    const lockContent = `${process.pid}
${Date.now()}
${Scheduler.INSTANCE_UUID}`;
    try {
      writeFileSync(Scheduler.SCHEDULER_LOCK, lockContent, { flag: "wx" });
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const content = readFileSync(Scheduler.SCHEDULER_LOCK, "utf8");
          const lines = content.split("\n");
          const pid = parseInt(lines[0]);
          const lockTime = parseInt(lines[1]) || 0;
          const lockUuid = lines[2] || "";
          const lockAge = Date.now() - lockTime;
          let isAlive = false;
          try {
            process.kill(pid, 0);
            isAlive = true;
          } catch {
          }
          if (isAlive) {
            if (lockAge > 60 * 60 * 1e3 && lockUuid !== Scheduler.INSTANCE_UUID) {
              process.stderr.write(`trib-plugin scheduler: lock PID ${pid} alive but stale (${Math.round(lockAge / 6e4)}m), reclaiming (PID reuse)
`);
            } else {
              process.stderr.write(`trib-plugin scheduler: another session (PID ${pid}) owns the scheduler, skipping
`);
              return;
            }
          }
        } catch {
        }
        writeFileSync(Scheduler.SCHEDULER_LOCK, lockContent);
      } else {
        throw err;
      }
    }
    process.on("exit", () => {
      try {
        unlinkSync(Scheduler.SCHEDULER_LOCK);
      } catch {
      }
    });
    logSchedule(`${this.nonInteractive.length} non-interactive, ${this.interactive.length} interactive, ${this.proactive?.items.length ?? 0} proactive
`);
    this.tick();
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL);
  }
  stop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
  restart() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    try {
      unlinkSync(Scheduler.SCHEDULER_LOCK);
    } catch {
    }
    this.start();
  }
  reloadConfig(nonInteractive, interactive, proactive, channelsConfig, botConfig, options = {}) {
    this.nonInteractive = nonInteractive.filter((s) => s.enabled !== false);
    this.interactive = interactive.filter((s) => s.enabled !== false);
    this.proactive = proactive ?? null;
    this.channelsConfig = channelsConfig ?? null;
    this.promptsDir = join(DATA_DIR, "prompts");
    const hol2 = botConfig?.quiet?.holidays;
    if (hol2 === true) {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
      this.holidayCountry = locale.split("-")[1] || locale.toUpperCase().slice(0, 2);
    } else if (typeof hol2 === "string" && hol2) {
      this.holidayCountry = hol2;
    } else {
      this.holidayCountry = null;
    }
    this.quietSchedule = botConfig?.quiet?.schedule ?? null;
    this.holidayChecked = "";
    this.todayIsHoliday = false;
    this.proactiveSlots = [];
    this.proactiveSlotsDate = "";
    this.proactiveFiredToday = 0;
    if (this.deferred.size > 0 || this.skippedToday.size > 0) {
      process.stderr.write(`trib-plugin scheduler: reload clearing ${this.deferred.size} deferred, ${this.skippedToday.size} skipped
`);
    }
    this.deferred.clear();
    this.skippedToday.clear();
    if (options.restart === false) return;
    this.restart();
  }
  getStatus() {
    const result = [];
    for (const s of this.nonInteractive) {
      result.push({
        name: s.name,
        time: s.time,
        days: s.days ?? "daily",
        type: "non-interactive",
        running: false,
        lastFired: this.lastFired.get(s.name) ?? null
      });
    }
    for (const s of this.interactive) {
      result.push({
        name: s.name,
        time: s.time,
        days: s.days ?? "daily",
        type: "interactive",
        running: false,
        lastFired: this.lastFired.get(s.name) ?? null
      });
    }
    if (this.proactive) {
      for (const item of this.proactive.items) {
        result.push({
          name: `proactive:${item.topic}`,
          time: `freq=${this.proactive.frequency}`,
          days: "daily",
          type: "proactive",
          running: false,
          lastFired: this.lastFired.get(`proactive:${item.topic}`) ?? null
        });
      }
    }
    return result;
  }
  async triggerManual(name) {
    const timed = [...this.nonInteractive, ...this.interactive].find((e) => e.name === name);
    if (timed) {
      if (this.running.has(name)) return `"${name}" is already running`;
      const isNonInteractive = this.nonInteractive.includes(timed);
      const now = /* @__PURE__ */ new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      this.lastFired.set(name, `${dateStr}T${hhmm}`);
      await this.fireTimed(timed, isNonInteractive ? "non-interactive" : "interactive");
      return `triggered "${name}"`;
    }
    if (this.proactive) {
      const topic = name.replace(/^proactive:/, "");
      const item = this.proactive.items.find((i) => i.topic === topic);
      if (item) {
        if (this.lastActivity > 0 && Date.now() - this.lastActivity < 5 * 6e4) {
          return `skipped proactive "${topic}" \u2014 conversation active (last activity ${Math.floor((Date.now() - this.lastActivity) / 1e3)}s ago)`;
        }
        await this.fireProactiveTick(item.topic);
        return `triggered proactive "${topic}"`;
      }
    }
    return `schedule "${name}" not found`;
  }
  // ── Tick ─────────────────────────────────────────────────────────────
  tick() {
    this.tickAsync().catch(
      (err) => process.stderr.write(`trib-plugin scheduler: tick error: ${err}
`)
    );
  }
  async tickAsync() {
    const now = /* @__PURE__ */ new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const key = `${dateStr}T${hhmm}`;
    const dow = now.getDay();
    const isWeekend = dow === 0 || dow === 6;
    if (this.holidayCountry && this.holidayChecked !== dateStr) {
      this.holidayChecked = dateStr;
      try {
        this.todayIsHoliday = await isHoliday(now, this.holidayCountry);
        if (this.todayIsHoliday) {
          process.stderr.write(`trib-plugin scheduler: today (${dateStr}) is a holiday \u2014 weekday schedules will be skipped
`);
        }
      } catch (err) {
        process.stderr.write(`trib-plugin scheduler: holiday check failed: ${err}
`);
        this.todayIsHoliday = false;
      }
    }
    const allTimed = [
      ...this.nonInteractive.map((s) => ({ schedule: s, type: "non-interactive" })),
      ...this.interactive.map((s) => ({ schedule: s, type: "interactive" }))
    ];
    for (const { schedule: s, type } of allTimed) {
      const days = s.days ?? "daily";
      if (!this.matchesDays(days, dow, isWeekend)) continue;
      if (this.todayIsHoliday && (s.skipHolidays || days === "weekday")) {
        const skipKey = `holiday:${dateStr}:${s.name}`;
        if (!this.lastFired.has(skipKey)) {
          this.lastFired.set(skipKey, dateStr);
          logSchedule(`skipping "${s.name}" \u2014 public holiday
`);
        }
        continue;
      }
      if (s.dnd && this.isQuietHours(now)) continue;
      const intervalMatch = s.time.match(/^every(\d+)m$/);
      let shouldFire = false;
      if (intervalMatch) {
        const intervalMs = parseInt(intervalMatch[1]) * 6e4;
        const lastKey = this.lastFired.get(s.name);
        const lastTime = lastKey ? new Date(lastKey).getTime() : 0;
        shouldFire = Date.now() - lastTime >= intervalMs;
      } else if (s.time === "hourly") {
        shouldFire = now.getMinutes() === 0 && this.lastFired.get(s.name) !== key;
      } else {
        shouldFire = s.time === hhmm && this.lastFired.get(s.name) !== key;
      }
      if (!shouldFire) continue;
      if (this.shouldSkip(s.name)) continue;
      this.lastFired.set(s.name, now.toISOString());
      this.fireTimed(s, type).catch(
        (err) => process.stderr.write(`trib-plugin scheduler: ${s.name} failed: ${err}
`)
      );
    }
    this.tickProactive(now, dateStr);
  }
  // ── Proactive tick ──────────────────────────────────────────────────
  proactiveNextTick = 0;
  // timestamp of next proactive tick
  tickProactive(now, _dateStr) {
    if (!this.proactive) return;
    if (this.isQuietHours(now)) return;
    if (this.proactiveNextTick === 0) {
      this.scheduleNextProactiveTick();
    }
    if (Date.now() < this.proactiveNextTick) return;
    if (this.getSessionState() !== "idle") return;
    this.scheduleNextProactiveTick();
    this.fireProactiveTick();
  }
  scheduleNextProactiveTick() {
    const intervalMs = (this.proactive?.interval ?? 60) * 6e4;
    const jitter = intervalMs * 0.2;
    this.proactiveNextTick = Date.now() + intervalMs + (Math.random() * jitter * 2 - jitter);
    const next = new Date(this.proactiveNextTick);
    logSchedule(`proactive next tick: ${next.toLocaleTimeString()}
`);
  }
  /** Day abbreviation → JS day number (0=Sun...6=Sat) */
  static DAY_ABBRS = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6
  };
  /** Check if today matches the schedule's days setting */
  matchesDays(days, dow, isWeekend) {
    if (days === "daily") return true;
    if (days === "weekday") return !isWeekend;
    if (days === "weekend") return isWeekend;
    const dayList = days.split(",").map((d) => d.trim().toLowerCase());
    return dayList.some((d) => Scheduler.DAY_ABBRS[d] === dow);
  }
  /** Check if current time is within global quiet hours (quiet.schedule) */
  isQuietHours(now) {
    if (!this.quietSchedule) return false;
    const parts = this.quietSchedule.split("-");
    if (parts.length !== 2) return false;
    const [start, end] = parts;
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (start > end) return hhmm >= start || hhmm < end;
    return hhmm >= start && hhmm < end;
  }
  generateDailySlots(dateStr) {
    this.proactiveSlotsDate = dateStr;
    this.proactiveFiredToday = 0;
    this.skippedToday.clear();
    this.deferred.clear();
    if (!this.proactive) {
      this.proactiveSlots = [];
      return;
    }
    const freq = Math.max(1, Math.min(5, this.proactive.frequency));
    const { daily } = FREQUENCY_MAP[freq];
    const start = 420;
    const end = 1320;
    const slots = /* @__PURE__ */ new Set();
    for (let i = 0; i < daily; i++) {
      slots.add(start + Math.floor(Math.random() * (end - start)));
    }
    this.proactiveSlots = [...slots].sort((a, b) => a - b);
    process.stderr.write(`trib-plugin scheduler: proactive slots for ${dateStr}: ${this.proactiveSlots.map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`).join(", ")}
`);
  }
  // ── Fire timed schedule ─────────────────────────────────────────────
  async fireTimed(schedule, type) {
    const execMode = schedule.exec ?? "prompt";
    if (execMode === "script" || execMode === "script+prompt") {
      if (!schedule.script) {
        process.stderr.write(`trib-plugin scheduler: no script specified for "${schedule.name}"
`);
        return;
      }
      if (this.running.has(schedule.name)) return;
      this.running.add(schedule.name);
      const channelId2 = this.resolveChannel(schedule.channel);
      logSchedule(`firing ${schedule.name} (${type}, exec=${execMode})
`);
      try {
        const scriptResult = await this.runScript(schedule.script);
        if (execMode === "script") {
          this.running.delete(schedule.name);
          if (scriptResult && this.sendFn) {
            await this.sendFn(channelId2, scriptResult).catch(
              (err) => process.stderr.write(`trib-plugin scheduler: ${schedule.name} relay failed: ${err}
`)
            );
          }
          process.stderr.write(`trib-plugin scheduler: ${schedule.name} script done
`);
          return;
        }
        const prompt2 = this.loadPrompt(schedule.prompt ?? `${schedule.name}.md`);
        if (!prompt2) {
          this.running.delete(schedule.name);
          process.stderr.write(`trib-plugin scheduler: prompt not found for "${schedule.name}"
`);
          return;
        }
        const combinedPrompt = `${prompt2}

---
## Script Output
\`\`\`
${scriptResult}
\`\`\``;
        this.running.delete(schedule.name);
        await this.fireTimedPrompt(schedule, type, combinedPrompt, channelId2);
        return;
      } catch (err) {
        this.running.delete(schedule.name);
        process.stderr.write(`trib-plugin scheduler: ${schedule.name} script error: ${err}
`);
        return;
      }
    }
    const prompt = this.resolvePrompt(schedule);
    if (!prompt) {
      process.stderr.write(`trib-plugin scheduler: prompt not found for "${schedule.name}"
`);
      return;
    }
    const channelId = this.resolveChannel(schedule.channel);
    await this.fireTimedPrompt(schedule, type, prompt, channelId);
  }
  /** Fire a timed schedule with the given prompt content */
  async fireTimedPrompt(schedule, type, prompt, channelId) {
    logSchedule(`firing ${schedule.name} (${type})
`);
    if (type === "interactive") {
      if (this.injectFn) {
        this.injectFn(channelId, schedule.name, " ", {
          instruction: prompt,
          type: "schedule"
        });
      }
      return;
    }
    if (this.running.has(schedule.name)) return;
    this.running.add(schedule.name);
    if (existsSync(DELEGATE_CLI)) {
      const args = [DELEGATE_CLI];
      if (this.proactive?.model) args.push("--preset", this.proactive.model);
      args.push(prompt);
      const child = spawn("node", args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 12e4,
        env: { ...process.env }
      });
      let stdout = "";
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.on("close", (code) => {
        this.running.delete(schedule.name);
        let result = "";
        try {
          const parsed = JSON.parse(stdout);
          result = parsed.content || stdout.trim();
        } catch {
          result = stdout.trim();
        }
        if (result && this.sendFn) {
          this.sendFn(channelId, result).catch(
            (err) => process.stderr.write(`trib-plugin scheduler: ${schedule.name} relay failed: ${err}
`)
          );
        }
        logSchedule(`${schedule.name} delegate done (${code})
`);
      });
      child.on("error", () => {
        this.running.delete(schedule.name);
      });
    } else {
      spawnClaudeP(schedule.name, prompt, (result, code) => {
        this.running.delete(schedule.name);
        if (result && this.sendFn) {
          this.sendFn(channelId, result).catch(
            (err) => process.stderr.write(`trib-plugin scheduler: ${schedule.name} relay failed: ${err}
`)
          );
        }
        logSchedule(`${schedule.name} claude-p done (${code})
`);
      });
    }
  }
  // ── Script execution (delegates to shared executor) ────────────────
  runScript(scriptName) {
    return new Promise((resolve, reject) => {
      execScript(`schedule:${scriptName}`, scriptName, (result, code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`script exited with code ${code}`));
        } else {
          resolve(result);
        }
      });
    });
  }
  // ── Fire proactive (delegate-cli autonomous) ────────────────────────
  proactiveDataFetcher = null;
  proactiveDbUpdater = null;
  setProactiveHandlers(dataFetcher, dbUpdater) {
    this.proactiveDataFetcher = dataFetcher;
    this.proactiveDbUpdater = dbUpdater;
  }
  async fireProactiveTick(preferredTopic) {
    if (!existsSync(DELEGATE_CLI)) {
      logSchedule("proactive: delegate-cli not found, skipping\n");
      return;
    }
    const data = await this.proactiveDataFetcher?.() ?? { memory: "", sources: [] };
    const now = /* @__PURE__ */ new Date();
    const timeInfo = `${now.toLocaleDateString("ko-KR")} ${now.toLocaleTimeString("ko-KR")} (${["\uC77C", "\uC6D4", "\uD654", "\uC218", "\uBAA9", "\uAE08", "\uD1A0"][now.getDay()]}\uC694\uC77C)`;
    const sourcesText = data.sources.length > 0 ? data.sources.map((s) => `- [${s.category}] ${s.topic} (score: ${s.score}, used: ${s.hit_count}/${s.hit_count + s.skip_count})`).join("\n") : "(no sources registered)";
    const preferredTopicText = preferredTopic ? `
## Manual Trigger Preference
Prefer the topic "${preferredTopic}" if it is available and suitable. Only choose another source when that topic is unavailable or clearly not a good fit right now.
` : "";
    const task = `You are a proactive conversation agent. You run periodically in the background.

## Current Time
${timeInfo}

## User Recent Context (from memory)
${data.memory || "(no recent context)"}

## Available Conversation Sources
${sourcesText}
${preferredTopicText}

## Your Job (do all of these in order)
1. **Judge availability**: Based on the memory context, is now a good time to talk? If the user seems busy, stressed, or in deep focus \u2192 respond with ONLY the JSON below with action:"skip".
2. **Discover new sources**: If you see interesting topics from recent conversations that aren't in the source list, include them in sourceUpdates.add.
3. **Pick a source**: Randomly pick one from the available sources (weighted by score). Research or compose material for it.
4. **Prepare message**: Write a natural, casual conversation starter in Korean (1-2 sentences). Be specific, not generic.
5. **Score adjustments**: Suggest score changes for sources based on what seems relevant now.

## Response Format (JSON only, no markdown)
{
  "action": "talk" | "skip",
  "message": "prepared conversation starter (Korean)",
  "sourcePicked": "topic name",
  "sourceUpdates": {
    "add": [{ "category": "...", "topic": "...", "query": "..." }],
    "remove": ["topic name"],
    "scores": { "topic name": 0.1 }
  },
  "log": "brief internal note about what you decided and why"
}`;
    logSchedule("proactive: firing delegate-cli\n");
    const model = this.proactive?.model ?? "";
    const args = [DELEGATE_CLI];
    if (model) args.push("--preset", model);
    args.push(task);
    const child = spawn("node", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 9e4,
      env: { ...process.env }
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.on("close", (_code) => {
      let result;
      try {
        const outer = JSON.parse(stdout);
        const content = outer.content || stdout;
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      } catch {
        logSchedule(`proactive: failed to parse response
`);
        return;
      }
      if (!result) return;
      if (result.log) {
        const logPath = join(DATA_DIR, "proactive.log");
        try {
          appendFileSync(logPath, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${result.log}
`);
        } catch {
        }
      }
      if (result.sourceUpdates) {
        this.proactiveDbUpdater?.(result.sourceUpdates);
      }
      if (result.action !== "talk" || !result.message) {
        logSchedule(`proactive: skip (${result.log || "no reason"})
`);
        return;
      }
      logSchedule(`proactive: "${result.sourcePicked}" \u2192 inject
`);
      this.proactiveLastFire = Date.now();
      this.proactiveFiredToday++;
      if (this.injectFn) {
        this.injectFn("", `proactive:${result.sourcePicked || "chat"}`, " ", {
          instruction: result.message
        });
      }
    });
    child.on("error", (err) => {
      logSchedule(`proactive: delegate error: ${err.message}
`);
    });
  }
  // ── Helpers ─────────────────────────────────────────────────────────
  /** Resolve a channel label to its platform ID via channelsConfig, fallback to raw value */
  resolveChannel(label) {
    const nested = this.channelsConfig?.channels?.[label]?.id;
    if (nested) return nested;
    const flat = this.channelsConfig?.[label];
    if (flat?.channelId) return flat.channelId;
    if (flat?.id) return flat.id;
    return label;
  }
  /** Resolve prompt: try file first, fall back to inline text */
  resolvePrompt(schedule) {
    const ref = schedule.prompt ?? `${schedule.name}.md`;
    const fromFile = this.loadPrompt(ref);
    if (fromFile) return fromFile;
    if (schedule.prompt) return schedule.prompt;
    return null;
  }
  loadPrompt(nameOrPath) {
    const full = isAbsolute(nameOrPath) ? nameOrPath : join(this.promptsDir, nameOrPath);
    return tryRead(full);
  }
}
export {
  Scheduler
};
