import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { DATA_DIR, loadConfig, loadBotConfig, saveBotConfig, loadProfileConfig, saveProfileConfig } from "./config.mjs";
import { withConfigLock } from "./config-lock.mjs";
import { t } from "./i18n.mjs";
function makeParsedCommand(cmd, args = [], params = {}) {
  return { cmd, args, params };
}
function parseCommand(input) {
  const match = input.match(/^\/(bot|profile)\s*\((.*)?\)\s*$/s);
  if (!match) return null;
  const cmd = match[1];
  const inner = (match[2] ?? "").trim();
  if (!inner) return { cmd, args: [], params: {} };
  const args = [];
  const params = {};
  const tokens = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ",") {
      tokens.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) tokens.push(current.trim());
  for (const token of tokens) {
    const eqIdx = token.indexOf("=");
    if (eqIdx > 0) {
      const key = token.slice(0, eqIdx).trim();
      let val = token.slice(eqIdx + 1).trim();
      if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) {
        val = val.slice(1, -1);
      }
      params[key] = val;
    } else {
      args.push(token);
    }
  }
  return { cmd, args, params };
}
function savePluginConfig(config) {
  const configPath = join(DATA_DIR, "config.json");
  void withConfigLock(() => {
    const current = (() => {
      try {
        return JSON.parse(readFileSync(configPath, "utf8"));
      } catch {
        return {};
      }
    })();
    const merged = { ...current, ...config };
    const tmp = configPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
    renameSync(tmp, configPath);
  });
}
function refreshRuntime(ctx) {
  if (ctx.reloadRuntimeConfig) ctx.reloadRuntimeConfig();
  else ctx.scheduler.restart();
}
async function handleBotCommand(parsed, ctx) {
  const sub = parsed.args[0] ?? "status";
  switch (sub) {
    case "schedule":
      return handleSchedule(parsed, ctx);
    case "quiet":
      return handleQuiet(parsed, ctx);
    case "activity":
      return handleActivity(parsed, ctx);
    case "profile":
      return handleBotProfile(parsed, ctx);
    // "sleeping" dispatch removed in v0.6.47 (Ship 4) — use quiet.schedule for quiet hours; memory cycle2/sleep is a separate concept.
    case "display":
      return handleDisplay(parsed, ctx);
    case "status":
      return handleBotStatus(ctx);
    case "help":
      return {
        embeds: [{
          title: "trib-plugin Commands",
          description: [
            "**Simple**",
            "`/bot status`",
            "`/bot profile`",
            "`/bot schedule list`",
            "",
            "**Parameterized**",
            "`/bot quiet schedule HH:MM-HH:MM`",
            "`/bot sleeping on|off|run|time HH:MM`",
            "`/bot display view|hide`",
            "`/bot schedule add ...`",
            "",
            "**Guided setup**",
            "Use `/trib-plugin setup` for first-run onboarding."
          ].join("\n"),
          color: 5793266
        }]
      };
    default:
      return { text: t("unknown_sub", ctx.lang, { sub }) };
  }
}
function handleBotStatus(_ctx) {
  const config = loadConfig();
  const bot = loadBotConfig();
  const ni = config.nonInteractive ?? [];
  const i = config.interactive ?? [];
  const lines = [];
  lines.push(`**Schedules** ${ni.length + i.length} registered`);
  const quietParts = [];
  if (bot.quiet?.schedule) quietParts.push(bot.quiet.schedule);
  lines.push(`**Quiet** ${quietParts.length > 0 ? quietParts.join(", ") : "none"}`);
  const chCount = Object.keys(config.channelsConfig?.channels ?? {}).length;
  lines.push(`**Channels** ${chCount}`);
  const profile = loadProfileConfig();
  lines.push(`**Profile** ${profile.name || "-"}`);
  return {
    embeds: [{
      title: "\u2699\uFE0F Bot Dashboard",
      description: lines.join("\n"),
      color: 5793266
    }]
  };
}
function handleActivity(parsed, ctx) {
  const action = parsed.args[1] ?? "list";
  switch (action) {
    case "list":
      return activityList(ctx);
    case "add":
      return activityAdd(parsed, ctx);
    case "remove":
      return activityRemove(parsed, ctx);
    default:
      return { text: t("unknown_action", ctx.lang, { action }) };
  }
}
function activityList(ctx) {
  const config = loadConfig();
  const channels = config.channelsConfig?.channels ?? {};
  const main = config.channelsConfig?.main ?? "";
  const entries = Object.entries(channels);
  if (entries.length === 0) {
    return {
      embeds: [{
        title: "\u{1F4E1} Activity Channels",
        description: t("activity.empty", ctx.lang),
        color: 5793266
      }]
    };
  }
  const chLines = entries.map(([name, entry]) => {
    const star = name === main ? " \u2B50" : "";
    return `**${name}${star}** \u2014 ${entry.mode} (\`${entry.id}\`)`;
  });
  return {
    embeds: [{ title: "\u{1F4E1} Activity Channels", description: chLines.join("\n"), color: 5793266 }]
  };
}
function activityAdd(parsed, ctx) {
  const name = parsed.args[2] ?? parsed.params.name;
  if (!name) return { text: t("activity.missing_name", ctx.lang) };
  const id = parsed.params.id;
  if (!id) return { text: t("activity.missing_id", ctx.lang) };
  const mode = parsed.params.mode ?? "interactive";
  const config = loadConfig();
  if (!config.channelsConfig) {
    config.channelsConfig = { main: name, channels: {} };
  }
  if (config.channelsConfig.channels[name]) {
    return { text: t("activity.exists", ctx.lang, { name }) };
  }
  config.channelsConfig.channels[name] = { id, mode };
  if (!config.access) {
    config.access = {
      dmPolicy: "pairing",
      allowFrom: [],
      channels: {}
    };
  }
  if (!config.access.channels[id]) {
    config.access.channels[id] = { requireMention: true, allowFrom: [] };
  }
  savePluginConfig(config);
  refreshRuntime(ctx);
  return { text: t("activity.added", ctx.lang, { name }) };
}
function activityRemove(parsed, ctx) {
  const name = parsed.args[2] ?? parsed.params.name;
  if (!name) return { text: t("activity.missing_name", ctx.lang) };
  const config = loadConfig();
  if (!config.channelsConfig?.channels[name]) {
    return { text: t("activity.not_found", ctx.lang, { name }) };
  }
  const removedId = config.channelsConfig.channels[name].id;
  delete config.channelsConfig.channels[name];
  if (removedId && config.access?.channels?.[removedId]) {
    delete config.access.channels[removedId];
  }
  savePluginConfig(config);
  refreshRuntime(ctx);
  return { text: t("activity.removed", ctx.lang, { name }) };
}
function handleBotProfile(parsed, ctx) {
  if ((parsed.args[1] === "set" || Object.keys(parsed.params).length > 0) && parsed.args[0] === "profile") {
    return handleProfileCommand(
      { cmd: "profile", args: ["set"], params: parsed.params },
      ctx
    );
  }
  const profile = loadProfileConfig();
  const entries = Object.entries(profile).filter(([_, v]) => v !== void 0);
  if (entries.length === 0) {
    return {
      embeds: [{
        title: "\u{1F464} Profile",
        description: t("profile.empty", ctx.lang),
        color: 5763719
      }]
    };
  }
  const profileLines = entries.map(([k, v]) => `**${k}**: ${v}`);
  return {
    embeds: [{ title: "\u{1F464} Profile", description: profileLines.join("\n"), color: 5763719 }]
  };
}
function handleQuiet(parsed, ctx) {
  const action = parsed.args[1] ?? "status";
  const bot = loadBotConfig();
  const value = parsed.args[2] ?? parsed.params.value;
  switch (action) {
    case "status":
    case "list": {
      const q = bot.quiet ?? {};
      const lines = [
        `**\uC2A4\uCF00\uC904 \uBC29\uD574\uAE08\uC9C0**: ${q.schedule ?? "-"}`,
        `**\uACF5\uD734\uC77C \uAD6D\uAC00**: ${q.holidays ?? "-"}`,
        `**\uC2DC\uAC04\uB300**: ${q.timezone ?? "system"}`
      ];
      return {
        embeds: [{
          title: `\u{1F515} ${t("quiet.status", ctx.lang)}`,
          description: lines.join("\n"),
          color: 5793266
        }]
      };
    }
    case "schedule": {
      if (!value) return { text: t("unknown_action", ctx.lang, { action: "schedule (value required)" }) };
      if (!bot.quiet) bot.quiet = {};
      bot.quiet.schedule = value;
      saveBotConfig(bot);
      refreshRuntime(ctx);
      return { text: t("quiet.updated", ctx.lang) };
    }
    case "holidays": {
      if (!value) return { text: t("unknown_action", ctx.lang, { action: "holidays (value required)" }) };
      if (!bot.quiet) bot.quiet = {};
      bot.quiet.holidays = value;
      saveBotConfig(bot);
      refreshRuntime(ctx);
      return { text: t("quiet.updated", ctx.lang) };
    }
    case "timezone": {
      if (!value) return { text: t("unknown_action", ctx.lang, { action: "timezone (value required)" }) };
      if (!bot.quiet) bot.quiet = {};
      bot.quiet.timezone = value;
      saveBotConfig(bot);
      refreshRuntime(ctx);
      return { text: t("quiet.updated", ctx.lang) };
    }
    default:
      return { text: t("unknown_action", ctx.lang, { action }) };
  }
}
// handleSleeping removed in v0.6.47 (Phase B Ship 4). The "sleeping" bot command and its sleepEnabled/sleepTime fields were unused; quiet.schedule covers quiet hours and memory cycle2/sleep is a separate concept that remains.
function handleDisplay(parsed, _ctx) {
  const mode = parsed.args[1];
  if (!mode) {
    const config = loadBotConfig();
    const displayMode = config?.displayMode ?? "view";
    return {
      embeds: [{
        title: "\u{1F5A5} Display Mode",
        description: `**Current**: ${displayMode}`,
        color: 5793266
      }]
    };
  }
  if (mode === "view" || mode === "hide") {
    writeBotField("displayMode", mode);
    return { text: `Display mode set to ${mode}.` };
  }
  return { text: "Usage: /bot display [view|hide]" };
}
function writeBotField(key, value) {
  const bot = loadBotConfig();
  bot[key] = value;
  saveBotConfig(bot);
}
async function handleSchedule(parsed, ctx) {
  const action = parsed.args[1] ?? "list";
  switch (action) {
    case "list":
      return scheduleList(ctx);
    case "detail":
      return scheduleDetail(parsed, ctx);
    case "add":
      return scheduleAdd(parsed, ctx);
    case "edit":
      return scheduleEdit(parsed, ctx);
    case "remove":
      return scheduleRemove(parsed, ctx);
    case "test":
      return scheduleTest(parsed, ctx);
    default:
      return { text: t("unknown_action", ctx.lang, { action }) };
  }
}
function scheduleList(ctx) {
  const config = loadConfig();
  const all = [
    ...(config.nonInteractive ?? []).map((s) => ({ ...s, type: "non-interactive" })),
    ...(config.interactive ?? []).map((s) => ({ ...s, type: "interactive" }))
  ];
  if (all.length === 0) {
    return { text: t("schedule.empty", ctx.lang) };
  }
  const lines = all.map((s) => {
    const status = s.enabled === false ? " [OFF]" : "";
    const days = s.days ?? "daily";
    return `**${s.name}** \u2014 ${s.time} ${days}${status}`;
  });
  const options = all.slice(0, 25).map((s) => ({
    label: s.name,
    value: s.name,
    description: `${s.time} (${s.type})`.substring(0, 100)
  }));
  if (options.length > 0) {
  }
  return {
    embeds: [{
      title: "\u{1F4C5} Schedule",
      description: lines.join("\n"),
      color: 5793266
    }]
  };
}
function scheduleDetail(parsed, ctx) {
  const name = parsed.args[2] ?? parsed.params.name;
  if (!name) return { text: t("schedule.missing_name", ctx.lang) };
  const config = loadConfig();
  let entry;
  let schedType = "";
  for (const [key, label] of [["interactive", "interactive"], ["nonInteractive", "non-interactive"]]) {
    const list = config[key];
    if (!list) continue;
    const found = list.find((s) => s.name === name);
    if (found) {
      entry = found;
      schedType = label;
      break;
    }
  }
  if (!entry) return { text: t("schedule.not_found", ctx.lang, { name }) };
  const detailLines = [
    `**Time**: ${entry.time}`,
    `**Period**: ${entry.days ?? "daily"}`,
    `**Mode**: ${schedType}`,
    `**Channel**: ${entry.channel}`,
    `**Exec**: ${entry.exec ?? "prompt"}`,
    `**active**: ${entry.enabled !== false ? "Yes" : "No"}`
  ];
  if (entry.script) detailLines.push(`**Script**: ${entry.script}`);
  return {
    embeds: [{
      title: `\u{1F4C4} ${name}`,
      description: detailLines.join("\n"),
      color: 5793266
    }]
  };
}
function scheduleAdd(parsed, ctx) {
  const name = parsed.args[2] ?? parsed.params.name;
  if (!name) return { text: t("schedule.missing_name", ctx.lang) };
  const time = parsed.params.time;
  const channel = parsed.params.channel ?? "general";
  if (!time) return { text: t("schedule.missing_fields", ctx.lang) };
  const mode = parsed.params.mode ?? "interactive";
  const days = parsed.params.period ?? parsed.params.days ?? "daily";
  const prompt = parsed.params.prompt;
  const config = loadConfig();
  const targetKey = mode === "non-interactive" ? "nonInteractive" : "interactive";
  const existsI = (config.interactive ?? []).find((s) => s.name === name);
  const existsN = (config.nonInteractive ?? []).find((s) => s.name === name);
  if (existsI || existsN) {
    return { text: t("schedule.exists", ctx.lang, { name }) };
  }
  if (!config[targetKey]) config[targetKey] = [];
  const arr = config[targetKey];
  arr.push({ name, time, channel, days, enabled: true });
  savePluginConfig(config);
  if (prompt) {
    const promptsDir = join(DATA_DIR, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    const promptPath = join(promptsDir, `${name}.md`);
    writeFileSync(promptPath, prompt + "\n", "utf8");
  }
  refreshRuntime(ctx);
  return { text: t("schedule.added", ctx.lang, { name, mode, time }) };
}
function scheduleEdit(parsed, ctx) {
  const name = parsed.args[2] ?? parsed.params.name;
  if (!name) return { text: t("schedule.missing_name", ctx.lang) };
  const config = loadConfig();
  let entry;
  for (const key of ["interactive", "nonInteractive"]) {
    const list = config[key];
    if (!list) continue;
    const found = list.find((s) => s.name === name);
    if (found) {
      entry = found;
      break;
    }
  }
  if (!entry) return { text: t("schedule.not_found", ctx.lang, { name }) };
  if (parsed.params.time) entry.time = parsed.params.time;
  if (parsed.params.channel) entry.channel = parsed.params.channel;
  if (parsed.params.period || parsed.params.days) entry.days = parsed.params.period ?? parsed.params.days;
  if (parsed.params.enabled !== void 0) entry.enabled = parsed.params.enabled !== "false";
  if (parsed.params.exec) entry.exec = parsed.params.exec;
  if (parsed.params.script) entry.script = parsed.params.script;
  if (parsed.params.prompt) {
    const promptsDir = join(DATA_DIR, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    const promptPath = join(promptsDir, `${name}.md`);
    writeFileSync(promptPath, parsed.params.prompt + "\n", "utf8");
  }
  savePluginConfig(config);
  refreshRuntime(ctx);
  return { text: t("schedule.edited", ctx.lang, { name }) };
}
function scheduleRemove(parsed, ctx) {
  const name = parsed.args[2] ?? parsed.params.name;
  if (!name) return { text: t("schedule.missing_name", ctx.lang) };
  const config = loadConfig();
  let found = false;
  for (const key of ["interactive", "nonInteractive"]) {
    const list = config[key];
    if (!list) continue;
    const idx = list.findIndex((s) => s.name === name);
    if (idx >= 0) {
      list.splice(idx, 1);
      found = true;
      break;
    }
  }
  if (!found) return { text: t("schedule.not_found", ctx.lang, { name }) };
  savePluginConfig(config);
  refreshRuntime(ctx);
  return { text: t("schedule.removed", ctx.lang, { name }) };
}
async function scheduleTest(parsed, ctx) {
  const name = parsed.args[2] ?? parsed.params.name;
  if (!name) return { text: t("schedule.missing_name", ctx.lang) };
  const result = await ctx.scheduler.triggerManual(name);
  return { text: `${t("schedule.triggered", ctx.lang, { name })}
${result}` };
}
function handleProfileCommand(parsed, ctx) {
  const action = parsed.args[0] ?? (Object.keys(parsed.params).length > 0 ? "set" : "status");
  switch (action) {
    case "status": {
      const profile = loadProfileConfig();
      const entries = Object.entries(profile).filter(([_, v]) => v !== void 0);
      if (entries.length === 0) {
        return { text: t("profile.empty", ctx.lang) };
      }
      const profileFields = entries.map(([k, v]) => ({
        name: k,
        value: String(v),
        inline: false
      }));
      return {
        embeds: [{
          title: "\uD504\uB85C\uD544",
          color: 5763719,
          fields: profileFields
        }]
      };
    }
    case "set":
    default: {
      const profile = loadProfileConfig();
      for (const [key, val] of Object.entries(parsed.params)) {
        ;
        profile[key.toLowerCase()] = val;
      }
      saveProfileConfig(profile);
      const lines = Object.entries(profile).filter(([_, v]) => v !== void 0).map(([k, v]) => `- **${k}**: ${v}`);
      return { text: t("profile.updated", ctx.lang) + "\n" + lines.join("\n") };
    }
  }
}
async function routeCustomCommand(text, ctx) {
  const parsed = parseCommand(text);
  if (!parsed) return null;
  return dispatchParsedCommand(parsed, ctx);
}
async function dispatchParsedCommand(parsed, ctx) {
  switch (parsed.cmd) {
    case "bot":
      return handleBotCommand(parsed, ctx);
    case "profile":
      return handleProfileCommand(parsed, ctx);
    default:
      return null;
  }
}
function runProfileCommand(args, params, ctx) {
  return handleProfileCommand(makeParsedCommand("profile", args, params), ctx);
}
async function runBotCommand(args, params, ctx) {
  return handleBotCommand(makeParsedCommand("bot", args, params), ctx);
}
export {
  handleBotCommand,
  handleProfileCommand,
  parseCommand,
  routeCustomCommand,
  runBotCommand,
  runProfileCommand
};
