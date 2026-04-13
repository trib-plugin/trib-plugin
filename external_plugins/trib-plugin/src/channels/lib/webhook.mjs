import * as http from "http";
import * as crypto from "crypto";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { DATA_DIR } from "./config.mjs";
import { appendFileSync, readFileSync, writeFileSync, unlinkSync, statSync, existsSync } from "fs";
const WEBHOOKS_DIR = join(DATA_DIR, "webhooks");
import { callLLM } from '../../shared/llm/index.mjs';
const WEBHOOK_LOG = join(DATA_DIR, "webhook.log");
function logWebhook(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  try {
    process.stderr.write(`trib-plugin webhook: ${msg}
`);
  } catch {
  }
  try {
    appendFileSync(WEBHOOK_LOG, line);
  } catch {
  }
}
const SIGNATURE_HEADERS = {
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
const NGROK_PID_FILE = join(DATA_DIR, "ngrok.pid");
class WebhookServer {
  config;
  server = null;
  eventPipeline = null;
  boundPort = 0;
  noSecretWarned = false;
  ngrokProcess = null;
  ngrokStarting = false;
  constructor(config, _channelsConfig) {
    this.config = config;
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
        req.on("data", (chunk) => {
          body += chunk;
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
      const pidContent = readFileSync(NGROK_PID_FILE, "utf8").trim();
      const pid = parseInt(pidContent);
      if (pid > 0) {
        try {
          const age = Date.now() - statSync(NGROK_PID_FILE).mtimeMs;
          if (age > 60 * 60 * 1e3) {
            logWebhook(`ngrok PID file stale (${Math.round(age / 6e4)}m old), removing without kill`);
            try {
              unlinkSync(NGROK_PID_FILE);
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
      unlinkSync(NGROK_PID_FILE);
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
        this.ngrokProcess = spawn(ngrokBin, ["http", String(this.boundPort), "--url=" + domain], {
          stdio: "ignore",
          windowsHide: true
        });
        this.ngrokProcess.unref();
        if (this.ngrokProcess.pid) {
          try {
            writeFileSync(NGROK_PID_FILE, String(this.ngrokProcess.pid));
          } catch {
          }
        }
        this.ngrokProcess.on("exit", () => {
          this.ngrokProcess = null;
          this.ngrokStarting = false;
          try {
            unlinkSync(NGROK_PID_FILE);
          } catch {
          }
        });
        this.ngrokProcess.on("error", () => {
          this.ngrokProcess = null;
          this.ngrokStarting = false;
          try {
            unlinkSync(NGROK_PID_FILE);
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
        unlinkSync(NGROK_PID_FILE);
      } catch {
      }
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    logWebhook("stopped");
  }
  reloadConfig(config, _channelsConfig, options = {}) {
    this.stop();
    this.config = config;
    if (options.autoStart !== false && config.enabled) this.start();
  }
  // ── Delegate analysis via unified LLM runner ────────────────────────
  async delegateAnalysis(name, prompt, model, channel, exec) {
    const presetId = model || 'sonnet-mid';
    try {
      const result = await callLLM(prompt, presetId, { mode: 'light', timeout: 120000 });
      if (!result) {
        logWebhook(`${name}: delegate returned empty`);
        return;
      }
      logWebhook(`${name}: delegate done (${presetId}, ${result.length} chars)`);
      if (this.eventPipeline) {
        this.eventPipeline.enqueueDirect(name, result, channel, exec);
      }
    } catch (err) {
      logWebhook(`${name}: delegate error: ${err.message}`);
    }
  }
  // ── Webhook handler ───────────────────────────────────────────────
  handleWebhook(name, body, headers, res) {
    const folderPath = join(WEBHOOKS_DIR, name);
    const instructionsPath = join(folderPath, "instructions.md");
    if (existsSync(instructionsPath)) {
      try {
        const instructions = readFileSync(instructionsPath, "utf8").trim();
        let channel = "main";
        let exec = "interactive";
        let model = null;
        let analyze = false;
        const configPath = join(folderPath, "config.json");
        if (existsSync(configPath)) {
          try {
            const cfg = JSON.parse(readFileSync(configPath, "utf8"));
            if (cfg.channel) channel = cfg.channel;
            if (cfg.exec) exec = cfg.exec;
            if (cfg.model) model = cfg.model;
            if (cfg.analyze === true) analyze = true;
          } catch {
          }
        }
        const payload = JSON.stringify(body, null, 2);
        const headersSummary = Object.entries(headers).filter(([k]) => k.startsWith("x-") || k === "content-type").map(([k, v]) => `${k}: ${v}`).join("\n");
        const payloadContent = `--- Webhook Headers ---
${headersSummary}

--- Webhook Payload ---
${payload}`;
        const fullPrompt = `${instructions}

${payloadContent}`;
        if (analyze) {
          this.delegateAnalysis(name, fullPrompt, model, channel, exec);
          logWebhook(`${name}: folder-based \u2192 delegate (${model})`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "accepted", handler: "delegate" }));
          return;
        }
        if (this.eventPipeline) {
          this.eventPipeline.enqueueDirect(name, payloadContent, channel, exec, instructions);
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
}
export {
  WebhookServer
};
