// server.ts
import { Server as Server2 } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport as StdioServerTransport2 } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema as CallToolRequestSchema2, ListToolsRequestSchema as ListToolsRequestSchema2 } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync as readFileSync13 } from "fs";
import { join as join11, dirname as dirname4 } from "path";
import { fileURLToPath, pathToFileURL as pathToFileURL2 } from "url";

// src/channels/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { spawn as spawn5, execSync } from "child_process";
import * as fs from "fs";
import * as http2 from "http";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

// src/channels/lib/config.ts
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, mkdirSync as mkdirSync2 } from "fs";
import { join as join2 } from "path";

// src/channels/backends/discord.ts
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType
} from "discord.js";
import { randomBytes } from "crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  renameSync,
  realpathSync
} from "fs";
import { join, sep } from "path";

// src/channels/lib/format.ts
function getDisplayWidth(str) {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 4352 && code <= 4447 || code >= 11904 && code <= 12350 || code >= 12352 && code <= 13247 || code >= 13312 && code <= 19903 || code >= 19968 && code <= 40959 || code >= 44032 && code <= 55215 || code >= 63744 && code <= 64255 || code >= 65072 && code <= 65103 || code >= 65280 && code <= 65376 || code >= 65504 && code <= 65510 || code >= 131072 && code <= 195103 || code >= 127744 && code <= 129535) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}
function replaceEmojiInCodeBlock(text) {
  return text.replace(/\u2705/g, "[O]").replace(/\u274C/g, "[X]").replace(/\u2B55/g, "[O]").replace(/\uD83D\uDD34/g, "[X]");
}
function convertMarkdownTables(text) {
  const lines = text.split("\n");
  const result = [];
  let i = 0;
  while (i < lines.length) {
    if (i > 0 && /^\|[\s-:]+(\|[\s-:]+)+\|?\s*$/.test(lines[i])) {
      const headerIdx = i - 1;
      const headerLine = lines[headerIdx];
      if (!/\|/.test(headerLine)) {
        result.push(lines[i]);
        i++;
        continue;
      }
      const tableLines = [headerLine];
      let j = i + 1;
      while (j < lines.length && /^\|/.test(lines[j]) && !/^\|[\s-:]+(\|[\s-:]+)+\|?\s*$/.test(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }
      const parseCells = (line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const allRows = tableLines.map(parseCells);
      const colCount = allRows[0].length;
      const widths = [];
      for (let c = 0; c < colCount; c++) {
        let max = 2;
        for (const row of allRows) {
          const cellLen = row[c] ? getDisplayWidth(row[c]) : 0;
          if (cellLen > max) max = cellLen;
        }
        widths.push(max);
      }
      const padCell = (str, w) => {
        const visLen = getDisplayWidth(str || "");
        return (str || "") + " ".repeat(Math.max(0, w - visLen));
      };
      const outLines = [];
      outLines.push(allRows[0].map((c, ci) => padCell(c, widths[ci])).join("  "));
      outLines.push(widths.map((w) => "-".repeat(w)).join("  "));
      for (let r = 1; r < allRows.length; r++) {
        outLines.push(allRows[r].map((c, ci) => padCell(c, widths[ci])).join("  "));
      }
      const tableText = replaceEmojiInCodeBlock(outLines.join("\n"));
      result[headerIdx] = "```\n" + tableText + "\n```";
      i = j;
      continue;
    }
    result.push(lines[i]);
    i++;
  }
  return result.join("\n");
}
function escapeNestedCodeBlocks(text) {
  let fenceLen = 0;
  const lines = text.split("\n");
  return lines.map((line) => {
    const match = line.match(/^(`{3,})/);
    if (match) {
      if (fenceLen === 0) {
        fenceLen = match[1].length;
      } else if (match[1].length >= fenceLen) {
        fenceLen = 0;
      }
      return line;
    }
    if (fenceLen > 0 && line.includes("```")) {
      return line.replace(/```/g, "`\u200B``");
    }
    return line;
  }).join("\n");
}
function formatForDiscord(text) {
  return escapeNestedCodeBlocks(convertMarkdownTables(text));
}
function safeCodeBlock(content, lang = "") {
  const escaped = content.replace(/```/g, "`\u200B``");
  return "```" + lang + "\n" + escaped + "\n```";
}
function chunk(text, limit = 2e3) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = -1;
    const cbEnd1 = rest.lastIndexOf("\n```\n", limit);
    const cbEnd2 = rest.lastIndexOf("\n```", limit);
    if (cbEnd1 > limit / 2) {
      cut = cbEnd1 + 4;
    } else if (cbEnd2 > limit / 2) {
      cut = cbEnd2 + 4;
    }
    if (cut <= 0 || cut > limit) {
      const para = rest.lastIndexOf("\n\n", limit);
      const line = rest.lastIndexOf("\n", limit);
      const space = rest.lastIndexOf(" ", limit);
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    }
    let part = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n+/, "");
    const backtickCount = (part.match(/```/g) || []).length;
    if (backtickCount % 2 === 1) {
      const langMatch = part.match(/```(\w+)/);
      const lang = langMatch ? langMatch[1] : "";
      const closing = "\n```";
      if (part.length + closing.length > limit) {
        const overflow = part.length + closing.length - limit;
        const moved = part.slice(part.length - overflow);
        part = part.slice(0, part.length - overflow) + closing;
        rest = "```" + lang + "\n" + moved + rest;
      } else {
        part += closing;
        rest = "```" + lang + "\n" + rest;
      }
    }
    out.push(part);
  }
  if (rest) out.push(rest);
  return out;
}

// src/channels/lib/config-lock.ts
var pending = Promise.resolve();
function withConfigLock(fn) {
  const next = pending.then(() => fn());
  pending = next.then(() => {
  }, (e) => {
    process.stderr.write(`[config-lock] Error: ${e}
`);
  });
  return next;
}

// src/channels/backends/discord.ts
var MAX_CHUNK_LIMIT = 2e3;
var MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
var RECENT_SENT_CAP = 200;
function defaultAccess() {
  return {
    dmPolicy: "pairing",
    allowFrom: [],
    channels: {},
    pending: {}
  };
}
function normalizeAccess(parsed) {
  const defaults = defaultAccess();
  return {
    dmPolicy: parsed?.dmPolicy ?? defaults.dmPolicy,
    allowFrom: parsed?.allowFrom ?? defaults.allowFrom,
    channels: parsed?.channels ?? defaults.channels,
    pending: parsed?.pending ?? defaults.pending,
    mentionPatterns: parsed?.mentionPatterns,
    ackReaction: parsed?.ackReaction,
    replyToMode: parsed?.replyToMode,
    textChunkLimit: parsed?.textChunkLimit,
    chunkMode: parsed?.chunkMode
  };
}
function safeAttName(att) {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, "_");
}
var DiscordBackend = class {
  name = "discord";
  onMessage = null;
  onInteraction = null;
  onModalRequest = null;
  onCustomCommand = null;
  client;
  stateDir;
  configFile;
  approvedDir;
  inboxDir;
  token;
  isStatic;
  bootAccess = null;
  initialAccess;
  recentSentIds = /* @__PURE__ */ new Set();
  sendCount = 0;
  approvalTimer = null;
  typingIntervals = /* @__PURE__ */ new Map();
  constructor(config2, stateDir) {
    this.token = config2.token;
    this.stateDir = stateDir;
    this.configFile = config2.configPath ?? "";
    this.approvedDir = join(stateDir, "approved");
    this.inboxDir = join(stateDir, "inbox");
    this.isStatic = config2.accessMode === "static";
    this.initialAccess = normalizeAccess(config2.access);
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel]
    });
  }
  // ── Lifecycle ──────────────────────────────────────────────────────
  async connect() {
    if (this.isStatic) {
      const a = this.loadAccess();
      if (a.dmPolicy === "pairing") {
        process.stderr.write('trib-plugin discord: static mode \u2014 dmPolicy "pairing" downgraded to "allowlist"\n');
        a.dmPolicy = "allowlist";
      }
      a.pending = {};
      this.bootAccess = a;
    }
    this.client.on("error", (err) => {
      process.stderr.write(`trib-plugin discord: client error: ${err}
`);
    });
    this.client.on("messageCreate", (msg) => {
      if (msg.author.id === this.client.user?.id) {
        return;
      }
      if (msg.author.bot) return;
      this.handleInbound(msg).catch(
        (e) => process.stderr.write(`trib-plugin discord: handleInbound failed: ${e}
`)
      );
    });
    this.client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isChatInputCommand() && interaction.commandName === "stop") {
          await interaction.reply({ content: "\u23F9 Stopping...", ephemeral: true });
          if (this.onInteraction) {
            this.onInteraction({
              type: "button",
              customId: "stop_task",
              userId: interaction.user.id,
              channelId: interaction.channelId ?? ""
            });
          }
          return;
        }
        if (interaction.isModalSubmit()) {
          if (this.onInteraction) {
            const fields = {};
            for (const row of interaction.components) {
              for (const comp of row.components ?? []) {
                if (comp.customId && comp.value != null) fields[comp.customId] = String(comp.value);
              }
            }
            this.onInteraction({
              type: "modal",
              customId: interaction.customId,
              userId: interaction.user.id,
              channelId: interaction.channelId ?? "",
              fields,
              message: interaction.message ? { id: interaction.message.id } : void 0
            });
          }
          await interaction.deferUpdate().catch(() => {
          });
          return;
        }
        if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isUserSelectMenu() || interaction.isChannelSelectMenu()) {
          const needsModal = interaction.isButton() && (interaction.customId === "sched_add_next" || interaction.customId === "sched_edit_next" || interaction.customId === "quiet_set_next" || interaction.customId === "activity_add_next" || interaction.customId === "profile_edit");
          if (needsModal) {
            if (this.onModalRequest) {
              this.onModalRequest(interaction);
            }
            return;
          }
          await interaction.deferUpdate().catch(() => {
          });
          if (this.onInteraction) {
            this.onInteraction({
              type: interaction.isButton() ? "button" : "select",
              customId: interaction.customId,
              userId: interaction.user.id,
              channelId: interaction.channelId,
              values: interaction.isStringSelectMenu() ? interaction.values : void 0,
              message: interaction.message ? { id: interaction.message.id } : void 0
            });
          }
        }
      } catch (err) {
        process.stderr.write(`trib-plugin discord: interaction error: ${err}
`);
      }
    });
    this.client.on("ready", async (c) => {
      process.stderr.write(`trib-plugin discord: gateway connected as ${c.user.tag}
`);
      try {
        for (const [guildId] of c.guilds.cache) {
          await c.application?.commands.create({
            name: "stop",
            description: "Stop the current Claude Code response"
          }, guildId);
        }
        process.stderr.write(`trib-plugin discord: /stop command registered
`);
      } catch (err) {
        process.stderr.write(`trib-plugin discord: slash command registration failed: ${err}
`);
      }
    });
    this.client.on("shardDisconnect", (ev, id) => {
      process.stderr.write(`trib-plugin discord: shard ${id} disconnected (code ${ev.code}). Will auto-reconnect.
`);
    });
    this.client.on("shardReconnecting", (id) => {
      process.stderr.write(`trib-plugin discord: shard ${id} reconnecting...
`);
    });
    this.client.on("shardResume", (id, replayedEvents) => {
      process.stderr.write(`trib-plugin discord: shard ${id} resumed (replayed ${replayedEvents} events)
`);
    });
    this.client.on("warn", (msg) => {
      process.stderr.write(`trib-plugin discord: warn: ${msg}
`);
    });
    const readyPromise = new Promise((resolve3, reject) => {
      this.client.once("ready", () => resolve3());
      setTimeout(() => reject(new Error("discord ready timeout (30s)")), 3e4);
    });
    await this.client.login(this.token);
    await readyPromise;
    if (!this.isStatic) {
      this.approvalTimer = setInterval(() => this.checkApprovals(), 5e3);
    }
  }
  async disconnect() {
    if (this.approvalTimer) {
      clearInterval(this.approvalTimer);
      this.approvalTimer = null;
    }
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    this.client.destroy();
  }
  resetSendCount() {
    this.sendCount = 0;
  }
  startTyping(channelId) {
    this.stopTyping(channelId);
    const ch = this.client.channels.cache.get(channelId);
    if (ch && "sendTyping" in ch) {
      void ch.sendTyping().catch(() => {
      });
      const interval = setInterval(() => {
        if ("sendTyping" in ch) {
          ch.sendTyping().catch(() => {
          });
        }
      }, 9e3);
      this.typingIntervals.set(channelId, interval);
    }
  }
  stopTyping(channelId) {
    const interval = this.typingIntervals.get(channelId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(channelId);
    }
  }
  // ── Outbound operations ────────────────────────────────────────────
  async sendMessage(chatId, text, opts) {
    const ch = await this.fetchAllowedChannel(chatId);
    if (!("send" in ch)) throw new Error("channel is not sendable");
    const files = opts?.files ?? [];
    const replyTo = opts?.replyTo;
    for (const f of files) {
      this.assertSendable(f);
      const st = statSync(f);
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`);
      }
    }
    if (files.length > 10) throw new Error("max 10 attachments per message");
    if (text && this.sendCount > 0) {
      text = "\u3164\n" + text;
    }
    const access = this.loadAccess();
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT));
    const replyMode = access.replyToMode ?? "first";
    const chunks = chunk(text, limit);
    const sentIds = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        const shouldReplyTo = replyTo != null && replyMode !== "off" && (replyMode === "all" || i === 0);
        const embeds = i === 0 ? opts?.embeds ?? [] : [];
        const components = i === 0 ? opts?.components ?? [] : [];
        const sent = await ch.send({
          content: chunks[i],
          ...embeds.length > 0 ? { embeds } : {},
          ...components.length > 0 ? { components } : {},
          ...i === 0 && files.length > 0 ? { files } : {},
          ...shouldReplyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}
        });
        this.noteSent(sent.id);
        sentIds.push(sent.id);
      }
      this.sendCount += sentIds.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`send failed after ${sentIds.length}/${chunks.length} chunk(s): ${msg}`);
    }
    return { sentIds };
  }
  async fetchMessages(channelId, limit) {
    const ch = await this.fetchAllowedChannel(channelId);
    const capped = Math.min(limit, 100);
    const msgs = await ch.messages.fetch({ limit: capped });
    const me = this.client.user?.id;
    return [...msgs.values()].reverse().map((m) => ({
      id: m.id,
      user: m.author.id === me ? "me" : m.author.username,
      text: m.content.replace(/[\r\n]+/g, " \u23CE "),
      ts: m.createdAt.toISOString(),
      isMe: m.author.id === me,
      attachmentCount: m.attachments.size
    }));
  }
  async react(chatId, messageId, emoji) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    await msg.react(emoji);
  }
  async removeReaction(chatId, messageId, emoji) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    const me = this.client.user?.id;
    if (me) {
      const reaction = msg.reactions.cache.get(emoji);
      if (reaction) await reaction.users.remove(me);
    }
  }
  async editMessage(chatId, messageId, text, opts) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    const edited = await msg.edit({
      content: text || null,
      ...opts?.embeds ? { embeds: opts.embeds } : {},
      ...opts?.components ? { components: opts.components } : {}
    });
    return edited.id;
  }
  async deleteMessage(chatId, messageId) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    await msg.delete();
  }
  async downloadAttachment(chatId, messageId) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    if (msg.attachments.size === 0) return [];
    const results = [];
    for (const att of msg.attachments.values()) {
      const path2 = await this.downloadSingleAttachment(att);
      results.push({
        path: path2,
        name: safeAttName(att),
        contentType: att.contentType ?? "unknown",
        size: att.size
      });
    }
    return results;
  }
  async validateChannel(chatId) {
    await this.fetchAllowedChannel(chatId);
  }
  // ── Access control ─────────────────────────────────────────────────
  readConfigAccess() {
    try {
      if (!this.configFile) return this.initialAccess;
      const raw = readFileSync(this.configFile, "utf8");
      const parsed = JSON.parse(raw);
      return normalizeAccess(parsed.access ?? this.initialAccess);
    } catch {
      return this.initialAccess;
    }
  }
  loadAccess() {
    return this.bootAccess ?? this.readConfigAccess() ?? this.initialAccess;
  }
  saveAccess(a) {
    if (this.isStatic) return;
    if (!this.configFile) return;
    void withConfigLock(() => {
      mkdirSync(this.stateDir, { recursive: true, mode: 448 });
      const current = (() => {
        try {
          return JSON.parse(readFileSync(this.configFile, "utf8"));
        } catch {
          return {};
        }
      })();
      const next = {
        ...current,
        access: {
          dmPolicy: a.dmPolicy,
          allowFrom: a.allowFrom,
          channels: a.channels,
          pending: a.pending,
          ...a.mentionPatterns ? { mentionPatterns: a.mentionPatterns } : {},
          ...a.ackReaction ? { ackReaction: a.ackReaction } : {},
          ...a.replyToMode ? { replyToMode: a.replyToMode } : {},
          ...a.textChunkLimit ? { textChunkLimit: a.textChunkLimit } : {},
          ...a.chunkMode ? { chunkMode: a.chunkMode } : {}
        }
      };
      const tmp = this.configFile + ".tmp";
      writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 384 });
      renameSync(tmp, this.configFile);
    });
  }
  pruneExpired(a) {
    const now = Date.now();
    let changed = false;
    for (const [code, p] of Object.entries(a.pending)) {
      if (p.expiresAt < now) {
        delete a.pending[code];
        changed = true;
      }
    }
    return changed;
  }
  async gate(msg) {
    const access = this.loadAccess();
    if (this.pruneExpired(access)) this.saveAccess(access);
    if (access.dmPolicy === "disabled") return { action: "drop" };
    const senderId = msg.author.id;
    const isDM = msg.channel.type === ChannelType.DM;
    if (isDM) {
      if (access.allowFrom.includes(senderId)) return { action: "deliver", access };
      if (access.dmPolicy === "allowlist") return { action: "drop" };
      for (const [code2, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          if ((p.replies ?? 1) >= 2) return { action: "drop" };
          p.replies = (p.replies ?? 1) + 1;
          this.saveAccess(access);
          return { action: "pair", code: code2, isResend: true };
        }
      }
      if (Object.keys(access.pending).length >= 3) return { action: "drop" };
      const code = randomBytes(3).toString("hex");
      const now = Date.now();
      access.pending[code] = {
        senderId,
        chatId: msg.channelId,
        createdAt: now,
        expiresAt: now + 60 * 60 * 1e3,
        replies: 1
      };
      this.saveAccess(access);
      return { action: "pair", code, isResend: false };
    }
    const channelId = msg.channel.isThread() ? msg.channel.parentId ?? msg.channelId : msg.channelId;
    const policy = access.channels[channelId];
    if (!policy) return { action: "drop" };
    const channelAllowFrom = policy.allowFrom ?? [];
    const requireMention = policy.requireMention ?? true;
    if (channelAllowFrom.length > 0 && !channelAllowFrom.includes(senderId)) {
      return { action: "drop" };
    }
    if (requireMention && !await this.isMentioned(msg, access.mentionPatterns)) {
      return { action: "drop" };
    }
    return { action: "deliver", access };
  }
  async isMentioned(msg, extraPatterns) {
    if (this.client.user && msg.mentions.has(this.client.user)) return true;
    const refId = msg.reference?.messageId;
    if (refId) {
      if (this.recentSentIds.has(refId)) return true;
      try {
        const ref = await msg.fetchReference();
        if (ref.author.id === this.client.user?.id) return true;
      } catch {
      }
    }
    const text = msg.content;
    for (const pat of extraPatterns ?? []) {
      try {
        if (new RegExp(pat, "i").test(text)) return true;
      } catch {
      }
    }
    return false;
  }
  // ── Inbound handling ───────────────────────────────────────────────
  async handleInbound(msg) {
    const result = await this.gate(msg);
    if (result.action === "drop") return;
    if (result.action === "pair") {
      const lead = result.isResend ? "Still pending" : "Pairing required";
      try {
        await msg.reply(`${lead} \u2014 run in Claude Code:

/discord:access pair ${result.code}`);
      } catch (err) {
        process.stderr.write(`trib-plugin discord: failed to send pairing code: ${err}
`);
      }
      return;
    }
    if (result.access.ackReaction) {
      void msg.react(result.access.ackReaction).catch(() => {
      });
    }
    const atts = [];
    for (const att of msg.attachments.values()) {
      atts.push({
        name: safeAttName(att),
        contentType: att.contentType ?? "unknown",
        size: att.size
      });
    }
    const text = msg.content || (atts.length > 0 ? "(attachment)" : "");
    if (text.match(/^\/(bot|profile)\s*\(/) && this.onCustomCommand) {
      const replyFn = async (reply, opts) => {
        try {
          const ch = await this.fetchAllowedChannel(msg.channelId);
          if ("send" in ch) {
            await ch.send({
              ...reply ? { content: reply } : {},
              ...opts?.embeds?.length ? { embeds: opts.embeds } : {},
              ...opts?.components?.length ? { components: opts.components } : {}
            });
          }
        } catch (err) {
          process.stderr.write(`trib-plugin discord: custom command reply failed: ${err}
`);
        }
      };
      this.onCustomCommand(text, msg.channelId, msg.author.id, replyFn);
      return;
    }
    if (this.onMessage) {
      this.onMessage({
        chatId: msg.channelId,
        messageId: msg.id,
        user: msg.author.username,
        userId: msg.author.id,
        text,
        ts: msg.createdAt.toISOString(),
        attachments: atts
      });
    }
  }
  // ── Approval polling ───────────────────────────────────────────────
  checkApprovals() {
    let files;
    try {
      files = readdirSync(this.approvedDir);
    } catch {
      return;
    }
    if (files.length === 0) return;
    for (const senderId of files) {
      const file = join(this.approvedDir, senderId);
      let dmChannelId;
      try {
        dmChannelId = readFileSync(file, "utf8").trim();
      } catch {
        rmSync(file, { force: true });
        continue;
      }
      if (!dmChannelId) {
        rmSync(file, { force: true });
        continue;
      }
      void (async () => {
        try {
          const ch = await this.fetchTextChannel(dmChannelId);
          if ("send" in ch) {
            await ch.send("Paired! Say hi to Claude.");
          }
          rmSync(file, { force: true });
        } catch (err) {
          process.stderr.write(`trib-plugin discord: approval confirm failed: ${err}
`);
          rmSync(file, { force: true });
        }
      })();
    }
  }
  // ── Channel helpers ────────────────────────────────────────────────
  async fetchTextChannel(id) {
    const ch = await this.client.channels.fetch(id);
    if (!ch || !ch.isTextBased()) {
      throw new Error(`channel ${id} not found or not text-based`);
    }
    return ch;
  }
  async fetchAllowedChannel(id) {
    const ch = await this.fetchTextChannel(id);
    const access = this.loadAccess();
    if (ch.type === ChannelType.DM) {
      let recipientId = ch.recipientId;
      if (!recipientId && ch.partial) {
        const fetched = await ch.fetch();
        recipientId = fetched.recipientId;
      }
      if (recipientId && access.allowFrom.includes(recipientId)) return ch;
    } else {
      const key = ch.isThread() ? ch.parentId ?? ch.id : ch.id;
      if (key in access.channels) return ch;
    }
    throw new Error(`channel ${id} is not allowlisted \u2014 add via /discord:access`);
  }
  noteSent(id) {
    this.recentSentIds.add(id);
    if (this.recentSentIds.size > RECENT_SENT_CAP) {
      const first = this.recentSentIds.values().next().value;
      if (first) this.recentSentIds.delete(first);
    }
  }
  assertSendable(f) {
    let real, stateReal;
    try {
      real = realpathSync(f);
      stateReal = realpathSync(this.stateDir);
    } catch {
      return;
    }
    const inbox = join(stateReal, "inbox");
    if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${f}`);
    }
  }
  async downloadSingleAttachment(att) {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`
      );
    }
    const res = await fetch(att.url);
    if (!res.ok) {
      throw new Error(`attachment download failed: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const name = att.name ?? `${att.id}`;
    const rawExt = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "bin";
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "") || "bin";
    const path2 = join(this.inboxDir, `${Date.now()}-${att.id}.${ext}`);
    mkdirSync(this.inboxDir, { recursive: true });
    writeFileSync(path2, buf);
    return path2;
  }
};

// src/channels/lib/config.ts
if (!process.env.CLAUDE_PLUGIN_DATA) {
  process.stderr.write(
    "trib-plugin: CLAUDE_PLUGIN_DATA not set.\n  This plugin must be run through Claude Code.\n"
  );
  process.exit(1);
}
var DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
var PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? new URL("..", import.meta.url).pathname;
var CONFIG_FILE = join2(DATA_DIR, "config.json");
var DEFAULT_ACCESS = {
  dmPolicy: "pairing",
  allowFrom: [],
  channels: {}
};
var DEFAULT_CONFIG = {
  backend: "discord",
  discord: { token: "" },
  access: DEFAULT_ACCESS,
  channelsConfig: {
    main: "general",
    channels: {
      general: { id: "", mode: "interactive" }
    }
  }
};
function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync2(CONFIG_FILE, "utf8"));
    const items = raw.schedules?.items;
    if (items && Array.isArray(items)) {
      if (!raw.nonInteractive) {
        raw.nonInteractive = items.filter(
          (i) => i.type === "nonInteractive" || i.type === "non-interactive"
        );
      }
      if (!raw.interactive) {
        raw.interactive = items.filter((i) => i.type === "interactive");
      }
    }
    const accessChannels = { ...raw.access?.channels ?? {} };
    const chCfg = raw.channelsConfig;
    if (chCfg) {
      for (const entry of Object.values(chCfg)) {
        const id = entry?.channelId ?? entry?.id;
        if (typeof id === "string" && id && !(id in accessChannels)) {
          accessChannels[id] = {};
        }
      }
      if (chCfg.channels) {
        for (const entry of Object.values(chCfg.channels)) {
          const id = entry?.id;
          if (typeof id === "string" && id && !(id in accessChannels)) {
            accessChannels[id] = {};
          }
        }
      }
    }
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      backend: "discord",
      discord: { ...DEFAULT_CONFIG.discord, ...raw.discord },
      access: {
        ...DEFAULT_ACCESS,
        ...raw.access,
        channels: accessChannels,
        pending: raw.access?.pending ?? {}
      }
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      mkdirSync2(DATA_DIR, { recursive: true });
      writeFileSync2(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
      process.stderr.write(
        `trib-plugin: default config created at ${CONFIG_FILE}
  edit discord.token and channelsConfig.channels.general.id to connect.
`
      );
      return DEFAULT_CONFIG;
    }
    throw err;
  }
}
var HEADLESS_BACKEND = {
  name: "headless",
  async connect() {
  },
  async disconnect() {
  },
  async sendMessage() {
    return { ids: [] };
  },
  async fetchMessages() {
    return [];
  },
  async react() {
  },
  async removeReaction() {
  },
  async editMessage() {
    return "";
  },
  async deleteMessage() {
  },
  async downloadAttachment() {
    return Buffer.alloc(0);
  },
  on() {
  }
};
function createBackend(config2) {
  if (config2.backend !== "discord" || !config2.discord?.token) {
    process.stderr.write("trib-plugin: discord not configured, running in headless mode\n");
    return HEADLESS_BACKEND;
  }
  const stateDir = config2.discord.stateDir ?? join2(DATA_DIR, "discord");
  mkdirSync2(stateDir, { recursive: true });
  return new DiscordBackend({
    ...config2.discord,
    configPath: CONFIG_FILE,
    access: config2.access
  }, stateDir);
}
var BOT_FILE = join2(DATA_DIR, "bot.json");
function loadBotConfig() {
  try {
    return JSON.parse(readFileSync2(BOT_FILE, "utf8"));
  } catch {
    return {};
  }
}
var PROFILE_FILE = join2(DATA_DIR, "profile.json");
function loadProfileConfig() {
  try {
    return JSON.parse(readFileSync2(PROFILE_FILE, "utf8"));
  } catch {
    return {};
  }
}

// src/channels/lib/settings.ts
import { readFileSync as readFileSync3 } from "fs";
function tryRead(path2) {
  try {
    return readFileSync3(path2, "utf8").trim();
  } catch {
    return null;
  }
}

// src/channels/lib/scheduler.ts
import { readFileSync as readFileSync5, writeFileSync as writeFileSync4, unlinkSync, existsSync as existsSync3 } from "fs";
import { join as join5, isAbsolute } from "path";
import { tmpdir as tmpdir2 } from "os";
import { randomUUID } from "crypto";
import { appendFileSync as appendFileSync2 } from "fs";
import { spawn as spawn3 } from "child_process";

// src/channels/lib/executor.ts
import { spawn as spawn2 } from "child_process";
import { existsSync, mkdirSync as mkdirSync3, appendFileSync } from "fs";
import { join as join3, normalize, extname } from "path";
import { tmpdir } from "os";

// src/channels/lib/cli-worker-host.ts
import { spawn } from "child_process";
function startCliWorker(_options) {
}
async function stopCliWorker() {
}
function runCliWorkerTask(task) {
  return new Promise((resolve3, reject) => {
    const command = String(task.command ?? "").trim();
    const args = Array.isArray(task.args) ? task.args.map(String) : [];
    const timeoutMs = Math.max(1e3, Number(task.timeout ?? 12e4));
    const isWin = process.platform === "win32";
    const safeArgs = isWin ? args.map((a) => /\s/.test(a) ? `"${a}"` : a) : args;
    const child = spawn(command, safeArgs, {
      cwd: task.cwd ?? process.cwd(),
      env: { ...process.env, ...task.env ?? {} },
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWin
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill("SIGTERM");
      } catch {
      }
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`spawn ${command} failed: ${err.message}`));
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve3({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
    const stdin = task.stdin;
    if (stdin != null) {
      child.stdin.write(String(stdin));
    }
    child.stdin.end();
  });
}

// src/channels/lib/executor.ts
var SCRIPTS_DIR = join3(DATA_DIR, "scripts");
var NOPLUGIN_DIR = join3(tmpdir(), "trib-plugin-noplugin");
var EVENT_LOG = join3(DATA_DIR, "event.log");
function logEvent(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  try {
    process.stderr.write(`trib-plugin event: ${msg}
`);
  } catch {
  }
  try {
    appendFileSync(EVENT_LOG, line);
  } catch {
  }
}
function parseGithub(body, headers) {
  const event = headers["x-github-event"] || "";
  const action = body.action || "";
  const pr = body.pull_request || body.issue || {};
  return {
    event,
    action,
    title: pr.title || body.head_commit?.message || "",
    author: pr.user?.login || body.sender?.login || "",
    repo: body.repository?.full_name || "",
    url: pr.html_url || body.compare || "",
    branch: body.ref || pr.head?.ref || "",
    message: body.head_commit?.message || ""
  };
}
function parseSentry(body) {
  const data = body.data || {};
  const evt = data.event || data.issue || {};
  return {
    title: evt.title || body.message || "",
    level: evt.level || body.level || "",
    project: body.project_name || body.project || "",
    url: evt.web_url || body.url || ""
  };
}
function parseGeneric(body) {
  const result = {};
  const keys = Object.keys(body).slice(0, 5);
  for (const k of keys) {
    result[k] = typeof body[k] === "string" ? body[k] : JSON.stringify(body[k]);
  }
  return result;
}
function applyParser(parser, body, headers) {
  switch (parser) {
    case "github":
      return parseGithub(body, headers);
    case "sentry":
      return parseSentry(body);
    case "generic":
      return parseGeneric(body);
    default:
      return { raw: JSON.stringify(body) };
  }
}
function evaluateFilter(expr, data) {
  const orParts = expr.split("||").map((s) => s.trim());
  for (const orPart of orParts) {
    const andParts = orPart.split("&&").map((s) => s.trim());
    let andResult = true;
    for (const condition of andParts) {
      const match = condition.match(/^(\w+)\s*==\s*['"](.*)['"]$/);
      if (!match) {
        const neqMatch = condition.match(/^(\w+)\s*!=\s*['"](.*)['"]$/);
        if (neqMatch) {
          const [, field2, value2] = neqMatch;
          if ((data[field2] ?? "") === value2) {
            andResult = false;
            break;
          }
        } else {
          andResult = false;
          break;
        }
        continue;
      }
      const [, field, value] = match;
      if ((data[field] ?? "") !== value) {
        andResult = false;
        break;
      }
    }
    if (andResult) return true;
  }
  return false;
}
function applyTemplate(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? "");
}
function ensureNopluginDir() {
  mkdirSync3(NOPLUGIN_DIR, { recursive: true });
}
function spawnClaudeP(name, prompt, onResult) {
  ensureNopluginDir();
  logEvent(`${name}: dispatching to cli worker`);
  const wrappedPrompt = prompt + "\n\nIMPORTANT: Output your final result as plain text to stdout. Do NOT use any reply, messaging, or channel tools. Just print the result.";
  const args = [
    "-p",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--plugin-dir",
    NOPLUGIN_DIR
  ];
  void runCliWorkerTask({
    command: "claude",
    args,
    stdin: wrappedPrompt,
    timeout: 12e4,
    env: { ...process.env, TRIB_CHANNELS_NO_CONNECT: "1" }
  }).then((result) => {
    const lines = result.stdout.trim().split("\n");
    const text = lines.slice(-30).join("\n").substring(0, 1900);
    logEvent(`${name}: cli worker completed (${result.code})`);
    onResult(text, result.code);
  }).catch((err) => {
    logEvent(`${name}: cli worker error: ${err.message}`);
    onResult("", null);
  });
}
function runScript(name, scriptName, onResult) {
  if (!existsSync(SCRIPTS_DIR)) {
    mkdirSync3(SCRIPTS_DIR, { recursive: true });
  }
  const scriptPath = normalize(join3(SCRIPTS_DIR, scriptName));
  if (!scriptPath.startsWith(SCRIPTS_DIR)) {
    logEvent(`${name}: script path escapes directory: ${scriptName}`);
    onResult("", null);
    return;
  }
  if (!existsSync(scriptPath)) {
    logEvent(`${name}: script not found: ${scriptPath}`);
    onResult("", null);
    return;
  }
  const ext = extname(scriptName).toLowerCase();
  const cmd = ext === ".py" ? "python3" : "node";
  const proc = spawn2(cmd, [scriptPath], {
    timeout: 3e4,
    env: { ...process.env }
  });
  let stdout = "";
  let stderr = "";
  if (proc.stdout) proc.stdout.on("data", (d) => {
    stdout += d;
  });
  if (proc.stderr) proc.stderr.on("data", (d) => {
    stderr += d;
  });
  proc.on("close", (code) => {
    if (code !== 0) {
      logEvent(`${name}: script exited ${code}: ${stderr.substring(0, 500)}`);
    }
    onResult(stdout.substring(0, 2e3), code);
  });
  proc.on("error", (err) => {
    logEvent(`${name}: script spawn error: ${err.message}`);
    onResult("", null);
  });
}

// src/channels/lib/holidays.ts
import { readFileSync as readFileSync4, writeFileSync as writeFileSync3, existsSync as existsSync2 } from "fs";
import { join as join4 } from "path";
import { homedir } from "os";
var CACHE_FILE = join4(DATA_DIR, "holidays-cache.json");
var FALLBACK_FILE = join4(homedir(), ".claude", "schedules", "holidays.json");
var CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
async function fetchHolidays(year, countryCode) {
  const url = `https://date.nager.at/api/v3/publicholidays/${year}/${countryCode}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nager API ${res.status}: ${res.statusText}`);
  return res.json();
}
function loadCache(year, countryCode) {
  try {
    if (!existsSync2(CACHE_FILE)) return null;
    const cache = JSON.parse(readFileSync4(CACHE_FILE, "utf8"));
    if (cache.year !== year || cache.countryCode !== countryCode) return null;
    if (Date.now() - cache.fetchedAt > CACHE_MAX_AGE_MS) return null;
    return cache.holidays;
  } catch {
    return null;
  }
}
function saveCache(year, countryCode, holidays) {
  const cache = { year, countryCode, fetchedAt: Date.now(), holidays };
  try {
    writeFileSync3(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
  }
}
function loadFallback() {
  try {
    if (!existsSync2(FALLBACK_FILE)) return /* @__PURE__ */ new Set();
    const data = JSON.parse(readFileSync4(FALLBACK_FILE, "utf8"));
    const dates = data.holidays ?? [];
    return new Set(dates);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
async function isHoliday(date, countryCode) {
  const year = date.getFullYear();
  const dateStr = `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  let holidays = loadCache(year, countryCode);
  if (!holidays) {
    try {
      holidays = await fetchHolidays(year, countryCode);
      saveCache(year, countryCode, holidays);
    } catch (err) {
      process.stderr.write(`trib-plugin holidays: API fetch failed: ${err}
`);
      holidays = null;
    }
  }
  if (holidays) {
    return holidays.some((h) => h.date === dateStr);
  }
  const fallback = loadFallback();
  return fallback.has(dateStr);
}

// src/channels/lib/scheduler.ts
var DELEGATE_CLI = join5(PLUGIN_ROOT, "scripts", "delegate-cli.mjs");
var SCHEDULE_LOG = join5(DATA_DIR, "schedule.log");
function logSchedule(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  process.stderr.write(`trib-plugin scheduler: ${msg}
`);
  try {
    appendFileSync2(SCHEDULE_LOG, line);
  } catch {
  }
}
var TICK_INTERVAL = 6e4;
var FREQUENCY_MAP = {
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
var Scheduler = class _Scheduler {
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
  constructor(nonInteractive, interactive, proactive, channelsConfig, botConfig2) {
    this.nonInteractive = nonInteractive.filter((s) => s.enabled !== false);
    this.interactive = interactive.filter((s) => s.enabled !== false);
    this.proactive = proactive ?? null;
    this.channelsConfig = channelsConfig ?? null;
    this.promptsDir = join5(DATA_DIR, "prompts");
    const hol = botConfig2?.quiet?.holidays;
    if (hol === true) {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
      this.holidayCountry = locale.split("-")[1] || locale.toUpperCase().slice(0, 2);
    } else if (typeof hol === "string" && hol) {
      this.holidayCountry = hol;
    } else {
      this.holidayCountry = null;
    }
    this.quietSchedule = botConfig2?.quiet?.schedule ?? null;
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
  static SCHEDULER_LOCK = join5(tmpdir2(), "trib-plugin-scheduler.lock");
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
${_Scheduler.INSTANCE_UUID}`;
    try {
      writeFileSync4(_Scheduler.SCHEDULER_LOCK, lockContent, { flag: "wx" });
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const content = readFileSync5(_Scheduler.SCHEDULER_LOCK, "utf8");
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
            if (lockAge > 60 * 60 * 1e3 && lockUuid !== _Scheduler.INSTANCE_UUID) {
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
        writeFileSync4(_Scheduler.SCHEDULER_LOCK, lockContent);
      } else {
        throw err;
      }
    }
    process.on("exit", () => {
      try {
        unlinkSync(_Scheduler.SCHEDULER_LOCK);
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
      unlinkSync(_Scheduler.SCHEDULER_LOCK);
    } catch {
    }
    this.start();
  }
  reloadConfig(nonInteractive, interactive, proactive, channelsConfig, botConfig2, options = {}) {
    this.nonInteractive = nonInteractive.filter((s) => s.enabled !== false);
    this.interactive = interactive.filter((s) => s.enabled !== false);
    this.proactive = proactive ?? null;
    this.channelsConfig = channelsConfig ?? null;
    this.promptsDir = join5(DATA_DIR, "prompts");
    const hol2 = botConfig2?.quiet?.holidays;
    if (hol2 === true) {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
      this.holidayCountry = locale.split("-")[1] || locale.toUpperCase().slice(0, 2);
    } else if (typeof hol2 === "string" && hol2) {
      this.holidayCountry = hol2;
    } else {
      this.holidayCountry = null;
    }
    this.quietSchedule = botConfig2?.quiet?.schedule ?? null;
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
    return dayList.some((d) => _Scheduler.DAY_ABBRS[d] === dow);
  }
  /** Check if current time is within global quiet hours (quiet.schedule) */
  isQuietHours(now) {
    if (!this.quietSchedule) return false;
    const parts = this.quietSchedule.split("-");
    if (parts.length !== 2) return false;
    const [start2, end] = parts;
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (start2 > end) return hhmm >= start2 || hhmm < end;
    return hhmm >= start2 && hhmm < end;
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
    const start2 = 420;
    const end = 1320;
    const slots = /* @__PURE__ */ new Set();
    for (let i = 0; i < daily; i++) {
      slots.add(start2 + Math.floor(Math.random() * (end - start2)));
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
    if (existsSync3(DELEGATE_CLI)) {
      const args = [DELEGATE_CLI];
      if (this.proactive?.model) args.push("--preset", this.proactive.model);
      args.push(prompt);
      const child = spawn3("node", args, {
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
    return new Promise((resolve3, reject) => {
      runScript(`schedule:${scriptName}`, scriptName, (result, code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`script exited with code ${code}`));
        } else {
          resolve3(result);
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
    if (!existsSync3(DELEGATE_CLI)) {
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
    const child = spawn3("node", args, {
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
        const logPath = join5(DATA_DIR, "proactive.log");
        try {
          appendFileSync2(logPath, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${result.log}
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
    const full = isAbsolute(nameOrPath) ? nameOrPath : join5(this.promptsDir, nameOrPath);
    return tryRead(full);
  }
};

// src/channels/lib/webhook.ts
import * as http from "http";
import * as crypto from "crypto";
import { join as join6 } from "path";
import { spawn as spawn4, spawnSync } from "child_process";
import { appendFileSync as appendFileSync3, readFileSync as readFileSync6, writeFileSync as writeFileSync5, unlinkSync as unlinkSync2, statSync as statSync2, existsSync as existsSync4 } from "fs";
var WEBHOOKS_DIR = join6(DATA_DIR, "webhooks");
var DELEGATE_CLI2 = join6(PLUGIN_ROOT, "scripts", "delegate-cli.mjs");
var WEBHOOK_LOG = join6(DATA_DIR, "webhook.log");
function logWebhook(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  try {
    process.stderr.write(`trib-plugin webhook: ${msg}
`);
  } catch {
  }
  try {
    appendFileSync3(WEBHOOK_LOG, line);
  } catch {
  }
}
var SIGNATURE_HEADERS = {
  github: { header: "x-hub-signature-256", prefix: "sha256=" },
  sentry: { header: "sentry-hook-signature", prefix: "" },
  stripe: { header: "stripe-signature", prefix: "" },
  generic: { header: "x-signature-256", prefix: "sha256=" }
};
function extractSignature(headers, parser) {
  if (parser) {
    const mapping = SIGNATURE_HEADERS[parser];
    if (mapping) {
      const raw = headers[mapping.header];
      if (raw) return mapping.prefix ? raw.replace(mapping.prefix, "") : raw;
    }
  }
  for (const mapping of Object.values(SIGNATURE_HEADERS)) {
    const raw = headers[mapping.header];
    if (raw) return mapping.prefix ? raw.replace(mapping.prefix, "") : raw;
  }
  return null;
}
function verifySignature(secret, rawBody, signatureValue, parser) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (parser === "stripe") {
    const match = signatureValue.match(/v1=([a-f0-9]+)/);
    if (!match) return false;
    return crypto.timingSafeEqual(Buffer.from(match[1], "hex"), Buffer.from(expected, "hex"));
  }
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureValue, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}
function resolveNgrokBin() {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "where" : "which";
  const target = isWin ? "ngrok.exe" : "ngrok";
  try {
    const r = spawnSync(cmd, [target], { encoding: "utf8", windowsHide: true, timeout: 5e3 });
    const resolved = (r.stdout || "").trim().split(/\r?\n/)[0];
    if (r.status === 0 && resolved) return resolved;
  } catch {
  }
  return null;
}
var NGROK_PID_FILE = join6(DATA_DIR, "ngrok.pid");
var WebhookServer = class {
  config;
  server = null;
  eventPipeline = null;
  boundPort = 0;
  noSecretWarned = false;
  ngrokProcess = null;
  ngrokStarting = false;
  constructor(config2, _channelsConfig) {
    this.config = config2;
  }
  setEventPipeline(pipeline) {
    this.eventPipeline = pipeline;
  }
  // ── HTTP server ───────────────────────────────────────────────────
  start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/webhook/")) {
        const name = req.url.slice("/webhook/".length).split("?")[0];
        let body = "";
        req.on("data", (chunk2) => {
          body += chunk2;
        });
        req.on("end", () => {
          try {
            const headers = {};
            for (const [k, v] of Object.entries(req.headers)) {
              if (typeof v === "string") headers[k.toLowerCase()] = v;
            }
            const secret = this.config.secret;
            if (secret) {
              const endpoint = this.config.endpoints?.[name];
              const signature = extractSignature(headers, endpoint?.parser);
              if (!signature) {
                logWebhook(`${name}: rejected \u2014 no signature header found`);
                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "missing signature" }));
                return;
              }
              if (!verifySignature(secret, body, signature, endpoint?.parser)) {
                logWebhook(`${name}: rejected \u2014 signature mismatch`);
                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "invalid signature" }));
                return;
              }
            } else {
              if (!this.noSecretWarned) {
                this.noSecretWarned = true;
                logWebhook(`warning \u2014 no webhook secret configured, skipping signature verification`);
              }
            }
            const parsed = body ? JSON.parse(body) : {};
            this.handleWebhook(name, parsed, headers, res);
          } catch (err) {
            logWebhook(`JSON parse error for ${name}: ${err}`);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid JSON" }));
          }
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });
    const basePort = this.config.port || 3333;
    const maxPort = basePort + 7;
    let currentPort = basePort;
    const tryListen = () => {
      this.server.listen(currentPort, () => {
        this.boundPort = currentPort;
        logWebhook(`listening on port ${currentPort}`);
      });
    };
    this.server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && currentPort < maxPort) {
        logWebhook(`port ${currentPort} already in use, trying ${currentPort + 1}`);
        currentPort++;
        tryListen();
      } else if (err.code === "EADDRINUSE") {
        logWebhook(`all ports ${basePort}-${maxPort} in use \u2014 webhook server disabled`);
        this.server = null;
      }
    });
    tryListen();
    this.startNgrok();
  }
  /** Kill any previous ngrok process left behind from a crashed session */
  killPreviousNgrok() {
    try {
      const pidContent = readFileSync6(NGROK_PID_FILE, "utf8").trim();
      const pid = parseInt(pidContent);
      if (pid > 0) {
        try {
          const age = Date.now() - statSync2(NGROK_PID_FILE).mtimeMs;
          if (age > 60 * 60 * 1e3) {
            logWebhook(`ngrok PID file stale (${Math.round(age / 6e4)}m old), removing without kill`);
            try {
              unlinkSync2(NGROK_PID_FILE);
            } catch {
            }
            return;
          }
        } catch {
        }
        try {
          process.kill(pid, 0);
          process.kill(pid);
          logWebhook(`killed previous ngrok (PID ${pid})`);
        } catch {
        }
      }
    } catch {
    }
    try {
      unlinkSync2(NGROK_PID_FILE);
    } catch {
    }
  }
  startNgrok() {
    if (this.ngrokProcess || this.ngrokStarting) return;
    const authtoken = this.config.authtoken;
    const domain = this.config.ngrokDomain || this.config.domain;
    if (!authtoken || !domain) return;
    this.ngrokStarting = true;
    this.killPreviousNgrok();
    const ngrokBin = resolveNgrokBin();
    if (!ngrokBin) {
      logWebhook("ngrok binary not found \u2014 webhook tunnel disabled");
      this.ngrokStarting = false;
      return;
    }
    spawnSync(ngrokBin, ["config", "add-authtoken", authtoken], { stdio: "ignore", timeout: 1e4, windowsHide: true });
    let attempts = 0;
    const waitAndStart = () => {
      if (!this.boundPort) {
        if (++attempts > 30) {
          logWebhook("ngrok: gave up waiting for port");
          this.ngrokStarting = false;
          return;
        }
        setTimeout(waitAndStart, 500);
        return;
      }
      try {
        this.ngrokProcess = spawn4(ngrokBin, ["http", String(this.boundPort), "--url=" + domain], {
          stdio: "ignore",
          windowsHide: true
        });
        this.ngrokProcess.unref();
        if (this.ngrokProcess.pid) {
          try {
            writeFileSync5(NGROK_PID_FILE, String(this.ngrokProcess.pid));
          } catch {
          }
        }
        this.ngrokProcess.on("exit", () => {
          this.ngrokProcess = null;
          this.ngrokStarting = false;
          try {
            unlinkSync2(NGROK_PID_FILE);
          } catch {
          }
        });
        this.ngrokProcess.on("error", () => {
          this.ngrokProcess = null;
          this.ngrokStarting = false;
          try {
            unlinkSync2(NGROK_PID_FILE);
          } catch {
          }
        });
        logWebhook(`ngrok tunnel started: ${domain} \u2192 localhost:${this.boundPort} (PID ${this.ngrokProcess.pid})`);
      } catch (e) {
        logWebhook(`ngrok start failed: ${e}`);
      }
      this.ngrokStarting = false;
    };
    setTimeout(waitAndStart, 1e3);
  }
  stop() {
    if (this.ngrokProcess) {
      try {
        this.ngrokProcess.kill();
      } catch {
      }
      this.ngrokProcess = null;
      try {
        unlinkSync2(NGROK_PID_FILE);
      } catch {
      }
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    logWebhook("stopped");
  }
  reloadConfig(config2, _channelsConfig, options = {}) {
    this.stop();
    this.config = config2;
    if (options.autoStart !== false && config2.enabled) this.start();
  }
  // ── Delegate analysis via trib-agent ────────────────────────────────
  delegateAnalysis(name, prompt, model, channel, exec) {
    const args = [];
    if (model) args.push("--preset", model);
    args.push(prompt);
    const child = spawn4("node", [DELEGATE_CLI2, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 12e4,
      env: { ...process.env }
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (d) => {
      stdout += d;
    });
    if (child.stderr) child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      let result = "";
      try {
        const parsed = JSON.parse(stdout);
        result = parsed.content || stdout.trim();
      } catch {
        result = stdout.trim();
      }
      if (!result) {
        logWebhook(`${name}: delegate returned empty (code=${code}, stderr=${stderr.slice(0, 200)})`);
        return;
      }
      logWebhook(`${name}: delegate done (${model}, ${result.length} chars)`);
      if (this.eventPipeline) {
        this.eventPipeline.enqueueDirect(name, result, channel, exec);
      }
    });
    child.on("error", (err) => {
      logWebhook(`${name}: delegate spawn error: ${err.message}`);
    });
  }
  // ── Webhook handler ───────────────────────────────────────────────
  handleWebhook(name, body, headers, res) {
    const folderPath = join6(WEBHOOKS_DIR, name);
    const instructionsPath = join6(folderPath, "instructions.md");
    if (existsSync4(instructionsPath)) {
      try {
        const instructions = readFileSync6(instructionsPath, "utf8").trim();
        let channel = "main";
        let exec = "interactive";
        let model = null;
        let analyze = false;
        const configPath = join6(folderPath, "config.json");
        if (existsSync4(configPath)) {
          try {
            const cfg = JSON.parse(readFileSync6(configPath, "utf8"));
            if (cfg.channel) channel = cfg.channel;
            if (cfg.exec) exec = cfg.exec;
            if (cfg.model) model = cfg.model;
            if (cfg.analyze === true) analyze = true;
          } catch {
          }
        }
        const payload = JSON.stringify(body, null, 2);
        const headersSummary = Object.entries(headers).filter(([k]) => k.startsWith("x-") || k === "content-type").map(([k, v]) => `${k}: ${v}`).join("\n");
        const prompt = `${instructions}

--- Webhook Headers ---
${headersSummary}

--- Webhook Payload ---
${payload}`;
        if (analyze && existsSync4(DELEGATE_CLI2)) {
          this.delegateAnalysis(name, prompt, model, channel, exec);
          logWebhook(`${name}: folder-based \u2192 delegate (${model})`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "accepted", handler: "delegate" }));
          return;
        }
        if (this.eventPipeline) {
          this.eventPipeline.enqueueDirect(name, prompt, channel, exec);
          logWebhook(`${name}: folder-based \u2192 enqueued (${exec})`);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "accepted", handler: "folder" }));
        return;
      } catch (err) {
        logWebhook(`${name}: folder handler error: ${err}`);
      }
    }
    if (this.eventPipeline?.handleWebhook(name, body, headers)) {
      logWebhook(`${name}: routed to event pipeline`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "accepted" }));
      return;
    }
    logWebhook(`unknown endpoint: ${name}`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unknown endpoint" }));
  }
  /** Get the webhook URL for an endpoint name */
  getUrl(name) {
    if (this.config.ngrokDomain) {
      return `https://${this.config.ngrokDomain}/webhook/${name}`;
    }
    return `http://localhost:${this.boundPort || this.config.port}/webhook/${name}`;
  }
};

// src/channels/lib/event-pipeline.ts
import { basename } from "path";

// src/channels/lib/event-queue.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync8, writeFileSync as writeFileSync7, renameSync as renameSync3 } from "fs";
import { join as join7 } from "path";

// src/channels/lib/state-file.ts
import { mkdirSync as mkdirSync4, readFileSync as readFileSync7, renameSync as renameSync2, unlinkSync as unlinkSync3, writeFileSync as writeFileSync6 } from "fs";
import { dirname as dirname2 } from "path";
function ensureDir(dirPath) {
  mkdirSync4(dirPath, { recursive: true });
}
function removeFileIfExists(filePath) {
  try {
    unlinkSync3(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
}
function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(readFileSync7(filePath, "utf8"));
  } catch {
    return fallback;
  }
}
function writeTextFile(filePath, value) {
  ensureDir(dirname2(filePath));
  writeFileSync6(filePath, value);
}
function writeJsonFile(filePath, value) {
  const tmpPath = filePath + ".tmp";
  ensureDir(dirname2(filePath));
  writeFileSync6(tmpPath, JSON.stringify(value));
  renameSync2(tmpPath, filePath);
}
var JsonStateFile = class {
  constructor(filePath, fallback) {
    this.filePath = filePath;
    this.fallback = fallback;
  }
  read() {
    return readJsonFile(this.filePath, this.fallback);
  }
  write(value) {
    writeJsonFile(this.filePath, value);
    return value;
  }
  ensure() {
    writeJsonFile(this.filePath, this.read());
  }
  update(mutator) {
    const draft = this.read();
    mutator(draft);
    return this.write(draft);
  }
};

// src/channels/lib/event-queue.ts
var QUEUE_DIR = join7(DATA_DIR, "events", "queue");
var PROCESSED_DIR = join7(DATA_DIR, "events", "processed");
var EventQueue = class {
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
  constructor(config2, channelsConfig) {
    this.config = config2 ?? {};
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
  reloadConfig(config2, channelsConfig) {
    this.stop();
    this.config = config2 ?? {};
    this.channelsConfig = channelsConfig ?? null;
    this.start();
  }
  // ── Enqueue ───────────────────────────────────────────────────────
  enqueue(item) {
    ensureDir(QUEUE_DIR);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const filename = `${item.priority === "high" ? "0" : item.priority === "normal" ? "1" : "2"}-${id}.json`;
    writeFileSync7(join7(QUEUE_DIR, filename), JSON.stringify(item, null, 2));
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
        this.injectFn("", `event:${item.name}`, item.prompt, opts);
      }
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
      return readdirSync2(QUEUE_DIR).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }
  readItem(file) {
    try {
      return JSON.parse(readFileSync8(join7(QUEUE_DIR, file), "utf8"));
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
      renameSync3(join7(QUEUE_DIR, file), join7(PROCESSED_DIR, `${status}-${file}`));
    } catch {
    }
  }
  resolveChannel(label) {
    if (!label || !this.channelsConfig) return "";
    const entry = this.channelsConfig[label] ?? this.channelsConfig?.channels?.[label];
    if (!entry) return label;
    return typeof entry === "string" ? entry : entry.id ?? label;
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
    const pending2 = this.readQueueFiles().length;
    return { pending: pending2, running: this.runningCount };
  }
  /** List pending interactive items */
  getPendingInteractive() {
    return this.readQueueFiles().map((f) => this.readItem(f)).filter((item) => item !== null && item.exec === "interactive");
  }
};

// src/channels/lib/event-pipeline.ts
var EventPipeline = class {
  rules;
  queue;
  constructor(config2, channelsConfig) {
    this.rules = (config2?.rules ?? []).filter((r) => r.enabled !== false);
    this.queue = new EventQueue(config2?.queue, channelsConfig);
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
  reloadConfig(config2, channelsConfig) {
    this.rules = (config2?.rules ?? []).filter((r) => r.enabled !== false);
    this.queue.reloadConfig(config2?.queue, channelsConfig);
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
  enqueueDirect(name, prompt, channel, exec = "interactive") {
    const item = {
      name,
      source: "webhook",
      priority: "normal",
      prompt,
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
};

// src/channels/lib/output-forwarder.ts
import { readFileSync as readFileSync9, readdirSync as readdirSync3, existsSync as existsSync5, statSync as statSync3, watch, openSync, readSync, closeSync } from "fs";
import { execFileSync } from "child_process";
import { basename as basename2, join as join8, resolve } from "path";
import { homedir as homedir2 } from "os";
import { createHash } from "crypto";
function cwdToProjectSlug(cwd) {
  return resolve(cwd).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1-").replace(/\//g, "-");
}
function getParentPid(pid) {
  try {
    if (process.platform === "win32") {
      const out2 = execFileSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`
      ], { encoding: "utf8" }).trim();
      const parsed2 = parseInt(out2, 10);
      return Number.isFinite(parsed2) ? parsed2 : null;
    }
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const parsed = parseInt(out, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function readSessionRecord(pid) {
  const sessionFile = join8(homedir2(), ".claude", "sessions", `${pid}.json`);
  try {
    const session = JSON.parse(readFileSync9(sessionFile, "utf8"));
    if (!session.sessionId) return null;
    return {
      pid,
      sessionId: session.sessionId,
      cwd: resolve(session.cwd ?? process.cwd()),
      startedAt: typeof session.startedAt === "number" ? session.startedAt : 0,
      kind: typeof session.kind === "string" ? session.kind : "",
      entrypoint: typeof session.entrypoint === "string" ? session.entrypoint : ""
    };
  } catch {
    return null;
  }
}
function discoverCurrentClaudeSession() {
  let pid = process.ppid;
  for (let depth = 0; pid && pid > 1 && depth < 6; depth += 1) {
    const session = readSessionRecord(pid);
    if (session) return session;
    pid = getParentPid(pid);
  }
  return null;
}
function resolveTranscriptForSession(session) {
  const projectsDir = join8(homedir2(), ".claude", "projects");
  const projectSlug = cwdToProjectSlug(process.cwd());
  const preferred = join8(projectsDir, cwdToProjectSlug(session.cwd), `${session.sessionId}.jsonl`);
  if (existsSync5(preferred)) {
    return {
      claudePid: session.pid,
      sessionId: session.sessionId,
      sessionCwd: session.cwd,
      transcriptPath: preferred,
      exists: true
    };
  }
  const fallback = join8(projectsDir, projectSlug, `${session.sessionId}.jsonl`);
  if (existsSync5(fallback)) {
    return {
      claudePid: session.pid,
      sessionId: session.sessionId,
      sessionCwd: session.cwd,
      transcriptPath: fallback,
      exists: true
    };
  }
  return {
    claudePid: session.pid,
    sessionId: session.sessionId,
    sessionCwd: session.cwd,
    transcriptPath: preferred,
    exists: false
  };
}
function discoverSessionBoundTranscript() {
  const session = discoverCurrentClaudeSession();
  if (!session) return null;
  return resolveTranscriptForSession(session);
}
function findLatestTranscriptByMtime(cwd) {
  const projectsDir = join8(homedir2(), ".claude", "projects");
  const slug = cwdToProjectSlug(cwd ?? process.cwd());
  const projectDir = join8(projectsDir, slug);
  try {
    const files = readdirSync3(projectDir).filter((f) => f.endsWith(".jsonl")).map((f) => {
      const full = join8(projectDir, f);
      try {
        return { path: full, mtime: statSync3(full).mtimeMs };
      } catch {
        return null;
      }
    }).filter((f) => f !== null).sort((a, b) => b.mtime - a.mtime);
    return files[0]?.path ?? null;
  } catch {
    return null;
  }
}
var OutputForwarder = class _OutputForwarder {
  constructor(cb, statusState2) {
    this.cb = cb;
    this.statusState = statusState2;
  }
  lastHash = "";
  sentCount = 0;
  transcriptPath = "";
  channelId = "";
  userMessageId = "";
  emoji = "";
  lastFileSize = 0;
  readFileSize = 0;
  watchingPath = "";
  watcher = null;
  idleTimer = null;
  onIdleCallback = null;
  inExplorerSequence = false;
  inRecallSequence = false;
  hasSeenAssistant = false;
  sending = false;
  sendRetryTimer = null;
  sendQueue = [];
  mainSessionId = "";
  watchDebounce = null;
  turnTextBuffer = "";
  healthCheckTimer = null;
  hasBinding() {
    return !!this.transcriptPath;
  }
  /** Set context for current turn (called on user message) */
  setContext(channelId, transcriptPath, options = {}) {
    this.channelId = channelId;
    if (!transcriptPath) return;
    if (this.transcriptPath && !existsSync5(this.transcriptPath)) {
      const relocated = findLatestTranscriptByMtime();
      if (relocated) {
        transcriptPath = relocated;
      }
    }
    if (this.transcriptPath !== transcriptPath) {
      this.closeWatcher();
      this.transcriptPath = transcriptPath;
      this.mainSessionId = "";
    }
    try {
      const fileSize = options.replayFromStart ? 0 : existsSync5(this.transcriptPath) ? statSync3(this.transcriptPath).size : 0;
      this.lastFileSize = fileSize;
      this.readFileSize = fileSize;
    } catch {
      this.lastFileSize = 0;
      this.readFileSize = 0;
    }
  }
  /** Reset counters for new turn */
  reset() {
    this.sentCount = 0;
    this.lastHash = "";
    this.inExplorerSequence = false;
    this.inRecallSequence = false;
    this.hasSeenAssistant = false;
    this.turnTextBuffer = "";
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
  /** Read new bytes from transcript file since readFileSize */
  readNewLines() {
    if (!this.transcriptPath || !existsSync5(this.transcriptPath)) {
      return { lines: [], nextFileSize: this.readFileSize };
    }
    let fd = null;
    try {
      const stat = statSync3(this.transcriptPath);
      if (stat.size <= this.readFileSize) {
        return { lines: [], nextFileSize: this.readFileSize };
      }
      const startOffset = this.readFileSize;
      fd = openSync(this.transcriptPath, "r");
      const buf = Buffer.alloc(stat.size - startOffset);
      readSync(fd, buf, 0, buf.length, startOffset);
      this.readFileSize = stat.size;
      return {
        lines: buf.toString("utf8").split("\n").filter((l) => l.trim()),
        nextFileSize: stat.size
      };
    } catch {
      return { lines: [], nextFileSize: this.readFileSize };
    } finally {
      if (fd != null) {
        closeSync(fd);
      }
    }
  }
  /** Track last tool_use name and file path for matching with tool_result */
  lastToolName = "";
  lastToolFilePath = "";
  /** Extract new assistant text + tool logs from transcript since readFileSize */
  extractNewText() {
    const { lines: newLines, nextFileSize } = this.readNewLines();
    let newText = "";
    for (const l of newLines) {
      try {
        const entry = JSON.parse(l);
        if (!entry.isSidechain && entry.sessionId && !this.mainSessionId) {
          this.mainSessionId = entry.sessionId;
        }
        if (entry.isSidechain) continue;
        if (this.mainSessionId && entry.sessionId && entry.sessionId !== this.mainSessionId) continue;
        if (entry.type === "user" && entry.message?.content?.some((c) => c.type === "tool_result")) {
          if (_OutputForwarder.isRecallMemory(this.lastToolName)) {
            continue;
          }
          if (this.lastToolName === "Edit" && entry.toolUseResult && !_OutputForwarder.isMemoryFile(this.lastToolFilePath)) {
            const old = entry.toolUseResult.oldString || "";
            const nw = entry.toolUseResult.newString || "";
            if (old || nw) {
              const diffLines = [];
              for (const l2 of old.split("\n")) diffLines.push("- " + l2);
              for (const l2 of nw.split("\n")) diffLines.push("+ " + l2);
              const shown = diffLines.slice(0, 15);
              let diffContent = shown.join("\n");
              if (diffLines.length > 15) diffContent += "\n... +" + (diffLines.length - 15) + " lines";
              const block = safeCodeBlock(diffContent, "diff");
              newText += block + "\n";
            }
          }
          continue;
        }
        if (entry.type === "assistant" && entry.message?.content) {
          this.hasSeenAssistant = true;
          const SEARCH_TOOLS2 = /* @__PURE__ */ new Set(["Read", "Grep", "Glob"]);
          const parts = [];
          for (const c of entry.message.content) {
            if (c.type === "text" && c.text?.trim()) {
              this.inExplorerSequence = false;
              this.inRecallSequence = false;
              let cleaned = c.text.trim().replace(/<(channel|memory-context|system-reminder|event)\b[^>]*>[\s\S]*?<\/\1>/g, "").trim();
              if (cleaned) parts.push(cleaned);
            } else if (c.type === "tool_use") {
              this.lastToolName = c.name || "";
              this.lastToolFilePath = c.input?.file_path || "";
              if (_OutputForwarder.isHidden(c.name)) continue;
              if (SEARCH_TOOLS2.has(c.name)) {
                if (!this.inExplorerSequence) {
                  this.inExplorerSequence = true;
                  let target = "";
                  if (c.name === "Read") target = c.input?.file_path ? basename2(c.input.file_path) : "";
                  else if (c.name === "Grep") target = '"' + (c.input?.pattern || "").substring(0, 25) + '"';
                  else if (c.name === "Glob") target = (c.input?.pattern || "").substring(0, 25);
                  if (parts.length > 0) parts.push("");
                  parts.push("\u25CF **Explorer** (" + (target || c.name) + ")");
                }
                continue;
              }
              if (_OutputForwarder.isRecallMemory(c.name)) {
                if (!this.inRecallSequence) {
                  this.inRecallSequence = true;
                  if (parts.length > 0) parts.push("");
                  parts.push("\u25CF **recall_memory**");
                }
                continue;
              }
              this.inExplorerSequence = false;
              this.inRecallSequence = false;
              const toolLine = _OutputForwarder.buildToolLine(c.name, c.input);
              if (toolLine) {
                if (parts.length > 0) parts.push("");
                parts.push(toolLine);
              }
            }
          }
          if (parts.length) newText += parts.join("\n") + "\n";
        }
      } catch {
      }
    }
    return { text: newText.trim(), nextFileSize };
  }
  // ── Single-send gate ──────────────────────────────────────────────
  // All Discord sends pass through sendOnce() so duplicate concurrent sends are avoided.
  // Texts that should never be forwarded to Discord (Claude's internal status lines)
  static SKIP_TEXTS = /* @__PURE__ */ new Set([
    "No response requested.",
    "No response requested",
    "Waiting for user response.",
    "Waiting for user response"
  ]);
  commitReadProgress(nextFileSize) {
    if (nextFileSize <= this.lastFileSize) return;
    this.lastFileSize = nextFileSize;
    this.persistState();
  }
  async deliverQueueItem(item) {
    if (!item.text || !this.channelId) {
      this.commitReadProgress(item.nextFileSize);
      return;
    }
    if (!item.skipHashDedup && _OutputForwarder.SKIP_TEXTS.has(item.text.trim())) {
      this.commitReadProgress(item.nextFileSize);
      return;
    }
    const formatted = item.preformatted ? item.text : formatForDiscord(item.text);
    const hash = item.skipHashDedup ? "" : createHash("md5").update(formatted).digest("hex");
    if (!item.skipHashDedup && this.lastHash === hash) {
      this.commitReadProgress(item.nextFileSize);
      return;
    }
    const chunks = chunk(formatted, 2e3);
    for (const c of chunks) {
      await this.cb.send(this.channelId, c);
    }
    if (!item.skipHashDedup) {
      this.lastHash = hash;
    }
    if (item.bufferText.trim()) {
      this.turnTextBuffer = this.turnTextBuffer ? `${this.turnTextBuffer}

${item.bufferText.trim()}` : item.bufferText.trim();
    }
    this.sentCount += chunks.length;
    this.commitReadProgress(item.nextFileSize);
  }
  scheduleRetry() {
    if (this.sendRetryTimer) return;
    this.sendRetryTimer = setTimeout(() => {
      this.sendRetryTimer = null;
      void this.drainQueue();
    }, 1e3);
  }
  /** Forward new assistant text to Discord. Returns true if text was sent. */
  async forwardNewText() {
    if (!this.channelId) return false;
    const { text: newText, nextFileSize } = this.extractNewText();
    if (!newText) {
      if (!this.sending && this.sendQueue.length === 0) {
        this.commitReadProgress(nextFileSize);
      }
      return false;
    }
    this.sendQueue.push({
      type: "text",
      text: newText,
      nextFileSize,
      bufferText: newText
    });
    void this.drainQueue();
    return true;
  }
  /** Forward tool log line to Discord */
  async forwardToolLog(toolLine) {
    if (!this.channelId) return;
    const { text: newText, nextFileSize } = this.extractNewText();
    const message = newText ? formatForDiscord(newText) + "\n\n" + toolLine : toolLine;
    this.sendQueue.push({
      type: "toolLog",
      text: message,
      nextFileSize,
      bufferText: newText,
      preformatted: true,
      skipHashDedup: true
    });
    void this.drainQueue();
  }
  /** Drain the send queue sequentially. Only one drain loop runs at a time. */
  async drainQueue() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.sendQueue.length > 0) {
        const item = this.sendQueue[0];
        try {
          if (item.type === "text") {
            await this.deliverQueueItem(item);
          } else if (item.type === "toolLog") {
            await this.processToolLog(item);
          }
          this.sendQueue.shift();
        } catch (err) {
          process.stderr.write(`trib-plugin: send failed: ${err}
`);
          this.scheduleRetry();
          break;
        }
      }
    } finally {
      this.sending = false;
    }
  }
  /** Internal: process a single tool log send (extracted from old forwardToolLog) */
  async processToolLog(item) {
    if (this.userMessageId) {
      const newEmoji = "\u{1F6E0}\uFE0F";
      try {
        if (this.emoji && this.emoji !== newEmoji) {
          await this.cb.removeReaction(this.channelId, this.userMessageId, this.emoji);
        }
        await this.cb.react(this.channelId, this.userMessageId, newEmoji);
        this.emoji = newEmoji;
      } catch {
      }
    }
    await this.deliverQueueItem(item);
  }
  /** Forward final text on session idle */
  async forwardFinalText(retries = 0) {
    if (!this.channelId) return;
    if (this.sending || this.sendQueue.length > 0) {
      if (retries < 5) {
        setTimeout(() => void this.forwardFinalText(retries + 1), 300);
      }
      return;
    }
    this.sending = true;
    try {
      if (this.userMessageId && this.emoji) {
        try {
          await this.cb.removeReaction(this.channelId, this.userMessageId, this.emoji);
        } catch {
        }
      }
      const { text: newText, nextFileSize } = this.extractNewText();
      if (newText) {
        await this.deliverQueueItem({
          text: newText,
          nextFileSize,
          bufferText: newText
        });
      } else {
        this.commitReadProgress(nextFileSize);
      }
      if (this.turnTextBuffer.trim()) {
        await this.cb.recordAssistantTurn?.({
          channelId: this.channelId,
          text: this.turnTextBuffer.trim(),
          sessionId: this.mainSessionId || void 0
        });
        this.turnTextBuffer = "";
      }
      this.updateState((state) => {
        state.sessionIdle = true;
      });
    } finally {
      this.sending = false;
    }
  }
  /** Hidden tools — skip both tool_use and tool_result */
  static HIDDEN_TOOLS = /* @__PURE__ */ new Set([
    "ToolSearch",
    "SendMessage",
    "TeamCreate",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskGet"
  ]);
  /** Check if a tool name is recall_memory */
  static isRecallMemory(name) {
    return name === "recall_memory" || name === "mcp__plugin_trib-plugin_trib-plugin__recall_memory";
  }
  /** Check if a file path points to a memory file */
  static isMemoryFile(filePath) {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, "/");
    if (normalized.includes(".claude/projects/") && normalized.includes("/memory/")) return true;
    if (basename2(normalized) === "MEMORY.md") return true;
    return false;
  }
  /** Check if a tool should be hidden */
  static isHidden(name) {
    if (_OutputForwarder.HIDDEN_TOOLS.has(name)) return true;
    if (name.includes("plugin_trib-plugin") && !name.endsWith("recall_memory") || name === "reply" || name === "react" || name === "edit_message" || name === "fetch" || name === "download_attachment") return true;
    return false;
  }
  /** Build a tool log line from the tool name and input. */
  static buildToolLine(name, input) {
    if (_OutputForwarder.isHidden(name)) return null;
    let displayName = name;
    let summary = "";
    let detail = "";
    const isSearchTool = name === "Read" || name === "Grep" || name === "Glob";
    switch (name) {
      case "Bash": {
        const desc = (input?.description || "").substring(0, 50);
        summary = desc || "Bash";
        detail = (input?.command || "").substring(0, 500);
        break;
      }
      case "Read":
        summary = input?.file_path ? basename2(input.file_path) : "";
        break;
      case "Grep":
        summary = '"' + (input?.pattern || "").substring(0, 25) + '"';
        break;
      case "Glob":
        summary = (input?.pattern || "").substring(0, 25);
        break;
      case "Edit":
      case "Write":
        summary = input?.file_path ? basename2(input.file_path) : "";
        detail = input?.file_path || "";
        break;
      case "Agent": {
        summary = input?.name || input?.subagent_type || "agent";
        let d = (input?.prompt || "").substring(0, 200);
        const backticks = (d.match(/```/g) || []).length;
        if (backticks % 2 === 1) d += "\n```";
        if (d.length < (input?.prompt || "").length) d += "...";
        detail = d;
        break;
      }
      case "TeamCreate":
        summary = input?.team_name || "";
        detail = input?.description || "";
        break;
      case "TaskCreate":
        summary = (input?.subject || "").substring(0, 50);
        break;
      case "Skill":
        summary = input?.skill || "";
        break;
      default:
        if (name.startsWith("mcp__")) {
          const parts = name.split("__");
          displayName = "mcp";
          summary = parts[parts.length - 1] || "";
        } else {
          summary = name;
        }
        break;
    }
    if (!summary) return null;
    let toolLine = displayName === summary ? "\u25CF **" + displayName + "**" : "\u25CF **" + displayName + "** (" + summary + ")";
    if (!isSearchTool && detail && detail !== summary) {
      const lines = detail.substring(0, 500).split("\n");
      const shown = lines.slice(0, 5);
      let block = shown.join("\n");
      if (lines.length > 5) block += "\n... +" + (lines.length - 5) + " lines";
      toolLine += "\n" + safeCodeBlock(block);
    }
    return toolLine;
  }
  // ── File watch ─────────────────────────────────────────────────────
  /** Set callback for idle detection (no new data for 5s after assistant entry) */
  setOnIdle(cb) {
    this.onIdleCallback = cb;
  }
  /** Start watching transcript file for changes (runs once, never stops) */
  startWatch() {
    if (!this.transcriptPath) return;
    if (this.watchingPath === this.transcriptPath && this.watcher) return;
    this.closeWatcher();
    this.watchingPath = this.transcriptPath;
    try {
      this.watcher = watch(this.transcriptPath, () => this.scheduleWatchFlush());
      this.watcher.on("error", () => this.closeWatcher());
    } catch {
      this.closeWatcher();
    }
    if (!this.healthCheckTimer) {
      this.healthCheckTimer = setInterval(() => {
        if (!this.transcriptPath || existsSync5(this.transcriptPath)) return;
        const relocated = findLatestTranscriptByMtime();
        if (relocated && relocated !== this.transcriptPath) {
          process.stderr.write(`trib-plugin: watched transcript disappeared, relocated to ${relocated}
`);
          this.closeWatcher();
          this.transcriptPath = relocated;
          this.mainSessionId = "";
          this.startWatch();
        }
      }, 3e4);
    }
  }
  /** No-op — watch is kept alive permanently */
  stopWatch() {
  }
  /** Reset the idle timer — safety net in case turn-end signal is missed */
  resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.onIdleCallback) this.onIdleCallback();
    }, 1e3);
  }
  closeWatcher() {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = null;
    }
    if (this.sendRetryTimer) {
      clearTimeout(this.sendRetryTimer);
      this.sendRetryTimer = null;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.watchingPath = "";
  }
  scheduleWatchFlush() {
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = null;
      if (this.transcriptPath && !existsSync5(this.transcriptPath)) {
        const relocated = findLatestTranscriptByMtime();
        if (relocated && relocated !== this.transcriptPath) {
          process.stderr.write(`trib-plugin: watched transcript gone during flush, relocated to ${relocated}
`);
          this.closeWatcher();
          this.transcriptPath = relocated;
          this.mainSessionId = "";
          this.startWatch();
        }
        return;
      }
      void this.forwardNewText().then((hadText) => {
        if (hadText) {
          this.resetIdleTimer();
        }
      });
    }, 200);
  }
  updateState(mutator) {
    this.statusState.update(mutator);
  }
  persistState() {
    this.updateState((state) => {
      state.lastFileSize = this.lastFileSize;
      state.sentCount = this.sentCount;
      state.lastSentHash = this.lastHash;
      state.lastSentTime = Date.now();
      state.emoji = this.emoji;
      state.sessionIdle = false;
    });
  }
};

// src/channels/lib/session-control.ts
import { existsSync as existsSync6, readFileSync as readFileSync11, unlinkSync as unlinkSync4, writeFileSync as writeFileSync9 } from "fs";
import { setTimeout as delay } from "timers/promises";

// src/channels/lib/runtime-paths.ts
import { readFileSync as readFileSync10, readdirSync as readdirSync4, statSync as statSync4, writeFileSync as writeFileSync8 } from "fs";
import { execFileSync as execFileSync2 } from "child_process";
import { tmpdir as tmpdir3 } from "os";
import { join as join9 } from "path";
var RUNTIME_ROOT = join9(tmpdir3(), "trib-plugin");
var OWNER_DIR = join9(RUNTIME_ROOT, "owners");
var ACTIVE_INSTANCE_FILE = join9(RUNTIME_ROOT, "active-instance.json");
var RUNTIME_STALE_TTL = 24 * 60 * 60 * 1e3;
function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function forEachFile(dirPath, visit) {
  try {
    for (const fileName of readdirSync4(dirPath)) {
      visit(join9(dirPath, fileName), fileName);
    }
  } catch {
  }
}
function ensureRuntimeDirs() {
  ensureDir(RUNTIME_ROOT);
  ensureDir(OWNER_DIR);
}
function makeInstanceId(pid = process.pid) {
  return String(pid);
}
function getTurnEndPath(instanceId) {
  return join9(RUNTIME_ROOT, `turn-end-${sanitize(instanceId)}`);
}
function getStatusPath(instanceId) {
  return join9(RUNTIME_ROOT, `status-${sanitize(instanceId)}.json`);
}
function getControlPath(instanceId) {
  return join9(RUNTIME_ROOT, `control-${sanitize(instanceId)}.json`);
}
function getControlResponsePath(instanceId) {
  return join9(RUNTIME_ROOT, `control-${sanitize(instanceId)}.response.json`);
}
function getPermissionResultPath(instanceId, uuid) {
  return join9(RUNTIME_ROOT, `perm-${sanitize(instanceId)}-${sanitize(uuid)}.result`);
}
function getStopFlagPath(instanceId) {
  return join9(RUNTIME_ROOT, `stop-${sanitize(instanceId)}.flag`);
}
function getChannelOwnerPath(channelId) {
  return join9(OWNER_DIR, `${sanitize(channelId)}.json`);
}
function readActiveInstance() {
  const state = readJsonFile(ACTIVE_INSTANCE_FILE, null);
  if (!state) return null;
  try {
    process.kill(state.pid, 0);
  } catch {
    process.stderr.write(`trib-plugin: stale active-instance.json (PID ${state.pid} is dead), removing
`);
    removeFileIfExists(ACTIVE_INSTANCE_FILE);
    return null;
  }
  return state;
}
function writeActiveInstance(state) {
  ensureRuntimeDirs();
  writeJsonFile(ACTIVE_INSTANCE_FILE, state);
}
function buildActiveInstanceState(instanceId, meta) {
  return {
    instanceId,
    pid: process.pid,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    turnEndFile: getTurnEndPath(instanceId),
    statusFile: getStatusPath(instanceId),
    ...meta?.channelId ? { channelId: meta.channelId } : {},
    ...meta?.transcriptPath ? { transcriptPath: meta.transcriptPath } : {},
    ...meta?.httpPort ? { httpPort: meta.httpPort } : {}
  };
}
function refreshActiveInstance(instanceId, meta) {
  const prev = readActiveInstance();
  const next = {
    ...prev?.instanceId === instanceId ? prev : buildActiveInstanceState(instanceId),
    updatedAt: Date.now(),
    ...meta?.channelId ? { channelId: meta.channelId } : {},
    ...meta?.transcriptPath ? { transcriptPath: meta.transcriptPath } : {},
    ...meta?.httpPort ? { httpPort: meta.httpPort } : {}
  };
  writeActiveInstance(next);
  return next;
}
var SERVER_PID_FILE = join9(
  RUNTIME_ROOT,
  `server-${sanitize(process.env.CLAUDE_PLUGIN_DATA ?? "default")}.pid`
);
function looksLikeTribChannelsServer(pid) {
  const pidStr = String(pid);
  if (process.platform === "win32") {
    try {
      const out = execFileSync2("tasklist", ["/FI", `PID eq ${pidStr}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).trim();
      if (!out || out.includes("No tasks")) return false;
      const lower = out.toLowerCase();
      return lower.includes("server.ts") && (lower.includes("node") || lower.includes("tsx") || lower.includes("trib-plugin"));
    } catch {
      return true;
    }
  }
  try {
    const cmd = execFileSync2("ps", ["-o", "command=", "-p", pidStr], { encoding: "utf8" }).trim();
    if (!cmd) return false;
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? "";
    if (!cmd.includes("server.ts")) return false;
    return cmd.includes("trib-plugin") || pluginRoot && cmd.includes(pluginRoot) || cmd.includes("tsx server.ts") || cmd.includes("node") && cmd.includes("server");
  } catch {
    return false;
  }
}
function waitForExit(pid, timeoutMs) {
  const start2 = Date.now();
  while (Date.now() - start2 < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    const wait = 100;
    const end = Date.now() + wait;
    while (Date.now() < end) {
    }
  }
  return false;
}
function killSinglePid(pid) {
  if (process.platform === "win32") {
    try {
      execFileSync2("taskkill", ["/F", "/T", "/PID", String(pid)], { encoding: "utf8", timeout: 5e3 });
    } catch (err) {
      console.warn(`[singleton] taskkill failed for PID ${pid}:`, err.message);
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
    }
    if (!waitForExit(pid, 2e3)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
      if (!waitForExit(pid, 1e3)) {
        console.warn(`[singleton] failed to kill previous server PID ${pid}`);
      }
    }
  }
}
function killAllPreviousServers() {
  try {
    const oldPid = parseInt(readFileSync10(SERVER_PID_FILE, "utf8").trim(), 10);
    if (oldPid && oldPid !== process.pid && oldPid !== process.ppid) {
      try {
        process.kill(oldPid, 0);
      } catch {
        return;
      }
      if (looksLikeTribChannelsServer(oldPid)) {
        killSinglePid(oldPid);
      }
    }
  } catch {
  }
}
function writeServerPid() {
  ensureRuntimeDirs();
  writeFileSync8(SERVER_PID_FILE, String(process.pid));
}
function clearServerPid() {
  try {
    const current = readFileSync10(SERVER_PID_FILE, "utf8").trim();
    if (current === String(process.pid)) removeFileIfExists(SERVER_PID_FILE);
  } catch {
  }
}
function cleanupStaleRuntimeFiles(now = Date.now()) {
  ensureRuntimeDirs();
  forEachFile(RUNTIME_ROOT, (fullPath, file) => {
    if (file === "owners" || file === "active-instance.json") return;
    try {
      if (now - statSync4(fullPath).mtimeMs > RUNTIME_STALE_TTL) removeFileIfExists(fullPath);
    } catch {
    }
  });
  forEachFile(OWNER_DIR, (fullPath) => {
    try {
      if (now - statSync4(fullPath).mtimeMs > RUNTIME_STALE_TTL) removeFileIfExists(fullPath);
    } catch {
    }
  });
}
function cleanupInstanceRuntimeFiles(instanceId) {
  const targets = [
    getTurnEndPath(instanceId),
    getStatusPath(instanceId),
    getControlPath(instanceId),
    getControlResponsePath(instanceId),
    getStopFlagPath(instanceId)
  ];
  for (const target of targets) {
    removeFileIfExists(target);
  }
  forEachFile(RUNTIME_ROOT, (fullPath, file) => {
    if (file.startsWith(`perm-${sanitize(instanceId)}-`)) {
      removeFileIfExists(fullPath);
    }
  });
}
function releaseOwnedChannelLocks(instanceId) {
  forEachFile(OWNER_DIR, (fullPath) => {
    const owner = readJsonFile(fullPath, null);
    if (owner?.instanceId === instanceId) removeFileIfExists(fullPath);
  });
}
function clearActiveInstance(instanceId) {
  const active = readActiveInstance();
  if (active?.instanceId !== instanceId) return;
  removeFileIfExists(ACTIVE_INSTANCE_FILE);
}

// src/channels/lib/session-control.ts
async function controlClaudeSession(instanceId, command, timeoutMs = 3e3) {
  const controlPath = getControlPath(instanceId);
  const responsePath = getControlResponsePath(instanceId);
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    unlinkSync4(responsePath);
  } catch {
  }
  writeFileSync9(controlPath, JSON.stringify({ id, command, requestedAt: Date.now() }));
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync6(responsePath)) {
      try {
        const payload = JSON.parse(readFileSync11(responsePath, "utf8"));
        if (payload.id === id) return payload;
      } catch {
      }
    }
    await delay(100);
  }
  return {
    ok: false,
    mode: "unsupported",
    message: "session control timeout"
  };
}

// src/channels/lib/interaction-workflows.ts
function stateKey(userId, channelId) {
  return `${userId}:${channelId}`;
}
var PendingInteractionStore = class {
  states = /* @__PURE__ */ new Map();
  get(userId, channelId) {
    return { ...this.states.get(stateKey(userId, channelId)) ?? {} };
  }
  set(userId, channelId, state) {
    this.states.set(stateKey(userId, channelId), state);
  }
  patch(userId, channelId, update) {
    const next = { ...this.get(userId, channelId), ...update };
    this.set(userId, channelId, next);
    return next;
  }
  delete(userId, channelId) {
    this.states.delete(stateKey(userId, channelId));
  }
  rememberMessage(userId, channelId, messageId) {
    if (!messageId) return;
    this.patch(userId, channelId, { _msgId: messageId });
  }
};
function buildModalRequestSpec(customId, pending2, profile) {
  switch (customId) {
    case "sched_add_next": {
      const fields = [
        { id: "name", label: "Name", required: true },
        { id: "time", label: "Time (HH:MM / hourly / every5m)", required: true },
        { id: "channel", label: "Channel", required: false, value: "general" }
      ];
      if (pending2.exec?.includes("script")) {
        fields.push({ id: "script", label: "Script filename", required: true });
      }
      return {
        customId: "modal_sched_add",
        title: "Add Schedule",
        fields
      };
    }
    case "quiet_set_next":
      return {
        customId: "modal_quiet",
        title: "Quiet Hours",
        fields: [
          { id: "schedule", label: "Schedule quiet hours (e.g. 23:00-07:00)", required: false }
        ]
      };
    case "sched_edit_next": {
      const fields = [
        { id: "time", label: "Time (HH:MM / hourly / every5m)", required: false },
        { id: "channel", label: "Channel", required: false },
        { id: "dnd", label: "Quiet hours (e.g. 23:00-07:00, leave empty to disable)", required: false }
      ];
      if (pending2.exec?.includes("script")) {
        fields.push({ id: "script", label: "Script filename", required: false });
      }
      return {
        customId: "modal_sched_edit",
        title: `${pending2.editName ?? "Schedule"} Edit`,
        fields
      };
    }
    case "activity_add_next":
      return {
        customId: "modal_activity_add",
        title: "Add Activity Channel",
        fields: [
          { id: "name", label: "Channel Name", required: true },
          { id: "id", label: "Channel ID", required: true }
        ]
      };
    case "profile_edit":
      return {
        customId: "modal_profile_edit",
        title: "Edit Profile",
        fields: [
          { id: "name", label: "Name", required: false, value: profile.name ?? "" },
          { id: "role", label: "Role", required: false, value: profile.role ?? "" },
          { id: "lang", label: "Language (ko / en / ja / zh)", required: false, value: profile.lang ?? "" },
          { id: "tone", label: "Tone", required: false, value: profile.tone ?? "" }
        ]
      };
    default:
      return null;
  }
}

// src/channels/index.ts
var memoryClientModulePath = pathToFileURL(path.join(PLUGIN_ROOT, "src/channels/lib/memory-client.mjs")).href;
var {
  appendEpisode: memoryAppendEpisode,
  ingestTranscript: memoryIngestTranscript,
  getProactiveSources,
  getProactiveContext,
  applyProactiveUpdates
} = await import(memoryClientModulePath);
var DEFAULT_PLUGIN_VERSION = "0.0.1";
function localTimestamp() {
  return (/* @__PURE__ */ new Date()).toLocaleString("sv-SE", { hour12: false });
}
function readPluginVersion() {
  try {
    const manifestPath = path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.version || DEFAULT_PLUGIN_VERSION;
  } catch {
    return DEFAULT_PLUGIN_VERSION;
  }
}
var PLUGIN_VERSION = readPluginVersion();
var crashLogging = false;
function logCrash(label, err) {
  if (crashLogging) return;
  crashLogging = true;
  if (err instanceof Error && err.message.includes("EPIPE")) {
    try {
      const crashLog = path.join(DATA_DIR, "crash.log");
      fs.appendFileSync(crashLog, `[${localTimestamp()}] trib-plugin: EPIPE detected, disconnecting + exiting
`);
    } catch {
    }
    process.exit(1);
  }
  const msg = `[${localTimestamp()}] trib-plugin: ${label}: ${err}
${err instanceof Error ? err.stack : ""}
`;
  try {
    process.stderr.write(msg);
  } catch {
  }
  try {
    const crashLog = path.join(DATA_DIR, "crash.log");
    fs.appendFileSync(crashLog, msg);
  } catch {
  }
}
process.on("unhandledRejection", (err) => logCrash("unhandled rejection", err));
process.on("uncaughtException", (err) => logCrash("uncaught exception", err));
if (process.env.TRIB_CHANNELS_NO_CONNECT) {
  process.exit(0);
}
var _bootLogEarly = path.join(
  process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "trib-plugin"),
  "boot.log"
);
fs.appendFileSync(_bootLogEarly, `[${localTimestamp()}] bootstrap start pid=${process.pid}
`);
var _bootLog = path.join(DATA_DIR, "boot.log");
var config = loadConfig();
var botConfig = loadBotConfig();
var backend = createBackend(config);
var INSTANCE_ID = makeInstanceId();
ensureRuntimeDirs();
killAllPreviousServers();
writeServerPid();
cleanupStaleRuntimeFiles();
startCliWorker();
var INSTRUCTIONS = "";
var mcpServer = new Server(
  { name: "trib-plugin", version: PLUGIN_VERSION },
  {
    capabilities: { tools: {}, experimental: { "claude/channel": {}, "claude/channel/permission": {} } },
    instructions: INSTRUCTIONS
  }
);
var channelBridgeActive = false;
function writeBridgeState(active) {
  try {
    const stateFile = path.join(os.tmpdir(), "trib-plugin", "bridge-state.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ active, ts: Date.now() }));
  } catch {
  }
}
var typingChannelId = null;
var pendingSetup = new PendingInteractionStore();
function startServerTyping(channelId) {
  if (typingChannelId && typingChannelId !== channelId) {
    backend.stopTyping(typingChannelId);
  }
  typingChannelId = channelId;
  backend.startTyping(channelId);
}
function stopServerTyping() {
  if (typingChannelId) {
    backend.stopTyping(typingChannelId);
    typingChannelId = null;
  }
}
var TURN_END_FILE = getTurnEndPath(INSTANCE_ID);
var TURN_END_BASENAME = path.basename(TURN_END_FILE);
var TURN_END_DIR = path.dirname(TURN_END_FILE);
removeFileIfExists(TURN_END_FILE);
var turnEndWatcher = fs.watch(TURN_END_DIR, async (_event, filename) => {
  if (filename !== TURN_END_BASENAME) return;
  try {
    const stat = fs.statSync(TURN_END_FILE);
    if (stat.size > 0) {
      stopServerTyping();
      await forwarder.forwardFinalText();
      removeFileIfExists(TURN_END_FILE);
    }
  } catch {
  }
});
var STATUS_FILE = getStatusPath(INSTANCE_ID);
var statusState = new JsonStateFile(STATUS_FILE, {});
statusState.ensure();
function sessionIdFromTranscriptPath(transcriptPath) {
  const base = path.basename(transcriptPath);
  return base.endsWith(".jsonl") ? base.slice(0, -6) : "";
}
function getPersistedTranscriptPath() {
  const state = statusState.read();
  if (typeof state.transcriptPath === "string" && state.transcriptPath) return state.transcriptPath;
  return readActiveInstance()?.transcriptPath ?? "";
}
function pickUsableTranscriptPath(bound, previousPath) {
  if (bound?.exists) return bound.transcriptPath;
  if (!previousPath) return "";
  if (!bound?.sessionId) return previousPath;
  return sessionIdFromTranscriptPath(previousPath) === bound.sessionId ? previousPath : "";
}
var forwarder = new OutputForwarder({
  send: async (ch, text) => {
    if (!channelBridgeActive) return;
    await backend.sendMessage(ch, text);
  },
  recordAssistantTurn: async () => {
  },
  react: (ch, mid, emoji) => {
    if (!channelBridgeActive) return Promise.resolve();
    return backend.react(ch, mid, emoji);
  },
  removeReaction: (ch, mid, emoji) => {
    if (!channelBridgeActive) return Promise.resolve();
    return backend.removeReaction(ch, mid, emoji);
  }
}, statusState);
forwarder.setOnIdle(() => {
  stopServerTyping();
  void forwarder.forwardFinalText();
});
function applyTranscriptBinding(channelId, transcriptPath, options = {}) {
  if (!transcriptPath) return;
  forwarder.setContext(channelId, transcriptPath, { replayFromStart: options.replayFromStart });
  forwarder.startWatch();
  void memoryIngestTranscript(transcriptPath);
  refreshActiveInstance(INSTANCE_ID, { channelId, transcriptPath });
  if (options.persistStatus !== false) {
    statusState.update((state) => {
      state.channelId = channelId;
      state.transcriptPath = transcriptPath;
    });
  }
}
async function rebindTranscriptContext(channelId, options = {}) {
  const previousPath = options.previousPath ?? "";
  const mode = options.mode ?? "same";
  let sawPendingTranscript = false;
  let pendingSessionId = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const bound = discoverSessionBoundTranscript();
    if (bound?.exists) {
      const acceptable = mode === "same" || !previousPath || bound.transcriptPath !== previousPath;
      if (acceptable) {
        const replayFromStart = Boolean(
          options.catchUp && !previousPath && sawPendingTranscript && pendingSessionId === bound.sessionId
        );
        applyTranscriptBinding(channelId, bound.transcriptPath, {
          replayFromStart,
          persistStatus: options.persistStatus
        });
        if (replayFromStart) {
          await forwarder.forwardNewText();
        }
        return bound.transcriptPath;
      }
    } else if (bound?.sessionId) {
      sawPendingTranscript = true;
      pendingSessionId = bound.sessionId;
    }
    await new Promise((resolve3) => setTimeout(resolve3, 150));
  }
  return previousPath;
}
var scheduler = new Scheduler(
  config.nonInteractive ?? [],
  config.interactive ?? [],
  config.proactive,
  config.channelsConfig,
  botConfig
);
var webhookServer = null;
if (config.webhook?.enabled) {
  webhookServer = new WebhookServer(config.webhook, config.channelsConfig ?? null);
  webhookServer.start();
}
var eventPipeline = new EventPipeline(config.events, config.channelsConfig);
if (config.webhook?.enabled || config.events?.rules?.length) eventPipeline.start();
var bridgeRuntimeConnected = false;
var bridgeOwnershipRefreshRunning = false;
var bridgeOwnershipTimer = null;
var lastOwnershipNote = "";
var ACTIVE_OWNER_STALE_MS = 1e4;
var proxyMode = false;
var ownerHttpPort = 0;
var ownerHttpServer = null;
var PROXY_PORT_MIN = 3460;
var PROXY_PORT_MAX = 3467;
async function proxyRequest(endpoint, method, body) {
  return new Promise((resolve3) => {
    const url = new URL(`http://127.0.0.1:${ownerHttpPort}${endpoint}`);
    const reqOpts = {
      hostname: "127.0.0.1",
      port: ownerHttpPort,
      path: url.pathname + url.search,
      method,
      headers: { "Content-Type": "application/json" },
      timeout: 3e4
    };
    const req = http2.request(reqOpts, (res) => {
      let data = "";
      res.on("data", (chunk2) => {
        data += chunk2;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve3({ ok: res.statusCode === 200, data: parsed, error: parsed.error });
        } catch {
          resolve3({ ok: false, error: `invalid response from owner: ${data.slice(0, 200)}` });
        }
      });
    });
    req.on("error", (err) => {
      resolve3({ ok: false, error: `proxy request failed: ${err.message}` });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve3({ ok: false, error: "proxy request timed out" });
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function pingOwner(port) {
  return new Promise((resolve3) => {
    const req = http2.request({
      hostname: "127.0.0.1",
      port,
      path: "/ping",
      method: "GET",
      timeout: 3e3
    }, (res) => {
      res.resume();
      resolve3(res.statusCode === 200);
    });
    req.on("error", () => resolve3(false));
    req.on("timeout", () => {
      req.destroy();
      resolve3(false);
    });
    req.end();
  });
}
function tryListenPort(server2, port) {
  return new Promise((resolve3) => {
    server2.once("error", () => resolve3(false));
    server2.listen(port, "127.0.0.1", () => resolve3(true));
  });
}
async function startOwnerHttpServer() {
  if (ownerHttpServer) return ownerHttpServer.address().port;
  const server2 = http2.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    let body = {};
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk2 of req) chunks.push(chunk2);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
    }
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      switch (url.pathname) {
        case "/ping": {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, instanceId: INSTANCE_ID, pid: process.pid }));
          return;
        }
        case "/send": {
          const sendResult = await backend.sendMessage(
            body.chatId,
            body.text,
            body.opts
          );
          res.writeHead(200);
          res.end(JSON.stringify({ sentIds: sendResult.sentIds }));
          return;
        }
        case "/react": {
          await backend.react(
            body.chatId,
            body.messageId,
            body.emoji
          );
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        case "/edit": {
          const editId = await backend.editMessage(
            body.chatId,
            body.messageId,
            body.text,
            body.opts
          );
          res.writeHead(200);
          res.end(JSON.stringify({ id: editId }));
          return;
        }
        case "/fetch": {
          const channelId = url.searchParams.get("channel") ?? "";
          const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
          const msgs = await backend.fetchMessages(channelId, limit);
          res.writeHead(200);
          res.end(JSON.stringify({ messages: msgs }));
          return;
        }
        case "/download": {
          const files = await backend.downloadAttachment(
            body.chatId,
            body.messageId
          );
          res.writeHead(200);
          res.end(JSON.stringify({ files }));
          return;
        }
        case "/typing/start": {
          backend.startTyping(body.channelId);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        case "/typing/stop": {
          backend.stopTyping(body.channelId);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        case "/inject": {
          const content = body.content;
          if (!content) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "content required" }));
            return;
          }
          const source = body.source || "trib-agent";
          const injMeta = { user: source, user_id: "system", ts: (/* @__PURE__ */ new Date()).toISOString() };
          if (body.instruction) injMeta.instruction = body.instruction;
          if (body.type) injMeta.type = body.type;
          void mcpServer.notification({
            method: "notifications/claude/channel",
            params: { content, meta: injMeta }
          }).catch(() => {
          });
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        case "/bridge/activate": {
          channelBridgeActive = Boolean(body.active);
          writeBridgeState(channelBridgeActive);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, active: channelBridgeActive }));
          return;
        }
        case "/mcp": {
          if (req.method === "POST") {
            const httpMcp = createHttpMcpServer();
            const httpTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: void 0,
              enableJsonResponse: true
            });
            res.on("close", () => {
              httpTransport.close();
              void httpMcp.close();
            });
            await httpMcp.connect(httpTransport);
            await httpTransport.handleRequest(req, res, body);
          } else {
            res.writeHead(405);
            res.end(JSON.stringify({ error: "Method not allowed" }));
          }
          return;
        }
        default: {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: msg }));
    }
  });
  for (let port = PROXY_PORT_MIN; port <= PROXY_PORT_MAX; port++) {
    if (await tryListenPort(server2, port)) {
      ownerHttpServer = server2;
      process.stderr.write(`trib-plugin: owner HTTP server listening on 127.0.0.1:${port}
`);
      return port;
    }
    server2.removeAllListeners("error");
  }
  throw new Error(`no available port in range ${PROXY_PORT_MIN}-${PROXY_PORT_MAX}`);
}
function stopOwnerHttpServer() {
  if (!ownerHttpServer) return;
  ownerHttpServer.close();
  ownerHttpServer = null;
}
function logOwnership(note) {
  if (lastOwnershipNote === note) return;
  lastOwnershipNote = note;
  process.stderr.write(`[ownership] ${note}
`);
}
function currentOwnerState() {
  const active = readActiveInstance();
  return {
    active,
    owned: active?.instanceId === INSTANCE_ID
  };
}
function getBridgeOwnershipSnapshot() {
  return currentOwnerState();
}
function canStealOwnership(active) {
  if (!active) return true;
  if (active.instanceId === INSTANCE_ID) return true;
  if (Date.now() - active.updatedAt > ACTIVE_OWNER_STALE_MS) return true;
  try {
    process.kill(active.pid, 0);
    return false;
  } catch {
    return true;
  }
}
function claimBridgeOwnership(reason) {
  refreshActiveInstance(INSTANCE_ID);
  logOwnership(`claimed owner (${reason})`);
}
function noteStartupHandoff(previous) {
  if (!previous) return;
  if (previous.instanceId === INSTANCE_ID) return;
  if (previous.pid === process.pid) return;
  logOwnership(`startup handoff from ${previous.instanceId}`);
}
function bindPersistedTranscriptIfAny() {
  const initBound = discoverSessionBoundTranscript();
  if (!initBound?.exists) return;
  let currentStatus = statusState.read();
  if (!currentStatus.channelId) {
    try {
      const files = fs.readdirSync(RUNTIME_ROOT).filter((f) => f.startsWith("status-") && f.endsWith(".json")).map((f) => {
        const full = path.join(RUNTIME_ROOT, f);
        return { path: full, mtime: fs.statSync(full).mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime);
      for (const { path: fp } of files) {
        try {
          const data = JSON.parse(fs.readFileSync(fp, "utf8"));
          if (data.channelId) {
            statusState.update((state) => {
              Object.assign(state, data);
            });
            currentStatus = statusState.read();
            process.stderr.write(`trib-plugin: restored status from ${fp}
`);
            break;
          }
        } catch {
        }
      }
    } catch {
    }
  }
  if (!currentStatus.channelId && channelBridgeActive) {
    const chCfg = config.channelsConfig;
    const mainLabel = config.mainChannel ?? "main";
    const mainEntry = chCfg?.channels?.[mainLabel] ?? chCfg?.[mainLabel];
    const mainId = mainEntry?.channelId ?? mainEntry?.id;
    if (mainId) {
      statusState.update((state) => {
        state.channelId = mainId;
      });
      currentStatus = statusState.read();
      process.stderr.write(`trib-plugin: auto-bound to main channel ${mainId}
`);
    }
  }
  if (!currentStatus.channelId) return;
  applyTranscriptBinding(currentStatus.channelId, initBound.transcriptPath);
  process.stderr.write(`trib-plugin: initial transcript bind: ${initBound.transcriptPath}
`);
}
async function startOwnedRuntime(options = {}) {
  if (bridgeRuntimeConnected) return;
  if (!channelBridgeActive) return;
  try {
    await backend.connect();
  } catch (e) {
    process.stderr.write(`trib-plugin: backend connect failed (non-fatal): ${e instanceof Error ? e.message : String(e)}
`);
    return;
  }
  bridgeRuntimeConnected = true;
  proxyMode = false;
  scheduler.start();
  if (webhookServer) webhookServer.start();
  eventPipeline.start();
  let httpPort;
  try {
    httpPort = await startOwnerHttpServer();
  } catch (e) {
    process.stderr.write(`trib-plugin: HTTP server start failed (non-fatal): ${e instanceof Error ? e.message : String(e)}
`);
  }
  refreshActiveInstance(INSTANCE_ID, httpPort ? { httpPort } : void 0);
  if (options.restoreBinding !== false) bindPersistedTranscriptIfAny();
  process.stderr.write(`trib-plugin: running with ${backend.name} backend
`);
  logOwnership(`active owner pid=${process.pid}`);
}
async function stopOwnedRuntime(reason) {
  if (!bridgeRuntimeConnected) return;
  stopServerTyping();
  stopOwnerHttpServer();
  scheduler.stop();
  if (webhookServer) webhookServer.stop();
  eventPipeline.stop();
  releaseOwnedChannelLocks(INSTANCE_ID);
  clearActiveInstance(INSTANCE_ID);
  await backend.disconnect();
  bridgeRuntimeConnected = false;
  logOwnership(`standby: ${reason}`);
}
async function refreshBridgeOwnership(options = {}) {
  if (bridgeOwnershipRefreshRunning) return;
  bridgeOwnershipRefreshRunning = true;
  try {
    if (!channelBridgeActive) {
      const { active: active2 } = currentOwnerState();
      if (active2?.httpPort && !proxyMode) {
        const alive = await pingOwner(active2.httpPort);
        if (alive) {
          proxyMode = true;
          ownerHttpPort = active2.httpPort;
          logOwnership(`non-channel session \u2014 proxy mode via ${active2.instanceId}`);
        }
      }
      return;
    }
    const { active, owned } = currentOwnerState();
    if (proxyMode && !owned && active?.httpPort) {
      const alive = await pingOwner(active.httpPort);
      if (!alive) {
        process.stderr.write(`[ownership] owner ping failed, attempting takeover
`);
        proxyMode = false;
        ownerHttpPort = 0;
        claimBridgeOwnership(`owner ${active.instanceId} unreachable`);
        const next2 = currentOwnerState();
        if (next2.owned) {
          refreshActiveInstance(INSTANCE_ID);
          await startOwnedRuntime(options);
        }
        return;
      }
      return;
    }
    if (!owned && canStealOwnership(active)) {
      if (active?.httpPort) {
        const alive = await pingOwner(active.httpPort);
        if (alive) {
          proxyMode = true;
          ownerHttpPort = active.httpPort;
          logOwnership(`proxy mode via owner ${active.instanceId} port ${active.httpPort}`);
          return;
        }
      }
      claimBridgeOwnership(active ? `takeover from ${active.instanceId}` : "startup");
    }
    const next = currentOwnerState();
    if (next.owned) {
      refreshActiveInstance(INSTANCE_ID);
      await startOwnedRuntime(options);
      return;
    }
    if (bridgeRuntimeConnected) {
      const reason = next.active?.instanceId ? `newer server ${next.active.instanceId}` : "no active owner";
      await stopOwnedRuntime(reason);
      return;
    }
    if (next.active?.httpPort && !proxyMode) {
      const alive = await pingOwner(next.active.httpPort);
      if (alive) {
        proxyMode = true;
        ownerHttpPort = next.active.httpPort;
        logOwnership(`proxy mode via owner ${next.active.instanceId} port ${next.active.httpPort}`);
        return;
      }
    }
    if (next.active?.instanceId) {
      logOwnership(`standby under owner ${next.active.instanceId}`);
    }
  } finally {
    bridgeOwnershipRefreshRunning = false;
  }
}
function reloadRuntimeConfig() {
  config = loadConfig();
  botConfig = loadBotConfig();
  scheduler.reloadConfig(
    config.nonInteractive ?? [],
    config.interactive ?? [],
    config.proactive,
    config.channelsConfig,
    botConfig,
    { restart: bridgeRuntimeConnected }
  );
  if (config.webhook?.enabled) {
    if (webhookServer) {
      webhookServer.reloadConfig(config.webhook, config.channelsConfig ?? null, {
        autoStart: bridgeRuntimeConnected
      });
    } else {
      webhookServer = new WebhookServer(config.webhook, config.channelsConfig ?? null);
      wireWebhookHandlers();
      if (bridgeRuntimeConnected) webhookServer.start();
    }
  } else if (webhookServer) {
    webhookServer.stop();
    webhookServer = null;
  }
  eventPipeline.reloadConfig(config.events, config.channelsConfig);
}
scheduler.setInjectHandler((channelId, name, content, options) => {
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const now = /* @__PURE__ */ new Date();
  const timeLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} `;
  const sourceLabel = options?.type ? `${timeLabel}: ${options.type}` : timeLabel;
  const meta = {
    chat_id: channelId,
    user: sourceLabel,
    user_id: "system",
    ts
  };
  if (options?.instruction) meta.instruction = options.instruction;
  if (options?.type) meta.type = options.type;
  void mcpServer.notification({
    method: "notifications/claude/channel",
    params: { content, meta }
  }).catch((e) => {
    process.stderr.write(`trib-plugin: notification failed: ${e}
`);
  });
  void memoryAppendEpisode({
    ts,
    backend: backend.name,
    channelId,
    userId: "system",
    userName: `schedule:${name}`,
    sessionId: null,
    role: "user",
    kind: "schedule-inject",
    content: options?.instruction || content,
    sourceRef: `schedule:${name}:${ts}`
  });
});
scheduler.setSendHandler(async (channelId, text) => {
  await backend.sendMessage(channelId, text);
  void memoryAppendEpisode({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    backend: backend.name,
    channelId,
    userId: "assistant",
    userName: "assistant",
    sessionId: null,
    role: "assistant",
    kind: "schedule-send",
    content: text,
    sourceRef: `schedule-send:${channelId}:${Date.now()}`
  });
});
scheduler.setProactiveHandlers(
  async () => {
    const [memory, sources] = await Promise.all([
      getProactiveContext(),
      getProactiveSources()
    ]);
    return { memory, sources };
  },
  (updates) => {
    void applyProactiveUpdates(updates);
  }
);
function wireWebhookHandlers() {
  if (!webhookServer) return;
  webhookServer.setEventPipeline(eventPipeline);
}
wireWebhookHandlers();
var eventQueue = eventPipeline.getQueue();
eventQueue.setInjectHandler((channelId, name, content, options) => {
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const now = /* @__PURE__ */ new Date();
  const timeLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} `;
  const sourceLabel = options?.type ? `${timeLabel}: ${options.type}` : timeLabel;
  const meta = {
    chat_id: channelId,
    user: sourceLabel,
    user_id: "system",
    ts
  };
  if (options?.instruction) meta.instruction = options.instruction;
  if (options?.type) meta.type = options.type;
  void mcpServer.notification({
    method: "notifications/claude/channel",
    params: { content, meta }
  }).catch((e) => {
    try {
      process.stderr.write(`trib-plugin event: notification failed: ${e}
`);
    } catch {
    }
  });
  void memoryAppendEpisode({
    ts,
    backend: backend.name,
    channelId,
    userId: "system",
    userName: `event:${name}`,
    sessionId: null,
    role: "user",
    kind: "event-inject",
    content: options?.instruction || content,
    sourceRef: `event:${name}:${ts}`
  });
});
eventQueue.setSendHandler(async (channelId, text) => {
  await backend.sendMessage(channelId, text);
  void memoryAppendEpisode({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    backend: backend.name,
    channelId,
    userId: "assistant",
    userName: "assistant",
    sessionId: null,
    role: "assistant",
    kind: "event-send",
    content: text,
    sourceRef: `event-send:${channelId}:${Date.now()}`
  });
});
eventQueue.setSessionStateGetter(() => scheduler.getSessionState());
function editDiscordMessage(channelId, messageId, label) {
  const token = config.discord?.token;
  if (!token) return;
  const body = JSON.stringify({
    content: `\u{1F510} **Permission Request** \u2014 ${label}`,
    components: []
  });
  const req = https.request({
    hostname: "discord.com",
    path: `/api/v10/channels/${channelId}/messages/${messageId}`,
    method: "PATCH",
    headers: {
      "Authorization": `Bot ${token}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  }, (res) => {
    res.resume();
    res.on("end", () => {
    });
  });
  req.on("error", (err) => {
    process.stderr.write(`trib-plugin: editDiscordMessage failed: ${err}
`);
  });
  req.write(body);
  req.end();
}
backend.onModalRequest = async (rawInteraction) => {
  if (!bridgeRuntimeConnected || !getBridgeOwnershipSnapshot().owned) {
    void refreshBridgeOwnership();
    return;
  }
  const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = await import("discord.js");
  const customId = rawInteraction.customId;
  const channelId = rawInteraction.channelId ?? "";
  pendingSetup.rememberMessage(rawInteraction.user.id, channelId, rawInteraction.message?.id);
  const modalSpec = buildModalRequestSpec(
    customId,
    pendingSetup.get(rawInteraction.user.id, channelId),
    loadProfileConfig()
  );
  if (!modalSpec) return;
  const modal = new ModalBuilder().setCustomId(modalSpec.customId).setTitle(modalSpec.title);
  const rows = modalSpec.fields.map(
    (field) => new ActionRowBuilder().addComponents((() => {
      const input = new TextInputBuilder().setCustomId(field.id).setLabel(field.label).setStyle(TextInputStyle.Short).setRequired(field.required);
      if (field.value) input.setValue(field.value);
      return input;
    })())
  );
  modal.addComponents(...rows);
  await rawInteraction.showModal(modal);
};
backend.onInteraction = (interaction) => {
  if (interaction.customId?.startsWith("perm-")) {
    const match = interaction.customId.match(/^perm-([0-9a-f]{32})-(allow|session|deny)$/);
    if (!match) return;
    const [, uuid, action] = match;
    const access = config.access;
    if (!access) {
      fs.appendFileSync(_bootLog, `[${localTimestamp()}] perm interaction dropped: no access config
`);
      return;
    }
    if (access.allowFrom?.length > 0 && !access.allowFrom.includes(interaction.userId)) {
      process.stderr.write(`trib-plugin: perm button rejected \u2014 user ${interaction.userId} not in allowFrom
`);
      return;
    }
    const resultPath = getPermissionResultPath(INSTANCE_ID, uuid);
    if (!fs.existsSync(resultPath)) {
      fs.writeFileSync(resultPath, action);
    }
    const labels = { allow: "Approved", session: "Session Approved", deny: "Denied" };
    if (interaction.message?.id && interaction.channelId) {
      editDiscordMessage(interaction.channelId, interaction.message.id, labels[action] || action);
    }
    return;
  }
  if (!bridgeRuntimeConnected || !getBridgeOwnershipSnapshot().owned) {
    void refreshBridgeOwnership();
    return;
  }
  scheduler.noteActivity();
  if (interaction.customId === "stop_task") {
    void controlClaudeSession(INSTANCE_ID, { type: "interrupt" });
    writeTextFile(TURN_END_FILE, String(Date.now()));
    return;
  }
  void mcpServer.notification({
    method: "notifications/claude/channel",
    params: {
      content: `[interaction] ${interaction.type}: ${interaction.customId}${interaction.values ? " values=" + interaction.values.join(",") : ""}`,
      meta: {
        chat_id: interaction.channelId,
        user: `interaction:${interaction.type}`,
        user_id: interaction.userId,
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        interaction_type: interaction.type,
        custom_id: interaction.customId,
        ...interaction.values ? { values: interaction.values.join(",") } : {},
        ...interaction.message ? { message_id: interaction.message.id } : {}
      }
    }
  }).catch((e) => {
    process.stderr.write(`trib-plugin: notification failed: ${e}
`);
  });
};
function isVoiceAttachment(contentType) {
  return contentType.startsWith("audio/") || contentType === "application/ogg";
}
function runCmd(cmd, args, capture = false) {
  return new Promise((resolve3, reject) => {
    const proc = spawn5(cmd, args, {
      stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore"
    });
    let out = "";
    if (capture && proc.stdout) proc.stdout.on("data", (d) => {
      out += d;
    });
    proc.on("close", (code) => code === 0 ? resolve3(out) : reject(new Error(`${cmd} exit ${code}`)));
    proc.on("error", reject);
  });
}
var resolvedWhisperCmd = null;
var resolvedWhisperModel = null;
var resolvedWhisperLanguage = null;
var resolvedWhisperType = null;
var whichCmd = process.platform === "win32" ? "where" : "which";
function firstNonEmptyLine(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}
function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}
function normalizeWhisperLanguage(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return null;
  if (raw.startsWith("ko")) return "ko";
  if (raw.startsWith("ja")) return "ja";
  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("zh")) return "zh";
  if (raw.startsWith("de")) return "de";
  if (raw.startsWith("fr")) return "fr";
  if (raw.startsWith("es")) return "es";
  if (raw.startsWith("it")) return "it";
  if (raw.startsWith("pt")) return "pt";
  if (raw.startsWith("ru")) return "ru";
  return raw;
}
function detectDeviceLanguage() {
  if (resolvedWhisperLanguage) return resolvedWhisperLanguage;
  const candidates = [
    process.env.TRIB_CHANNELS_WHISPER_LANGUAGE,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale
  ];
  for (const candidate of candidates) {
    const normalized = normalizeWhisperLanguage(candidate);
    if (normalized) {
      resolvedWhisperLanguage = normalized;
      return normalized;
    }
  }
  resolvedWhisperLanguage = "auto";
  return resolvedWhisperLanguage;
}
async function resolveCommandPath(command) {
  const out = await runCmd(whichCmd, [command], true);
  const resolved = firstNonEmptyLine(out);
  if (!resolved) {
    throw new Error(`command not found: ${command}`);
  }
  return resolved;
}
async function detectWhisperType(cmd) {
  if (resolvedWhisperType) return resolvedWhisperType;
  try {
    const out = await runCmd(cmd, ["--help"], true);
    resolvedWhisperType = out.includes("openai") || out.includes("output_format") || out.includes("output_dir") ? "python" : "cpp";
  } catch {
    const lower = cmd.toLowerCase();
    resolvedWhisperType = lower.includes("python") || lower.includes("scripts") ? "python" : "cpp";
  }
  return resolvedWhisperType;
}
async function findWhisper(override) {
  if (override) {
    if (override.includes(path.sep) || override.includes("/")) {
      if (!fileExists(override)) {
        throw new Error(`configured whisper command not found: ${override}`);
      }
      return override;
    }
    return resolveCommandPath(override);
  }
  if (resolvedWhisperCmd && fileExists(resolvedWhisperCmd)) return resolvedWhisperCmd;
  for (const candidate of ["whisper-cli", "whisper", "whisper.cpp"]) {
    try {
      resolvedWhisperCmd = await resolveCommandPath(candidate);
      return resolvedWhisperCmd;
    } catch {
    }
  }
  throw new Error("whisper not found in PATH \u2014 install whisper.cpp or openai-whisper, or set voice.command in config");
}
function candidateModelDirs(whisperCmd) {
  const home = os.homedir();
  const whisperDir = path.dirname(whisperCmd);
  const dirs = [
    process.env.TRIB_CHANNELS_WHISPER_MODEL_DIR,
    process.env.WHISPER_MODEL_DIR,
    process.env.WHISPER_CPP_MODEL_DIR,
    config.voice?.model && !config.voice.model.endsWith(".bin") ? config.voice.model : "",
    path.join(DATA_DIR, "voice", "models"),
    path.join(DATA_DIR, "models"),
    path.join(process.cwd(), "models"),
    path.join(path.dirname(process.cwd()), "models"),
    path.join(home, ".cache", "whisper"),
    path.join(home, ".local", "share", "whisper"),
    path.join(home, ".local", "share", "whisper.cpp", "models"),
    path.join(home, "whisper.cpp", "models"),
    path.join(whisperDir, "models"),
    path.join(whisperDir, "..", "models"),
    "/opt/homebrew/share/whisper",
    "/usr/local/share/whisper"
  ];
  if (process.platform === "win32") {
    dirs.push(
      path.join(home, "AppData", "Local", "whisper"),
      path.join(home, "AppData", "Local", "whisper.cpp", "models"),
      path.join(home, "scoop", "persist", "whisper.cpp", "models")
    );
  }
  return dirs.filter((value) => Boolean(value)).map((value) => path.resolve(value)).filter((value, index, arr) => arr.indexOf(value) === index);
}
async function findWhisperModel(override, whisperCmd) {
  if (override) {
    const resolvedOverride = path.resolve(override);
    if (!fileExists(resolvedOverride)) {
      throw new Error(`configured whisper model not found: ${resolvedOverride}`);
    }
    return resolvedOverride;
  }
  if (resolvedWhisperModel && fileExists(resolvedWhisperModel)) {
    return resolvedWhisperModel;
  }
  const directEnv = [
    process.env.TRIB_CHANNELS_WHISPER_MODEL,
    process.env.WHISPER_MODEL
  ].filter((value) => Boolean(value));
  for (const filePath of directEnv) {
    const resolved = path.resolve(filePath);
    if (fileExists(resolved)) {
      resolvedWhisperModel = resolved;
      return resolved;
    }
  }
  const candidateNames = [
    "ggml-large-v3-turbo.bin",
    "ggml-large-v3.bin",
    "ggml-medium.bin",
    "ggml-base.bin",
    "ggml-base.en.bin"
  ];
  for (const dir of candidateModelDirs(whisperCmd)) {
    for (const name of candidateNames) {
      const candidate = path.join(dir, name);
      if (fileExists(candidate)) {
        resolvedWhisperModel = candidate;
        return candidate;
      }
    }
  }
  throw new Error("whisper model not found \u2014 set voice.model in config or place a GGML model in a standard models directory");
}
async function transcribeVoice(audioPath) {
  try {
    const whisperCmd = await findWhisper(config.voice?.command);
    const type = await detectWhisperType(whisperCmd);
    const lang = normalizeWhisperLanguage(config.voice?.language) ?? detectDeviceLanguage();
    if (type === "python") {
      const tmpDir = path.join(os.tmpdir(), "trib-whisper");
      await fs.promises.mkdir(tmpDir, { recursive: true });
      const args2 = [audioPath, "--output_format", "txt", "--output_dir", tmpDir];
      if (lang && lang !== "auto") args2.push("--language", lang);
      const model = config.voice?.pythonModel ?? config.voice?.model ?? "turbo";
      if (model && !model.endsWith(".bin")) args2.push("--model", model);
      await runCmd(whisperCmd, args2);
      const baseName = path.basename(audioPath).replace(/\.[^.]+$/, "");
      const txtPath = path.join(tmpDir, `${baseName}.txt`);
      const text2 = await fs.promises.readFile(txtPath, "utf-8");
      return text2.trim() || null;
    }
    const wavPath = audioPath.replace(/\.[^.]+$/, ".wav");
    await runCmd("ffmpeg", ["-i", audioPath, "-ar", "16000", "-ac", "1", "-y", wavPath]);
    const modelPath = await findWhisperModel(config.voice?.model, whisperCmd);
    const args = ["-f", wavPath, "--no-timestamps"];
    if (lang && lang !== "auto") args.push("-l", lang);
    args.push("-m", modelPath);
    const text = await runCmd(whisperCmd, args, true);
    return text.trim() || null;
  } catch (err) {
    process.stderr.write(`trib-plugin: transcribeVoice failed: ${err}
`);
    return null;
  }
}
var TOOL_DEFS = [
  {
    name: "reply",
    title: "Discord Reply",
    annotations: { title: "Discord Reply", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Reply on the messaging channel. Pass chat_id from the inbound message. Optionally pass reply_to, files, embeds, and components (buttons, selects, etc).",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel ID where the message will be sent" },
        text: { type: "string", description: "Message text content (markdown supported)" },
        reply_to: {
          type: "string",
          description: "Message ID to thread under. Use message_id from the inbound <channel> block, or an id from fetch."
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Absolute file paths to attach (images, logs, etc). Max 10 files, 25MB each."
        },
        embeds: {
          type: "array",
          items: { type: "object" },
          description: "Discord embed objects. Fields: title, description, color (int), fields [{name, value, inline}], footer {text}, timestamp."
        },
        components: {
          type: "array",
          items: { type: "object" },
          description: "Discord message components. Use Action Rows containing Buttons, Select Menus, etc. See Discord Components V2 docs."
        }
      },
      required: ["chat_id", "text"]
    }
  },
  {
    name: "react",
    title: "Reaction",
    annotations: { title: "Reaction", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Add an emoji reaction to a message. Unicode emoji work directly; custom emoji need the <:name:id> form.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel ID containing the message" },
        message_id: { type: "string", description: "ID of the message to react to" },
        emoji: { type: "string", description: 'Unicode emoji (e.g. "\u{1F44D}") or custom emoji in <:name:id> format' }
      },
      required: ["chat_id", "message_id", "emoji"]
    }
  },
  {
    name: "edit_message",
    title: "Edit Message",
    annotations: { title: "Edit Message", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Edit a message the bot previously sent. Supports text, embeds, and components.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel ID containing the message" },
        message_id: { type: "string", description: "ID of the bot message to edit" },
        text: { type: "string", description: "New message text content" },
        embeds: {
          type: "array",
          items: { type: "object" },
          description: "Discord embed objects."
        },
        components: {
          type: "array",
          items: { type: "object" },
          description: "Discord message components."
        }
      },
      required: ["chat_id", "message_id", "text"]
    }
  },
  {
    name: "download_attachment",
    title: "Download Attachment",
    annotations: { title: "Download Attachment", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Download attachments from a message to the local inbox. Use after fetch shows a message has attachments (marked with +Natt). Returns file paths ready to Read.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel ID containing the message" },
        message_id: { type: "string", description: "ID of the message with attachments" }
      },
      required: ["chat_id", "message_id"]
    }
  },
  {
    name: "fetch",
    title: "Fetch",
    annotations: { title: "Fetch", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Fetch recent messages from a channel. Returns oldest-first with message IDs. The platform's search API isn't exposed to bots, so this is the only way to look back.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: 'Channel name label (e.g. "main", "general") as configured in channelsConfig' },
        limit: {
          type: "number",
          description: "Max messages (default 20, capped at 100)."
        }
      },
      required: ["channel"]
    }
  },
  {
    name: "schedule_status",
    title: "Schedule Status",
    annotations: { title: "Schedule Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Show all configured schedules, their next fire time, and whether they are currently running.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "trigger_schedule",
    title: "Trigger Schedule",
    annotations: { title: "Trigger Schedule", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Manually trigger a named schedule immediately, ignoring time/day constraints.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Schedule name to trigger" }
      },
      required: ["name"]
    }
  },
  {
    name: "schedule_control",
    title: "Schedule Control",
    annotations: { title: "Schedule Control", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Defer or skip a schedule. Use "defer" to suppress for N minutes (default 30), or "skip_today" to suppress for the rest of the day.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Schedule name (e.g. "mail-briefing" or "proactive:chat")' },
        action: { type: "string", enum: ["defer", "skip_today"], description: "Action to take" },
        minutes: { type: "number", description: "Defer duration in minutes (default 30, only for defer action)" }
      },
      required: ["name", "action"]
    }
  },
  {
    name: "activate_channel_bridge",
    title: "Activate Channel Bridge",
    annotations: { title: "Activate Channel Bridge", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Activate or deactivate the channel bridge. When active, inbound messages trigger typing indicators, emoji reactions, and auto-forwarding of transcript output to Discord. When inactive, only direct MCP tool calls (reply, fetch) work.",
    inputSchema: {
      type: "object",
      properties: {
        active: { type: "boolean", description: "true to activate, false to deactivate" }
      },
      required: ["active"]
    }
  },
  // memory_cycle and recall_memory tools are now provided by memory-service.mjs via MCP
  {
    name: "reload_config",
    title: "Reload Config",
    annotations: { title: "Reload Config", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Reload config from disk and re-register all schedules, webhooks, and event rules without restarting.",
    inputSchema: { type: "object", properties: {} }
  }
];
function createHttpMcpServer() {
  const s = new Server(
    { name: "trib-plugin", version: PLUGIN_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    const args = req.params.arguments ?? {};
    try {
      switch (toolName) {
        case "reply": {
          const sendResult = await backend.sendMessage(
            args.chat_id,
            args.text,
            { replyTo: args.reply_to, files: args.files ?? [], embeds: args.embeds ?? [], components: args.components ?? [] }
          );
          return { content: [{ type: "text", text: JSON.stringify({ sentIds: sendResult.sentIds }) }] };
        }
        case "react": {
          await backend.react(args.chat_id, args.message_id, args.emoji);
          return { content: [{ type: "text", text: "ok" }] };
        }
        case "edit_message": {
          const editId = await backend.editMessage(args.chat_id, args.message_id, args.text, { embeds: args.embeds ?? [], components: args.components ?? [] });
          return { content: [{ type: "text", text: JSON.stringify({ id: editId }) }] };
        }
        case "fetch": {
          const msgs = await backend.fetchMessages(args.channel, args.limit ?? 20);
          return { content: [{ type: "text", text: JSON.stringify({ messages: msgs }) }] };
        }
        case "download_attachment": {
          const files = await backend.downloadAttachment(args.chat_id, args.message_id);
          return { content: [{ type: "text", text: JSON.stringify({ files }) }] };
        }
        case "schedule_status": {
          const statuses = scheduler.getStatus();
          return { content: [{ type: "text", text: statuses.length ? statuses.map((st) => `${st.name} ${st.time} ${st.days} (${st.type})${st.running ? " [RUNNING]" : ""}`).join("\n") : "no schedules configured" }] };
        }
        case "trigger_schedule": {
          const triggerResult = await scheduler.triggerManual(args.name);
          return { content: [{ type: "text", text: triggerResult }] };
        }
        case "schedule_control": {
          const action = args.action;
          if (action === "defer") {
            scheduler.defer(args.name, args.minutes ?? 30);
            return { content: [{ type: "text", text: `deferred "${args.name}" for ${args.minutes ?? 30} minutes` }] };
          } else if (action === "skip_today") {
            scheduler.skipToday(args.name);
            return { content: [{ type: "text", text: `skipped "${args.name}" for today` }] };
          }
          return { content: [{ type: "text", text: `unknown action: ${action}` }], isError: true };
        }
        case "activate_channel_bridge": {
          const active = args.active === true;
          channelBridgeActive = active;
          writeBridgeState(active);
          if (active) void refreshBridgeOwnership({ restoreBinding: true });
          return { content: [{ type: "text", text: `channel bridge ${active ? "activated" : "deactivated"}` }] };
        }
        case "reload_config": {
          reloadRuntimeConfig();
          return { content: [{ type: "text", text: "config reloaded \u2014 schedules, webhooks, and events re-registered" }] };
        }
        default:
          return { content: [{ type: "text", text: `unknown tool: ${toolName}` }], isError: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `${toolName} failed: ${msg}` }], isError: true };
    }
  });
  return s;
}
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
var BACKEND_TOOLS = /* @__PURE__ */ new Set(["reply", "fetch", "react", "edit_message", "download_attachment"]);
async function handleToolCall(name, args) {
  let result;
  try {
    if (proxyMode && BACKEND_TOOLS.has(name)) {
      let proxyResult;
      switch (name) {
        case "reply": {
          proxyResult = await proxyRequest("/send", "POST", {
            chatId: args.chat_id,
            text: args.text,
            opts: {
              replyTo: args.reply_to,
              files: args.files ?? [],
              embeds: args.embeds ?? [],
              components: args.components ?? []
            }
          });
          if (!proxyResult.ok) {
            result = { content: [{ type: "text", text: `proxy reply failed: ${proxyResult.error}` }], isError: true };
          } else {
            const ids = proxyResult.data?.sentIds ?? [];
            const text = ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(", ")})`;
            result = { content: [{ type: "text", text }] };
          }
          break;
        }
        case "fetch": {
          let channelId = args.channel;
          const channelEntry = config.channelsConfig?.channels?.[channelId];
          if (channelEntry) channelId = channelEntry.id;
          const limit = args.limit ?? 20;
          proxyResult = await proxyRequest(`/fetch?channel=${encodeURIComponent(channelId)}&limit=${limit}`, "GET");
          if (!proxyResult.ok) {
            result = { content: [{ type: "text", text: `proxy fetch failed: ${proxyResult.error}` }], isError: true };
          } else {
            const msgs = proxyResult.data?.messages ?? [];
            const text = msgs.length === 0 ? "(no messages)" : msgs.map((m) => {
              const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : "";
              return `[${m.ts}] ${m.user}: ${m.text}  (id: ${m.id}${atts})`;
            }).join("\n");
            result = { content: [{ type: "text", text }] };
          }
          break;
        }
        case "react": {
          proxyResult = await proxyRequest("/react", "POST", {
            chatId: args.chat_id,
            messageId: args.message_id,
            emoji: args.emoji
          });
          if (!proxyResult.ok) {
            result = { content: [{ type: "text", text: `proxy react failed: ${proxyResult.error}` }], isError: true };
          } else {
            result = { content: [{ type: "text", text: "reacted" }] };
          }
          break;
        }
        case "edit_message": {
          proxyResult = await proxyRequest("/edit", "POST", {
            chatId: args.chat_id,
            messageId: args.message_id,
            text: args.text,
            opts: {
              embeds: args.embeds ?? [],
              components: args.components ?? []
            }
          });
          if (!proxyResult.ok) {
            result = { content: [{ type: "text", text: `proxy edit failed: ${proxyResult.error}` }], isError: true };
          } else {
            result = { content: [{ type: "text", text: `edited (id: ${proxyResult.data?.id})` }] };
          }
          break;
        }
        case "download_attachment": {
          proxyResult = await proxyRequest("/download", "POST", {
            chatId: args.chat_id,
            messageId: args.message_id
          });
          if (!proxyResult.ok) {
            result = { content: [{ type: "text", text: `proxy download failed: ${proxyResult.error}` }], isError: true };
          } else {
            const files = proxyResult.data?.files ?? [];
            if (files.length === 0) {
              result = { content: [{ type: "text", text: "message has no attachments" }] };
            } else {
              const lines = files.map(
                (f) => `  ${f.path}  (${f.name}, ${f.contentType}, ${(f.size / 1024).toFixed(0)}KB)`
              );
              result = { content: [{ type: "text", text: `downloaded ${files.length} attachment(s):
${lines.join("\n")}` }] };
            }
          }
          break;
        }
        default:
          result = { content: [{ type: "text", text: `unknown proxy tool: ${name}` }], isError: true };
      }
    } else {
      switch (name) {
        case "reply": {
          const sendResult = await backend.sendMessage(
            args.chat_id,
            args.text,
            {
              replyTo: args.reply_to,
              files: args.files ?? [],
              embeds: args.embeds ?? [],
              components: args.components ?? []
            }
          );
          const text = sendResult.sentIds.length === 1 ? `sent (id: ${sendResult.sentIds[0]})` : `sent ${sendResult.sentIds.length} parts (ids: ${sendResult.sentIds.join(", ")})`;
          result = { content: [{ type: "text", text }] };
          break;
        }
        case "fetch": {
          let channelId = args.channel;
          const channelEntry = config.channelsConfig?.channels?.[channelId];
          if (channelEntry) channelId = channelEntry.id;
          const msgs = await backend.fetchMessages(
            channelId,
            args.limit ?? 20
          );
          const text = msgs.length === 0 ? "(no messages)" : msgs.map((m) => {
            const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : "";
            return `[${m.ts}] ${m.user}: ${m.text}  (id: ${m.id}${atts})`;
          }).join("\n");
          result = { content: [{ type: "text", text }] };
          break;
        }
        case "react": {
          await backend.react(
            args.chat_id,
            args.message_id,
            args.emoji
          );
          result = { content: [{ type: "text", text: "reacted" }] };
          break;
        }
        case "edit_message": {
          const id = await backend.editMessage(
            args.chat_id,
            args.message_id,
            args.text,
            {
              embeds: args.embeds ?? [],
              components: args.components ?? []
            }
          );
          result = { content: [{ type: "text", text: `edited (id: ${id})` }] };
          break;
        }
        case "download_attachment": {
          const files = await backend.downloadAttachment(
            args.chat_id,
            args.message_id
          );
          if (files.length === 0) {
            result = { content: [{ type: "text", text: "message has no attachments" }] };
          } else {
            const lines = files.map(
              (f) => `  ${f.path}  (${f.name}, ${f.contentType}, ${(f.size / 1024).toFixed(0)}KB)`
            );
            result = {
              content: [{ type: "text", text: `downloaded ${files.length} attachment(s):
${lines.join("\n")}` }]
            };
          }
          break;
        }
        case "schedule_status": {
          const statuses = scheduler.getStatus();
          if (statuses.length === 0) {
            result = { content: [{ type: "text", text: "no schedules configured" }] };
          } else {
            const lines = statuses.map((s) => {
              const state = s.running ? " [RUNNING]" : "";
              const last = s.lastFired ? ` (last: ${s.lastFired})` : "";
              return `  ${s.name}  ${s.time} ${s.days} (${s.type})${state}${last}`;
            });
            result = { content: [{ type: "text", text: lines.join("\n") }] };
          }
          break;
        }
        case "trigger_schedule": {
          const triggerResult = await scheduler.triggerManual(args.name);
          result = { content: [{ type: "text", text: triggerResult }] };
          break;
        }
        case "schedule_control": {
          const scName = args.name;
          const action = args.action;
          if (action === "defer") {
            const minutes = args.minutes ?? 30;
            scheduler.defer(scName, minutes);
            result = { content: [{ type: "text", text: `deferred "${scName}" for ${minutes} minutes` }] };
          } else if (action === "skip_today") {
            scheduler.skipToday(scName);
            result = { content: [{ type: "text", text: `skipped "${scName}" for today` }] };
          } else {
            result = { content: [{ type: "text", text: `unknown action: ${action}` }], isError: true };
          }
          break;
        }
        case "activate_channel_bridge": {
          if (proxyMode) {
            const proxyRes = await proxyRequest("/bridge/activate", "POST", { active: args.active === true });
            if (!proxyRes.ok) {
              result = { content: [{ type: "text", text: `proxy bridge activate failed: ${proxyRes.error}` }], isError: true };
            } else {
              channelBridgeActive = Boolean(args.active);
              writeBridgeState(channelBridgeActive);
              result = { content: [{ type: "text", text: `channel bridge ${args.active ? "activated" : "deactivated"}` }] };
            }
          } else {
            const active = args.active === true;
            const wasActive = channelBridgeActive;
            channelBridgeActive = active;
            writeBridgeState(active);
            if (active && !wasActive) {
              void refreshBridgeOwnership({ restoreBinding: true });
            }
            if (!active && wasActive) {
              stopServerTyping();
            }
            result = { content: [{ type: "text", text: `channel bridge ${active ? "activated" : "deactivated"}` }] };
          }
          break;
        }
        case "reload_config": {
          reloadRuntimeConfig();
          result = { content: [{ type: "text", text: "config reloaded \u2014 schedules, webhooks, and events re-registered" }] };
          break;
        }
        // memory_cycle — handled by memory-service.mjs MCP
        default:
          result = {
            content: [{ type: "text", text: `unknown tool: ${name}` }],
            isError: true
          };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      content: [{ type: "text", text: `${name} failed: ${msg}` }],
      isError: true
    };
  }
  return result;
}
mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  await forwarder.forwardNewText();
  const toolName = req.params.name;
  const args = req.params.arguments ?? {};
  if (BACKEND_TOOLS.has(toolName) && !bridgeRuntimeConnected && !proxyMode) {
    if (!currentOwnerState().owned) claimBridgeOwnership("tool call");
    for (let i = 0; i < 2 && !bridgeRuntimeConnected && !proxyMode; i++) {
      try {
        await refreshBridgeOwnership();
      } catch {
      }
      if (!bridgeRuntimeConnected && !proxyMode) await new Promise((r) => setTimeout(r, 300));
    }
    if (!bridgeRuntimeConnected && !proxyMode) {
      return {
        content: [{ type: "text", text: `Discord auto-connect failed after retries. Check token and network.` }],
        isError: true
      };
    }
  }
  const result = await handleToolCall(toolName, args);
  const toolLine = OutputForwarder.buildToolLine(toolName, args);
  if (toolLine) {
    void forwarder.forwardToolLog(toolLine);
  }
  return result;
});
var INBOUND_DEDUP_TTL = 5 * 6e4;
var inboundSeen = /* @__PURE__ */ new Map();
var INBOUND_DEDUP_DIR = path.join(os.tmpdir(), "trib-plugin-inbound");
ensureDir(INBOUND_DEDUP_DIR);
function claimChannelOwner(channelId) {
  const ownerPath = getChannelOwnerPath(channelId);
  try {
    fs.writeFileSync(ownerPath, JSON.stringify({ instanceId: INSTANCE_ID, pid: process.pid, updatedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}
function shouldDropDuplicateInbound(msg) {
  const key = `${msg.chatId}:${msg.messageId}`;
  const now = Date.now();
  if (inboundSeen.has(key) && now - inboundSeen.get(key) < INBOUND_DEDUP_TTL) return true;
  inboundSeen.set(key, now);
  const marker = path.join(INBOUND_DEDUP_DIR, key.replace(/:/g, "_"));
  try {
    const stat = fs.statSync(marker);
    if (now - stat.mtimeMs < INBOUND_DEDUP_TTL) return true;
  } catch {
  }
  writeTextFile(marker, String(now));
  if (Math.random() < 0.1) {
    try {
      for (const f of fs.readdirSync(INBOUND_DEDUP_DIR)) {
        const fp = path.join(INBOUND_DEDUP_DIR, f);
        try {
          if (now - fs.statSync(fp).mtimeMs > INBOUND_DEDUP_TTL) removeFileIfExists(fp);
        } catch {
        }
      }
    } catch {
    }
  }
  for (const [k, t] of inboundSeen) {
    if (now - t > INBOUND_DEDUP_TTL) inboundSeen.delete(k);
  }
  return false;
}
function resolveInboundRoute(chatId) {
  const channels = config.channelsConfig?.channels ?? {};
  const sourceEntry = Object.entries(channels).find(([, entry]) => entry.id === chatId);
  const sourceLabel = sourceEntry?.[0];
  const sourceMode = sourceEntry?.[1].mode ?? "interactive";
  return {
    targetChatId: chatId,
    sourceChatId: chatId,
    sourceLabel,
    sourceMode
  };
}
var inboundQueue = (() => {
  let tail = Promise.resolve();
  return (fn) => {
    tail = tail.then(fn, fn);
  };
})();
backend.onMessage = (msg) => {
  if (!bridgeRuntimeConnected || !getBridgeOwnershipSnapshot().owned) {
    void refreshBridgeOwnership();
    return;
  }
  if (!channelBridgeActive) return;
  if (shouldDropDuplicateInbound(msg)) return;
  if (!claimChannelOwner(msg.chatId)) return;
  const route = resolveInboundRoute(msg.chatId);
  scheduler.noteActivity();
  eventPipeline.handleMessage(msg.text, msg.user, msg.chatId, false);
  startServerTyping(route.targetChatId);
  backend.resetSendCount();
  void forwarder.forwardFinalText();
  forwarder.reset();
  const previousPath = getPersistedTranscriptPath();
  const boundTranscript = discoverSessionBoundTranscript();
  let transcriptPath = pickUsableTranscriptPath(boundTranscript, previousPath);
  const latestByMtime = findLatestTranscriptByMtime(boundTranscript?.sessionCwd);
  if (latestByMtime && latestByMtime !== transcriptPath) {
    transcriptPath = latestByMtime;
  }
  if (transcriptPath) {
    applyTranscriptBinding(route.targetChatId, transcriptPath);
  } else {
    refreshActiveInstance(INSTANCE_ID, { channelId: route.targetChatId });
  }
  void (async () => {
    try {
      await backend.react(msg.chatId, msg.messageId, "\u{1F914}");
    } catch {
    }
    statusState.update((state) => {
      state.channelId = route.targetChatId;
      state.userMessageId = msg.messageId;
      state.emoji = "\u{1F914}";
      state.sentCount = 0;
      state.sessionIdle = false;
      if (transcriptPath) state.transcriptPath = transcriptPath;
      else delete state.transcriptPath;
    });
    if (!boundTranscript?.exists) {
      await rebindTranscriptContext(route.targetChatId, {
        previousPath: transcriptPath,
        catchUp: true,
        persistStatus: true
      });
    }
  })();
  inboundQueue(() => handleInbound(msg, route, {
    sessionId: boundTranscript?.sessionId ?? sessionIdFromTranscriptPath(transcriptPath)
  }).catch((err) => {
    process.stderr.write(`trib-plugin: handleInbound error: ${err}
`);
  }).finally(() => {
    stopServerTyping();
  }));
};
async function handleInbound(msg, route, options = {}) {
  let text = msg.text;
  const voiceAtts = msg.attachments.filter((a) => isVoiceAttachment(a.contentType));
  if (voiceAtts.length > 0) {
    try {
      const files = await backend.downloadAttachment(msg.chatId, msg.messageId);
      for (const f of files) {
        if (isVoiceAttachment(f.contentType)) {
          const transcript = await transcribeVoice(f.path);
          if (transcript) {
            text = transcript;
            process.stderr.write(`trib-plugin: transcribed voice (${f.name}): ${transcript.slice(0, 50)}
`);
          } else {
            process.stderr.write(`trib-plugin: voice transcription returned empty (${f.name})
`);
            text = text || "[voice message \u2014 transcription failed]";
          }
        }
      }
    } catch (err) {
      process.stderr.write(`trib-plugin: voice transcription failed: ${err}
`);
      text = text || "[voice message \u2014 transcription error]";
    }
  }
  const hasVoiceAtt = voiceAtts.length > 0;
  const attMeta = msg.attachments.length > 0 && !hasVoiceAtt ? {
    attachment_count: String(msg.attachments.length),
    attachments: msg.attachments.map((a) => `${a.name} (${a.contentType}, ${(a.size / 1024).toFixed(0)}KB)`).join("; ")
  } : {};
  const messageBody = route.sourceMode === "monitor" && route.sourceLabel ? `[monitor:${route.sourceLabel}] ${text}` : text;
  const now = (/* @__PURE__ */ new Date()).toLocaleString();
  const notificationMeta = {
    chat_id: route.targetChatId,
    message_id: msg.messageId,
    user: msg.user,
    user_id: msg.userId,
    ts: msg.ts,
    ...route.sourceMode === "monitor" ? {
      source_chat_id: route.sourceChatId,
      source_mode: route.sourceMode,
      ...route.sourceLabel ? { source_label: route.sourceLabel } : {}
    } : {},
    ...attMeta,
    ...msg.imagePath ? { image_path: msg.imagePath } : {}
  };
  const notificationContent = `[${now}]
${messageBody}`;
  void mcpServer.notification({
    method: "notifications/claude/channel",
    params: {
      content: notificationContent,
      meta: notificationMeta
    }
  }).catch((e) => {
    process.stderr.write(`trib-plugin: notification failed: ${e}
`);
  });
  void memoryAppendEpisode({
    ts: msg.ts,
    backend: backend.name,
    channelId: route.targetChatId,
    userId: msg.userId,
    userName: msg.user,
    sessionId: options.sessionId ?? null,
    role: "user",
    kind: voiceAtts.length > 0 ? "voice" : "message",
    content: messageBody,
    sourceRef: `${backend.name}:${msg.messageId}:user`
  });
}
async function init(sharedMcp) {
  mcpServer = sharedMcp;
  scheduler.setInjectHandler((channelId, name, content, options) => {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const now = /* @__PURE__ */ new Date();
    const timeLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} `;
    const sourceLabel = options?.type ? `${timeLabel}: ${options.type}` : timeLabel;
    const meta = {
      chat_id: channelId,
      user: sourceLabel,
      user_id: "system",
      ts
    };
    if (options?.instruction) meta.instruction = options.instruction;
    if (options?.type) meta.type = options.type;
    void mcpServer.notification({
      method: "notifications/claude/channel",
      params: { content, meta }
    }).catch((e) => {
      process.stderr.write(`trib-plugin: notification failed: ${e}
`);
    });
    void memoryAppendEpisode({
      ts,
      backend: backend.name,
      channelId,
      userId: "system",
      userName: `schedule:${name}`,
      sessionId: null,
      role: "user",
      kind: "schedule-inject",
      content: options?.instruction || content,
      sourceRef: `schedule:${name}:${ts}`
    });
  });
  eventQueue.setInjectHandler((channelId, name, content, options) => {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const now = /* @__PURE__ */ new Date();
    const timeLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} `;
    const sourceLabel = options?.type ? `${timeLabel}: ${options.type}` : timeLabel;
    const meta = {
      chat_id: channelId,
      user: sourceLabel,
      user_id: "system",
      ts
    };
    if (options?.instruction) meta.instruction = options.instruction;
    if (options?.type) meta.type = options.type;
    void mcpServer.notification({
      method: "notifications/claude/channel",
      params: { content, meta }
    }).catch((e) => {
      try {
        process.stderr.write(`trib-plugin event: notification failed: ${e}
`);
      } catch {
      }
    });
    void memoryAppendEpisode({
      ts,
      backend: backend.name,
      channelId,
      userId: "system",
      userName: `event:${name}`,
      sessionId: null,
      role: "user",
      kind: "event-inject",
      content: options?.instruction || content,
      sourceRef: `event:${name}:${ts}`
    });
  });
}
async function start() {
  channelBridgeActive = true;
  writeBridgeState(true);
  await refreshBridgeOwnership({ restoreBinding: true });
}
async function stop() {
  await stopOwnedRuntime("unified server stop");
  cleanupInstanceRuntimeFiles(INSTANCE_ID);
}
if (process.env.TRIB_UNIFIED !== "1") {
  let detectChannelFlag = function() {
    const isWin = process.platform === "win32";
    const flagRe = /--channels\b|--dangerously-load-development-channels\b/;
    if (isWin) {
      let pid2 = process.ppid;
      for (let depth = 0; pid2 && pid2 > 1 && depth < 6; depth++) {
        try {
          let cmdLine = "";
          try {
            cmdLine = execSync(
              `wmic process where "ProcessId=${pid2}" get CommandLine /format:list`,
              { encoding: "utf8", timeout: 5e3 }
            );
          } catch {
            cmdLine = execSync(
              `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid2}').CommandLine"`,
              { encoding: "utf8", timeout: 5e3 }
            );
          }
          if (flagRe.test(cmdLine)) return true;
          let ppidStr = "";
          try {
            ppidStr = execSync(
              `wmic process where "ProcessId=${pid2}" get ParentProcessId /format:list`,
              { encoding: "utf8", timeout: 5e3 }
            );
          } catch {
            ppidStr = execSync(
              `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid2}').ParentProcessId"`,
              { encoding: "utf8", timeout: 5e3 }
            );
          }
          const match = ppidStr.match(/\d+/);
          if (!match) break;
          const nextPid = parseInt(match[0], 10);
          if (nextPid === pid2 || nextPid <= 1) break;
          pid2 = nextPid;
        } catch {
          break;
        }
      }
      return false;
    }
    let pid = process.ppid;
    for (let depth = 0; pid && pid > 1 && depth < 6; depth++) {
      try {
        const cmdLine = execSync(`ps -p ${pid} -o args=`, { encoding: "utf8", timeout: 3e3 });
        if (flagRe.test(cmdLine)) return true;
        pid = parseInt(execSync(`ps -p ${pid} -o ppid=`, { encoding: "utf8", timeout: 3e3 }).trim(), 10);
      } catch {
        break;
      }
    }
    return false;
  }, shutdown2 = function() {
    if (shuttingDown) return;
    shuttingDown = true;
    writeBridgeState(false);
    try {
      process.stderr.write("trib-plugin: shutting down\n");
    } catch {
    }
    setTimeout(() => process.exit(0), 3e3);
    if (bridgeOwnershipTimer) {
      clearInterval(bridgeOwnershipTimer);
      bridgeOwnershipTimer = null;
    }
    try {
      turnEndWatcher.close();
    } catch {
    }
    void stopCliWorker().catch(() => {
    });
    void stopOwnedRuntime("process shutdown").catch(() => {
    }).finally(() => {
      cleanupInstanceRuntimeFiles(INSTANCE_ID);
      clearServerPid();
      process.exit(0);
    });
  };
  detectChannelFlag2 = detectChannelFlag, shutdown3 = shutdown2;
  fs.appendFileSync(_bootLog, `[${localTimestamp()}] mcp.connect starting
`);
  await mcpServer.connect(new StdioServerTransport());
  fs.appendFileSync(_bootLog, `[${localTimestamp()}] mcp.connect done
`);
  const _channelFlagDetected = detectChannelFlag();
  fs.appendFileSync(_bootLog, `[${localTimestamp()}] channelFlag: ${_channelFlagDetected}
`);
  if (_channelFlagDetected) {
    channelBridgeActive = true;
    fs.appendFileSync(_bootLog, `[${localTimestamp()}] channel mode detected \u2014 bridge auto-activated
`);
  }
  writeBridgeState(channelBridgeActive);
  const previousOwner = readActiveInstance();
  noteStartupHandoff(previousOwner);
  if (channelBridgeActive) {
    claimBridgeOwnership("server start");
  }
  void refreshBridgeOwnership({ restoreBinding: true });
  bridgeOwnershipTimer = setInterval(() => {
    void refreshBridgeOwnership();
  }, 3e4);
  if (bridgeRuntimeConnected && channelBridgeActive) {
    const greetingDone = path.join(DATA_DIR, ".greeting-sent");
    const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const lastGreetDate = tryRead(greetingDone);
    if (lastGreetDate === today) {
    } else {
      void (async () => {
        fs.writeFileSync(greetingDone, today);
        const mainLabel = config.channelsConfig?.main || "general";
        const greetChannel = config.channelsConfig?.channels?.[mainLabel]?.id || "";
        if (!greetChannel) return;
        const bot = loadBotConfig();
        const quietSchedule = bot.quiet?.schedule;
        if (quietSchedule) {
          const parts = quietSchedule.split("-");
          if (parts.length === 2) {
            const now = /* @__PURE__ */ new Date();
            const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
            const [start2, end] = parts;
            const inQuiet = start2 > end ? hhmm >= start2 || hhmm < end : hhmm >= start2 && hhmm < end;
            if (inQuiet) return;
          }
        }
        await mcpServer.notification({
          method: "notifications/claude/channel",
          params: {
            content: "New session started. Say something different each time \u2014 mention recent work, ask a question, or just be casual. Never repeat the same greeting. One short message only, no tools. This is an internal system trigger. Do not mention that this is a greeting notification, session start, or system message. Just be natural.",
            meta: { chat_id: greetChannel, user: "system:greeting", user_id: "system", ts: (/* @__PURE__ */ new Date()).toISOString() }
          }
        }).catch(() => {
        });
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 2e3));
          const t = discoverSessionBoundTranscript();
          if (t?.exists) {
            if (!forwarder.hasBinding()) {
              applyTranscriptBinding(greetChannel, t.transcriptPath, { persistStatus: false });
              process.stderr.write(`trib-plugin: greeting transcript bound: ${t.transcriptPath}
`);
            }
            break;
          }
        }
      })();
    }
  }
  let shuttingDown = false;
  process.stdin.on("end", () => {
    try {
      process.stderr.write("[trib-plugin] stdin end, shutting down...\n");
    } catch {
    }
    shutdown2();
  });
  process.stdin.on("close", () => {
    try {
      process.stderr.write("[trib-plugin] stdin closed, shutting down...\n");
    } catch {
    }
    shutdown2();
  });
  process.on("SIGTERM", shutdown2);
  process.on("SIGINT", () => {
    process.stderr.write("[trib-plugin] SIGINT received, ignoring (handled by host)\n");
  });
  const configPath = path.join(DATA_DIR, "config.json");
  let reloadDebounce = null;
  try {
    fs.watch(configPath, () => {
      if (reloadDebounce) clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(() => {
        try {
          reloadRuntimeConfig();
        } catch {
        }
      }, 500);
    });
  } catch {
  }
}
var detectChannelFlag2;
var shutdown3;

// server.ts
process.env.TRIB_UNIFIED = "1";
var PLUGIN_ROOT2 = process.env.CLAUDE_PLUGIN_ROOT ?? dirname4(fileURLToPath(import.meta.url));
function readPluginVersion2() {
  try {
    const manifestPath = join11(PLUGIN_ROOT2, ".claude-plugin", "plugin.json");
    return JSON.parse(readFileSync13(manifestPath, "utf8")).version || "0.0.1";
  } catch {
    try {
      const fallback = join11(PLUGIN_ROOT2, ".claude-plugin", "marketplace.json");
      return JSON.parse(readFileSync13(fallback, "utf8")).version || "0.0.1";
    } catch {
      return "0.0.1";
    }
  }
}
var PLUGIN_VERSION2 = readPluginVersion2();
var searchModulePath = pathToFileURL2(join11(PLUGIN_ROOT2, "src/search/index.mjs")).href;
var {
  TOOL_DEFS: SEARCH_TOOLS,
  handleToolCall: searchHandleToolCall,
  start: searchStart,
  stop: searchStop
} = await import(searchModulePath);
var agentModulePath = pathToFileURL2(join11(PLUGIN_ROOT2, "src/agent/index.mjs")).href;
var {
  TOOL_DEFS: AGENT_TOOLS,
  init: agentInit,
  handleToolCall: agentHandleToolCall,
  start: agentStart,
  stop: agentStop
} = await import(agentModulePath);
var memoryModulePath = pathToFileURL2(join11(PLUGIN_ROOT2, "src/memory/index.mjs")).href;
var {
  TOOL_DEFS: MEMORY_TOOLS,
  init: memoryInit,
  handleToolCall: memoryHandleToolCall,
  start: memoryStart,
  stop: memoryStop
} = await import(memoryModulePath);
var SEARCH_TOOL_NAMES = new Set(SEARCH_TOOLS.map((t) => t.name));
var AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));
var MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map((t) => t.name));
var CHANNELS_TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));
var ALL_TOOLS = [
  ...TOOL_DEFS,
  ...MEMORY_TOOLS,
  ...SEARCH_TOOLS,
  ...AGENT_TOOLS
];
function routeToolCall(name) {
  if (SEARCH_TOOL_NAMES.has(name)) return "search";
  if (AGENT_TOOL_NAMES.has(name)) return "agent";
  if (MEMORY_TOOL_NAMES.has(name)) return "memory";
  if (CHANNELS_TOOL_NAMES.has(name)) return "channels";
  return null;
}
var UNIFIED_INSTRUCTIONS = "";
var server = new Server2(
  { name: "trib-plugin", version: PLUGIN_VERSION2 },
  {
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {}, "claude/channel/permission": {} }
    },
    instructions: UNIFIED_INSTRUCTIONS
  }
);
server.setRequestHandler(ListToolsRequestSchema2, async () => ({
  tools: ALL_TOOLS
}));
server.setRequestHandler(CallToolRequestSchema2, async (request3) => {
  const { name, arguments: args } = request3.params;
  const toolArgs = args ?? {};
  const module = routeToolCall(name);
  switch (module) {
    case "search":
      return await searchHandleToolCall(name, toolArgs);
    case "agent":
      return await agentHandleToolCall(name, toolArgs, {
        notifyFn: (text) => {
          server.notification({
            method: "notifications/claude/channel",
            params: { content: text, meta: { user: "trib-agent", user_id: "system", ts: (/* @__PURE__ */ new Date()).toISOString() } }
          }).catch(() => {
          });
        },
        elicitFn: (opts) => server.elicitInput?.(opts)
      });
    case "memory":
      return await memoryHandleToolCall(name, toolArgs);
    case "channels":
      return await handleToolCall(name, toolArgs);
    default: {
      if (!module) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      return { content: [{ type: "text", text: `Unhandled module: ${module}` }], isError: true };
    }
  }
});
async function main() {
  process.stderr.write(`[trib-plugin] unified server starting (v${PLUGIN_VERSION2})
`);
  await memoryInit();
  await agentInit();
  await init(server);
  const transport = new StdioServerTransport2();
  await server.connect(transport);
  process.stderr.write(`[trib-plugin] MCP server connected, starting modules...
`);
  await searchStart();
  await memoryStart();
  await agentStart();
  await start();
  process.stderr.write(`[trib-plugin] all modules started, ${ALL_TOOLS.length} tools registered
`);
}
async function shutdown() {
  process.stderr.write(`[trib-plugin] shutting down
`);
  await stop();
  await memoryStop();
  await agentStop();
  searchStop();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
if (process.platform !== "win32") process.on("SIGHUP", () => {
  void shutdown();
});
await main();
await new Promise((resolve3) => {
  server.onclose = resolve3;
});
