// server.mjs
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// orchestrator/providers/openai-compat.js
import OpenAI from "openai";
var PRESETS = {
  openai: {
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o"
  },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile"
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4",
    extraHeaders: { "HTTP-Referer": "trib-orchestrator", "X-Title": "trib-orchestrator" }
  },
  xai: {
    baseURL: "https://api.x.ai/v1",
    defaultModel: "grok-3-beta"
  },
  ollama: {
    baseURL: "http://localhost:11434/v1",
    defaultModel: "llama3.3:latest"
  },
  lmstudio: {
    baseURL: "http://localhost:1234/v1",
    defaultModel: "default"
  },
  local: {
    baseURL: "http://localhost:8080/v1",
    defaultModel: "default"
  }
};
function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.toolCallId || "",
        content: m.content
      };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
        }))
      };
    }
    return { role: m.role, content: m.content };
  });
}
function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }
  }));
}
function parseToolCalls(choice) {
  const calls = choice.message?.tool_calls;
  if (!calls?.length)
    return void 0;
  return calls.filter((tc) => tc.type === "function").map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments || "{}")
  }));
}
var OpenAICompatProvider = class {
  name;
  client;
  defaultModel;
  constructor(name, config) {
    const preset = PRESETS[name];
    const baseURL = config.baseURL || preset?.baseURL || "http://localhost:8080/v1";
    const apiKey = config.apiKey || "no-key";
    this.name = name;
    this.defaultModel = preset?.defaultModel || "default";
    this.client = new OpenAI({
      baseURL,
      apiKey,
      defaultHeaders: preset?.extraHeaders
    });
  }
  async send(messages, model, tools, sendOpts) {
    const useModel = model || this.defaultModel;
    const opts = sendOpts || {};
    const params = {
      model: useModel,
      messages: toOpenAIMessages(messages)
    };
    if (tools?.length) {
      params.tools = toOpenAITools(tools);
    }
    if (this.name === "openai") {
      if (opts.effort) {
        params.reasoning_effort = opts.effort;
      }
      if (opts.fast === true) {
        params.service_tier = "fast";
      }
    }
    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];
    const toolCalls = choice ? parseToolCalls(choice) : void 0;
    return {
      content: choice?.message?.content || "",
      model: response.model,
      toolCalls,
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens || 0,
        outputTokens: response.usage.completion_tokens || 0
      } : void 0
    };
  }
  async listModels() {
    try {
      const list = await this.client.models.list();
      const models = [];
      for await (const m of list) {
        models.push({
          id: m.id,
          name: m.id,
          provider: this.name,
          contextWindow: 0
        });
      }
      return models;
    } catch {
      return [];
    }
  }
  async isAvailable() {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
};

// orchestrator/providers/anthropic.js
import Anthropic from "@anthropic-ai/sdk";
var MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic", contextWindow: 1e6 },
  { id: "claude-opus-4-0", name: "Claude Opus 4", provider: "anthropic", contextWindow: 2e5 },
  { id: "claude-sonnet-4-0", name: "Claude Sonnet 4", provider: "anthropic", contextWindow: 2e5 },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic", contextWindow: 2e5 }
];
var MAX_TOKENS = {
  "claude-opus-4-6": 32768,
  "claude-opus-4-0": 32768,
  "claude-sonnet-4-0": 16384,
  "claude-haiku-4-5-20251001": 8192
};
var EFFORT_BUDGET = {
  low: 1024,
  medium: 4096,
  high: 16384,
  max: 32768
};
function toAnthropicTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));
}
function toAnthropicMessages(messages) {
  const result = [];
  for (const m of messages) {
    if (m.role === "system")
      continue;
    if (m.role === "assistant" && m.toolCalls?.length) {
      const content = [];
      if (m.content)
        content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.arguments
        });
      }
      result.push({ role: "assistant", content });
      continue;
    }
    if (m.role === "tool") {
      const last = result[result.length - 1];
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId || "",
        content: m.content
      };
      if (last?.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        result.push({ role: "user", content: [block] });
      }
      continue;
    }
    result.push({
      role: m.role,
      content: m.content
    });
  }
  return result;
}
function parseToolCalls2(response) {
  const blocks = response.content.filter((b) => b.type === "tool_use");
  if (!blocks.length)
    return void 0;
  return blocks.map((b) => ({
    id: b.id,
    name: b.name,
    arguments: b.input ?? {}
  }));
}
var AnthropicProvider = class {
  name = "anthropic";
  client;
  constructor(config) {
    this.client = new Anthropic({
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY
    });
  }
  async send(messages, model, tools, sendOpts) {
    const useModel = model || "claude-sonnet-4-0";
    const maxTokens = MAX_TOKENS[useModel] || 8192;
    const opts = sendOpts || {};
    const systemMsgs = messages.filter((m) => m.role === "system");
    const chatMsgs = messages.filter((m) => m.role !== "system");
    const params = {
      model: useModel,
      max_tokens: maxTokens,
      system: systemMsgs.map((m) => m.content).join("\n\n") || void 0,
      messages: toAnthropicMessages(chatMsgs)
    };
    if (tools?.length) {
      params.tools = toAnthropicTools(tools);
    }
    if (opts.effort && EFFORT_BUDGET[opts.effort]) {
      params.thinking = { type: "enabled", budget_tokens: EFFORT_BUDGET[opts.effort] };
    }
    const extraHeaders = {};
    if (opts.fast === true) {
      params.speed = "fast";
    }
    const response = await this.client.messages.create(params, { headers: extraHeaders });
    const textBlock = response.content.find((b) => b.type === "text");
    const toolCalls = parseToolCalls2(response);
    return {
      content: textBlock?.type === "text" ? textBlock.text : "",
      model: response.model,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens
      }
    };
  }
  async listModels() {
    return MODELS;
  }
  async isAvailable() {
    try {
      await this.client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }]
      });
      return true;
    } catch {
      return false;
    }
  }
};

// orchestrator/providers/gemini.js
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
var MODELS2 = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "gemini", contextWindow: 1e6 },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "gemini", contextWindow: 1e6 },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "gemini", contextWindow: 1e6 }
];
function toSchemaType(t) {
  const map = {
    string: SchemaType.STRING,
    number: SchemaType.NUMBER,
    integer: SchemaType.INTEGER,
    boolean: SchemaType.BOOLEAN,
    array: SchemaType.ARRAY,
    object: SchemaType.OBJECT
  };
  return map[t] ?? SchemaType.STRING;
}
function convertSchema(schema) {
  const result = { ...schema };
  if (typeof result.type === "string") {
    result.type = toSchemaType(result.type);
  }
  if (result.properties && typeof result.properties === "object") {
    const props = {};
    for (const [key, val] of Object.entries(result.properties)) {
      props[key] = convertSchema(val);
    }
    result.properties = props;
  }
  if (result.items && typeof result.items === "object") {
    result.items = convertSchema(result.items);
  }
  return result;
}
function toGeminiTools(tools) {
  return {
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: convertSchema(t.inputSchema)
    }))
  };
}
function toGeminiHistory(messages) {
  const contents = [];
  for (const m of messages) {
    if (m.role === "system")
      continue;
    if (m.role === "assistant" && m.toolCalls?.length) {
      const parts = [];
      if (m.content)
        parts.push({ text: m.content });
      for (const tc of m.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
      }
      contents.push({ role: "model", parts });
      continue;
    }
    if (m.role === "tool") {
      contents.push({
        role: "function",
        parts: [{ functionResponse: { name: m.toolCallId || "", response: { result: m.content } } }]
      });
      continue;
    }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    });
  }
  return contents;
}
function parseToolCalls3(parts) {
  const calls = parts.filter((p) => "functionCall" in p && !!p.functionCall);
  if (!calls.length)
    return void 0;
  return calls.map((p, i) => ({
    id: `gemini_${Date.now()}_${i}`,
    name: p.functionCall.name,
    arguments: p.functionCall.args ?? {}
  }));
}
var GeminiProvider = class {
  name = "gemini";
  genAI;
  constructor(config) {
    this.genAI = new GoogleGenerativeAI(config.apiKey || process.env.GEMINI_API_KEY || "");
  }
  async send(messages, model, tools) {
    const useModel = model || "gemini-2.5-flash";
    const systemMsgs = messages.filter((m) => m.role === "system");
    const chatMsgs = messages.filter((m) => m.role !== "system");
    const genModel = this.genAI.getGenerativeModel({
      model: useModel,
      systemInstruction: systemMsgs.map((m) => m.content).join("\n\n") || void 0,
      tools: tools?.length ? [toGeminiTools(tools)] : void 0
    });
    const history = toGeminiHistory(chatMsgs.slice(0, -1));
    const lastMsg = chatMsgs[chatMsgs.length - 1];
    if (!lastMsg)
      throw new Error("No messages to send");
    const chat = genModel.startChat({ history });
    let lastParts;
    if (lastMsg.role === "tool") {
      lastParts = [{ functionResponse: { name: lastMsg.toolCallId || "", response: { result: lastMsg.content } } }];
    } else {
      lastParts = [{ text: lastMsg.content }];
    }
    const result = await chat.sendMessage(lastParts);
    const response = result.response;
    const textParts = response.candidates?.[0]?.content?.parts?.filter((p) => "text" in p) ?? [];
    const content = textParts.map((p) => "text" in p ? p.text : "").join("");
    const toolCalls = parseToolCalls3(response.candidates?.[0]?.content?.parts ?? []);
    return {
      content,
      model: useModel,
      toolCalls,
      usage: response.usageMetadata ? {
        inputTokens: response.usageMetadata.promptTokenCount || 0,
        outputTokens: response.usageMetadata.candidatesTokenCount || 0
      } : void 0
    };
  }
  async listModels() {
    return MODELS2;
  }
  async isAvailable() {
    try {
      const model = this.genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      await model.generateContent("hi");
      return true;
    } catch {
      return false;
    }
  }
};

// orchestrator/providers/openai-oauth.js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
var CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
var TOKEN_URL = "https://auth.openai.com/oauth/token";
var CODEX_API_URL = "https://chatgpt.com/backend-api/codex/responses";
function getOwnTokenPath() {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  const dir = pluginData || join(homedir(), ".config", "trib-orchestrator");
  if (!existsSync(dir))
    mkdirSync(dir, { recursive: true });
  return join(dir, "openai-oauth.json");
}
function loadTokens() {
  const codexPath = join(homedir(), ".codex", "auth.json");
  if (existsSync(codexPath)) {
    try {
      const data = JSON.parse(readFileSync(codexPath, "utf-8"));
      const tokens = data.tokens || data;
      if (tokens.access_token && tokens.refresh_token) {
        const expiresAt = typeof data.expires_at === "number" ? data.expires_at < 1e12 ? data.expires_at * 1e3 : data.expires_at : data.last_refresh ? new Date(data.last_refresh).getTime() + 36e5 : 0;
        return {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: expiresAt,
          account_id: tokens.account_id || extractAccountId(tokens.access_token)
        };
      }
    } catch {
    }
  }
  const ownPath = getOwnTokenPath();
  if (!existsSync(ownPath))
    return null;
  try {
    return JSON.parse(readFileSync(ownPath, "utf-8"));
  } catch {
    return null;
  }
}
function saveTokens(tokens) {
  writeFileSync(getOwnTokenPath(), JSON.stringify(tokens, null, 2));
}
function extractAccountId(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3)
      return void 0;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return void 0;
  }
}
async function refreshTokens(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID
    })
  });
  if (!res.ok)
    return null;
  const json = await res.json();
  if (!json.access_token || !json.refresh_token || !json.expires_in)
    return null;
  const tokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + json.expires_in * 1e3,
    account_id: extractAccountId(json.access_token)
  };
  saveTokens(tokens);
  return tokens;
}
async function parseSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let model = "";
  let toolCalls = [];
  let usage;
  let buffer = "";
  const pendingCalls = /* @__PURE__ */ new Map();
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: "))
        continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]")
        continue;
      try {
        const event = JSON.parse(data);
        if (event.type === "response.output_text.delta") {
          content += event.delta || "";
        }
        if (event.type === "response.created" && event.response?.model) {
          model = event.response.model;
        }
        if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
          pendingCalls.set(event.item.id || "", {
            name: event.item.name || "",
            callId: event.item.call_id || ""
          });
        }
        if (event.type === "response.function_call_arguments.done") {
          const itemId = event.item_id || "";
          const pending = pendingCalls.get(itemId);
          toolCalls.push({
            id: pending?.callId || `tc_${Date.now()}_${toolCalls.length}`,
            name: pending?.name || "",
            arguments: JSON.parse(event.arguments || "{}")
          });
        }
        if (event.type === "response.completed" && event.response?.usage) {
          const u = event.response.usage;
          usage = {
            inputTokens: u.input_tokens || 0,
            outputTokens: u.output_tokens || 0
          };
          if (!model && event.response.model)
            model = event.response.model;
          if (!content && event.response.output) {
            for (const item of event.response.output) {
              if (item.type === "message") {
                for (const c of item.content || []) {
                  if (c.type === "output_text")
                    content += c.text || "";
                }
              }
            }
          }
        }
      } catch {
      }
    }
  }
  return {
    content,
    model,
    toolCalls: toolCalls.length ? toolCalls : void 0,
    usage
  };
}
function buildRequestBody(messages, model, tools, sendOpts) {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const instructions = systemMsgs.map((m) => m.content).join("\n\n") || "You are a helpful assistant.";
  const input = [];
  for (const m of messages) {
    if (m.role === "system")
      continue;
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.toolCallId || "",
        output: m.content
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      if (m.content) {
        input.push({ role: "assistant", content: m.content });
      }
      for (const tc of m.toolCalls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments)
        });
      }
      continue;
    }
    input.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content
    });
  }
  const opts = sendOpts || {};
  const body = {
    model,
    instructions,
    input,
    store: false,
    stream: true,
    reasoning: { effort: opts.effort || "medium" }
  };
  if (opts.fast === true) {
    body.service_tier = "fast";
  }
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }));
  }
  return body;
}
var OpenAIOAuthProvider = class {
  name = "openai-oauth";
  tokens = null;
  constructor(_config) {
    this.tokens = loadTokens();
  }
  async ensureAuth() {
    if (!this.tokens)
      throw new Error("OpenAI OAuth not authenticated. Run codex login first.");
    if (this.tokens.expires_at < Date.now() + 3e5) {
      process.stderr.write(`[openai-oauth] Token expired/expiring, refreshing...
`);
      try {
        const refreshed = await refreshTokens(this.tokens.refresh_token);
        if (refreshed) {
          this.tokens = refreshed;
          process.stderr.write(`[openai-oauth] Token refreshed, expires in ${Math.round((refreshed.expires_at - Date.now()) / 1e3)}s
`);
        } else {
          throw new Error("refresh returned null");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[openai-oauth] Refresh failed: ${msg}
`);
        throw new Error("OpenAI OAuth token refresh failed. Run codex login to re-authenticate.");
      }
    }
    return this.tokens;
  }
  async send(messages, model, tools, sendOpts) {
    const auth = await this.ensureAuth();
    const useModel = model || "gpt-5.2-codex";
    const body = buildRequestBody(messages, useModel, tools, sendOpts);
    const response = await fetch(CODEX_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${auth.access_token}`,
        "Content-Type": "application/json",
        "chatgpt-account-id": auth.account_id || "",
        "originator": "codex_cli_rs",
        "OpenAI-Beta": "responses=experimental"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      process.stderr.write(`[openai-oauth] API error ${response.status}: ${text.slice(0, 200)}
`);
      throw new Error(`Codex API ${response.status}: ${text.slice(0, 200)}`);
    }
    process.stderr.write(`[openai-oauth] Response ${response.status}, parsing SSE...
`);
    const result = await parseSSEStream(response);
    process.stderr.write(`[openai-oauth] Done: ${result.content.length} chars, ${result.toolCalls?.length || 0} tool calls
`);
    return result;
  }
  async listModels() {
    return [
      { id: "gpt-5.4", name: "GPT-5.4", provider: "openai-oauth", contextWindow: 1e6 },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai-oauth", contextWindow: 1e6 },
      { id: "gpt-5.4-nano", name: "GPT-5.4 Nano", provider: "openai-oauth", contextWindow: 1e6 },
      { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", provider: "openai-oauth", contextWindow: 1e6 },
      { id: "gpt-5.2", name: "GPT-5.2", provider: "openai-oauth", contextWindow: 1e6 }
    ];
  }
  async isAvailable() {
    return this.tokens !== null;
  }
};

// orchestrator/providers/copilot-auth.js
import { readFileSync as readFileSync2 } from "fs";
import { join as join2 } from "path";
import { homedir as homedir2 } from "os";
var cachedToken = null;
function loadGitHubToken() {
  if (process.env.GITHUB_TOKEN)
    return process.env.GITHUB_TOKEN;
  const configDir = process.env.XDG_CONFIG_HOME || (process.platform === "win32" ? process.env.LOCALAPPDATA || join2(homedir2(), "AppData", "Local") : join2(homedir2(), ".config"));
  const filePaths = [
    join2(configDir, "github-copilot", "hosts.json"),
    join2(configDir, "github-copilot", "apps.json")
  ];
  for (const filePath of filePaths) {
    try {
      const data = JSON.parse(readFileSync2(filePath, "utf-8"));
      for (const [key, value] of Object.entries(data)) {
        if (key.includes("github.com") && typeof value === "object" && value !== null) {
          const oauthToken = value.oauth_token;
          if (typeof oauthToken === "string")
            return oauthToken;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}
async function getCopilotBearerToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() / 1e3 + 60) {
    return cachedToken.token;
  }
  const githubToken = loadGitHubToken();
  if (!githubToken)
    return null;
  const response = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      "Authorization": `Token ${githubToken}`,
      "User-Agent": "trib-orchestrator/1.0"
    }
  });
  if (!response.ok)
    return null;
  const data = await response.json();
  cachedToken = { token: data.token, expiresAt: data.expires_at };
  return data.token;
}

// orchestrator/providers/registry.js
var OPENAI_COMPAT_PROVIDERS = ["openai", "groq", "openrouter", "xai", "ollama", "lmstudio", "local"];
var CopilotProvider = class {
  name = "copilot";
  inner = null;
  config;
  constructor(config) {
    this.config = config;
  }
  async ensureClient() {
    const token = await getCopilotBearerToken();
    if (!token)
      throw new Error("Failed to obtain Copilot bearer token");
    this.inner = new OpenAICompatProvider("copilot", {
      ...this.config,
      apiKey: token,
      baseURL: this.config.baseURL || "https://api.githubcopilot.com"
    });
    return this.inner;
  }
  async send(messages, model) {
    const client = await this.ensureClient();
    return client.send(messages, model);
  }
  async listModels() {
    try {
      const client = await this.ensureClient();
      return client.listModels();
    } catch {
      return [];
    }
  }
  async isAvailable() {
    try {
      await this.ensureClient();
      return true;
    } catch {
      return false;
    }
  }
};
var providers = /* @__PURE__ */ new Map();
async function initProviders(config) {
  providers.clear();
  for (const [name, cfg] of Object.entries(config)) {
    if (!cfg.enabled)
      continue;
    try {
      if (name === "anthropic") {
        providers.set(name, new AnthropicProvider(cfg));
      } else if (name === "gemini") {
        providers.set(name, new GeminiProvider(cfg));
      } else if (name === "copilot") {
        providers.set(name, new CopilotProvider(cfg));
      } else if (name === "openai-oauth") {
        providers.set(name, new OpenAIOAuthProvider(cfg));
      } else if (OPENAI_COMPAT_PROVIDERS.includes(name)) {
        providers.set(name, new OpenAICompatProvider(name, cfg));
      } else {
        providers.set(name, new OpenAICompatProvider(name, cfg));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[provider] Skipping "${name}": ${msg}
`);
    }
  }
}
function getProvider(name) {
  return providers.get(name);
}
function getAllProviders() {
  return providers;
}

// orchestrator/session/trim.js
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}
var TOOL_TRUNCATE_THRESHOLD = 500;
function truncateToolResults(messages) {
  return messages.map((m) => {
    if (m.role === "tool" && m.content.length > TOOL_TRUNCATE_THRESHOLD) {
      return { ...m, content: m.content.slice(0, TOOL_TRUNCATE_THRESHOLD) + "\n[truncated]" };
    }
    return m;
  });
}
function trimMessages(messages, budgetTokens) {
  if (estimateMessagesTokens(messages) <= budgetTokens)
    return messages;
  let trimmed = truncateToolResults(messages);
  if (estimateMessagesTokens(trimmed) <= budgetTokens)
    return trimmed;
  const system = trimmed.filter((m) => m.role === "system");
  const rest = trimmed.filter((m) => m.role !== "system");
  if (rest.length === 0)
    return system;
  const lastMsg = rest[rest.length - 1];
  let middle = rest.slice(0, -1);
  const baseCost = estimateMessagesTokens(system) + estimateMessagesTokens([lastMsg]);
  if (baseCost >= budgetTokens) {
    return [...system, lastMsg];
  }
  let total = estimateMessagesTokens(middle);
  while (total + baseCost > budgetTokens) {
    const toolIdx = middle.findIndex((m) => m.role === "tool");
    if (toolIdx === -1)
      break;
    total -= estimateTokens(middle[toolIdx].content) + 4;
    middle.splice(toolIdx, 1);
  }
  if (total + baseCost <= budgetTokens) {
    return [...system, ...middle, lastMsg];
  }
  let remaining = budgetTokens - baseCost;
  const kept = [];
  for (let i = middle.length - 1; i >= 0; i--) {
    const cost = estimateTokens(middle[i].content) + 4;
    if (remaining - cost < 0)
      break;
    remaining -= cost;
    kept.unshift(middle[i]);
  }
  return [...system, ...kept, lastMsg];
}

// orchestrator/mcp/client.js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync as readFileSync3, existsSync as existsSync2 } from "fs";
import { join as join3 } from "path";
import { tmpdir } from "os";
var AUTO_DETECT_PORTS = {
  "trib-memory": { dir: "trib-memory", file: "memory-port", endpoint: "/mcp" },
  "trib-channels": { dir: "trib-channels", file: "active-instance.json", endpoint: "/mcp", portField: "httpPort" }
};
var servers = /* @__PURE__ */ new Map();
async function connectMcpServers(config) {
  for (const [name, cfg] of Object.entries(config)) {
    try {
      await connectServer(name, cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mcp-client] Failed to connect "${name}": ${msg}
`);
    }
  }
}
function getMcpTools() {
  const tools = [];
  for (const server2 of servers.values()) {
    tools.push(...server2.tools);
  }
  return tools;
}
async function executeMcpTool(name, args) {
  const match = name.match(/^mcp__(.+?)__(.+)$/);
  if (!match)
    throw new Error(`Not an MCP tool name: ${name}`);
  const [, serverName, toolName] = match;
  const server2 = servers.get(serverName);
  if (!server2)
    throw new Error(`MCP server "${serverName}" not connected`);
  const result = await server2.client.callTool({ name: toolName, arguments: args });
  const content = result.content;
  if (Array.isArray(content)) {
    return content.map((c) => c.type === "text" ? c.text || "" : JSON.stringify(c)).join("\n");
  }
  return typeof content === "string" ? content : JSON.stringify(content);
}
function isMcpTool(name) {
  return name.startsWith("mcp__");
}
async function disconnectAll() {
  for (const [name, server2] of servers) {
    try {
      await server2.client.close();
    } catch {
    }
    servers.delete(name);
  }
}
async function connectServer(name, cfg) {
  const client = new Client({ name: `trib-orchestrator/${name}`, version: "1.0.0" });
  let transport;
  if (cfg.autoDetect) {
    const spec = AUTO_DETECT_PORTS[cfg.autoDetect];
    if (!spec)
      throw new Error(`Unknown autoDetect target: "${cfg.autoDetect}"`);
    const portFile = join3(tmpdir(), spec.dir, spec.file);
    if (!existsSync2(portFile)) {
      process.stderr.write(`[mcp-client] "${name}" autoDetect: port file not found (${portFile}), skipping
`);
      return;
    }
    let port;
    const raw = readFileSync3(portFile, "utf-8").trim();
    if (spec.portField) {
      try {
        const json = JSON.parse(raw);
        port = json[spec.portField];
      } catch {
        process.stderr.write(`[mcp-client] "${name}" autoDetect: failed to parse JSON in ${portFile}, skipping
`);
        return;
      }
    } else {
      port = parseInt(raw, 10);
    }
    if (!port || port < 1 || port > 65535) {
      process.stderr.write(`[mcp-client] "${name}" autoDetect: invalid port in ${portFile}, skipping
`);
      return;
    }
    const url = `http://127.0.0.1:${port}${spec.endpoint}`;
    transport = new StreamableHTTPClientTransport(new URL(url));
    process.stderr.write(`[mcp-client] Connecting "${name}" via autoDetect HTTP: ${url}
`);
  } else if (cfg.transport === "http" && cfg.url) {
    transport = new StreamableHTTPClientTransport(new URL(cfg.url));
    process.stderr.write(`[mcp-client] Connecting "${name}" via HTTP: ${cfg.url}
`);
  } else if (cfg.command) {
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      cwd: cfg.cwd,
      env: { ...process.env, ...cfg.env }
    });
  } else {
    throw new Error(`Invalid config for "${name}": need autoDetect, url (http), or command (stdio)`);
  }
  await client.connect(transport);
  const toolsResult = await client.listTools();
  const tools = (toolsResult.tools || []).map((t) => ({
    name: `mcp__${name}__${t.name}`,
    description: t.description ? t.description.slice(0, 2048) : "",
    inputSchema: t.inputSchema || { type: "object", properties: {} }
  }));
  const mode = cfg.autoDetect ? `autoDetect(${cfg.autoDetect})` : cfg.transport || "stdio";
  servers.set(name, { name, client, transport, tools });
  process.stderr.write(`[mcp-client] Connected "${name}" via ${mode} \u2014 ${tools.length} tools
`);
}

// orchestrator/tools/builtin.js
import { execSync } from "child_process";
import { readFileSync as readFileSync4, writeFileSync as writeFileSync2 } from "fs";
import { resolve, normalize } from "path";
var BUILTIN_TOOLS = [
  {
    name: "bash",
    description: "Execute a shell command and return stdout/stderr. Use for running tests, git status, npm commands, etc.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" }
      },
      required: ["command"]
    }
  },
  {
    name: "read",
    description: "Read a file and return its contents.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read" },
        offset: { type: "number", description: "Start line (0-based)" },
        limit: { type: "number", description: "Max lines to read" }
      },
      required: ["path"]
    }
  },
  {
    name: "write",
    description: "Write content to a file (creates or overwrites).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write" },
        content: { type: "string", description: "Content to write" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "edit",
    description: "Replace a string in a file. old_string must be unique in the file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to edit" },
        old_string: { type: "string", description: "Exact text to find" },
        new_string: { type: "string", description: "Replacement text" }
      },
      required: ["path", "old_string", "new_string"]
    }
  },
  {
    name: "grep",
    description: "Search file contents with regex. Returns matching lines with file paths and line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search in (default: cwd)" },
        glob: { type: "string", description: 'File pattern filter (e.g., "*.ts")' }
      },
      required: ["pattern"]
    }
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern. Returns file paths.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.js")' },
        path: { type: "string", description: "Base directory (default: cwd)" }
      },
      required: ["pattern"]
    }
  }
];
var BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+[/~]/i,
  /\bgit\s+push\s+--force/i,
  /\bgit\s+reset\s+--hard/i,
  /\bformat\s+[a-z]:/i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bdel\s+\/[sfq]/i
];
function isSafePath(filePath, cwd) {
  const baseCwd = normalize(resolve(cwd));
  const normalized = normalize(resolve(baseCwd, filePath));
  if (!normalized.startsWith(baseCwd)) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home && normalized.startsWith(normalize(home)))
      return true;
    return false;
  }
  return true;
}
function resolveAgainstCwd(filePath, cwd) {
  return resolve(cwd, filePath);
}
function executeBuiltinTool(name, args, cwd) {
  const workDir = cwd || process.cwd();
  switch (name) {
    case "bash": {
      const command = args.command;
      if (!command)
        return "Error: command is required";
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(command)) {
          return `Error: blocked command pattern \u2014 "${command}" matches safety rule`;
        }
      }
      const timeout = args.timeout || 3e4;
      try {
        const result = execSync(command, {
          encoding: "utf-8",
          timeout,
          stdio: ["pipe", "pipe", "pipe"],
          cwd: workDir
        });
        return result || "(no output)";
      } catch (err) {
        const e = err;
        return `${e.stdout || ""}${e.stderr || e.message || "Command failed"}`.trim();
      }
    }
    case "read": {
      const filePath = args.path;
      if (!filePath)
        return "Error: path is required";
      if (!isSafePath(filePath, workDir))
        return `Error: path outside allowed scope \u2014 ${filePath}`;
      try {
        const content = readFileSync4(resolveAgainstCwd(filePath, workDir), "utf-8");
        const lines = content.split("\n");
        const offset = args.offset || 0;
        const limit = args.limit || 2e3;
        const sliced = lines.slice(offset, offset + limit);
        return sliced.map((line, i) => `${offset + i + 1}	${line}`).join("\n");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "write": {
      const filePath = args.path;
      const content = args.content;
      if (!filePath)
        return "Error: path is required";
      if (content === void 0)
        return "Error: content is required";
      if (!isSafePath(filePath, workDir))
        return `Error: path outside allowed scope \u2014 ${filePath}`;
      try {
        writeFileSync2(resolveAgainstCwd(filePath, workDir), content, "utf-8");
        return `Written: ${filePath}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "edit": {
      const filePath = args.path;
      const oldStr = args.old_string;
      const newStr = args.new_string;
      if (!filePath || !oldStr)
        return "Error: path and old_string are required";
      if (!isSafePath(filePath, workDir))
        return `Error: path outside allowed scope \u2014 ${filePath}`;
      try {
        const fullPath = resolveAgainstCwd(filePath, workDir);
        const content = readFileSync4(fullPath, "utf-8");
        const count = content.split(oldStr).length - 1;
        if (count === 0)
          return `Error: old_string not found in ${filePath}`;
        if (count > 1)
          return `Error: old_string found ${count} times \u2014 must be unique`;
        const updated = content.replace(oldStr, newStr);
        writeFileSync2(fullPath, updated, "utf-8");
        return `Edited: ${filePath}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "grep": {
      const pattern = args.pattern;
      if (!pattern)
        return "Error: pattern is required";
      const searchPath = args.path || ".";
      const fileGlob = args.glob;
      try {
        const rgArgs = ["--no-heading", "--line-number", "--color", "never"];
        if (fileGlob)
          rgArgs.push("--glob", fileGlob);
        rgArgs.push(pattern, searchPath);
        const result = execSync(`rg ${rgArgs.map((a) => `"${a}"`).join(" ")}`, {
          encoding: "utf-8",
          timeout: 1e4,
          stdio: ["pipe", "pipe", "pipe"],
          cwd: workDir
        });
        const lines = result.split("\n").slice(0, 100);
        return lines.join("\n") || "(no matches)";
      } catch {
        return "(no matches)";
      }
    }
    case "glob": {
      const pattern = args.pattern;
      if (!pattern)
        return "Error: pattern is required";
      const basePath = args.path || ".";
      try {
        const result = execSync(`rg --files --glob "${pattern}" "${basePath}"`, {
          encoding: "utf-8",
          timeout: 1e4,
          stdio: ["pipe", "pipe", "pipe"],
          cwd: workDir
        });
        const files = result.split("\n").filter(Boolean).slice(0, 100);
        return files.join("\n") || "(no files found)";
      } catch {
        return "(no files found)";
      }
    }
    default:
      return `Error: unknown builtin tool "${name}"`;
  }
}
function isBuiltinTool(name) {
  return BUILTIN_TOOLS.some((t) => t.name === name);
}

// orchestrator/context/collect.js
import { readFileSync as readFileSync5, existsSync as existsSync3, readdirSync } from "fs";
import { join as join4 } from "path";
import { homedir as homedir3 } from "os";
function collectClaudeMd(cwd) {
  const projectDir = cwd || process.cwd();
  const parts = [];
  const paths = [
    join4(homedir3(), ".claude", "CLAUDE.md"),
    join4(projectDir, "CLAUDE.md"),
    join4(projectDir, ".claude", "CLAUDE.md"),
    join4(projectDir, "CLAUDE.local.md")
  ];
  for (const p of paths) {
    const content = readSafe(p);
    if (content)
      parts.push(`<!-- ${p} -->
${content}`);
  }
  const rulesDir = join4(projectDir, ".claude", "rules");
  if (existsSync3(rulesDir)) {
    try {
      const files = readdirSync(rulesDir).filter((f) => f.endsWith(".md")).sort();
      for (const f of files) {
        const content = readSafe(join4(rulesDir, f));
        if (content)
          parts.push(`<!-- ${f} -->
${content}`);
      }
    } catch {
    }
  }
  return parts.join("\n\n---\n\n");
}
function loadAgentTemplate(name, cwd) {
  const projectDir = cwd || process.cwd();
  const searchPaths = [
    join4(projectDir, ".claude", "agents", `${name}.md`),
    join4(homedir3(), ".claude", "agents", `${name}.md`)
  ];
  const pluginBase = join4(homedir3(), ".claude", "plugins", "marketplaces");
  if (existsSync3(pluginBase)) {
    try {
      walkForAgent(pluginBase, name, searchPaths);
    } catch {
    }
  }
  for (const p of searchPaths) {
    const content = readSafe(p);
    if (content) {
      const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
      return stripped.trim();
    }
  }
  return null;
}
function collectSkills(cwd) {
  const projectDir = cwd || process.cwd();
  const skills = [];
  const dirs = [
    join4(homedir3(), ".claude", "skills"),
    join4(projectDir, ".claude", "skills")
  ];
  const pluginBase = join4(homedir3(), ".claude", "plugins", "marketplaces");
  if (existsSync3(pluginBase)) {
    try {
      walkForSkills(pluginBase, dirs);
    } catch {
    }
  }
  const seen = /* @__PURE__ */ new Set();
  for (const dir of dirs) {
    if (!existsSync3(dir))
      continue;
    try {
      const files = readdirSync(dir, { recursive: true });
      for (const f of files) {
        if (!String(f).endsWith(".md"))
          continue;
        const filePath = join4(dir, String(f));
        const content = readSafe(filePath);
        if (!content)
          continue;
        const fm = parseFrontmatter(content);
        if (!fm.name)
          continue;
        if (seen.has(fm.name))
          continue;
        seen.add(fm.name);
        skills.push({
          name: fm.name,
          description: fm.description || "",
          filePath
        });
      }
    } catch {
    }
  }
  return skills;
}
function loadSkillContent(name, cwd) {
  const skills = collectSkills(cwd);
  const skill = skills.find((s) => s.name === name);
  if (!skill)
    return null;
  return readSafe(skill.filePath);
}
function buildSkillToolDef(skills) {
  if (!skills.length)
    return null;
  const listing = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return {
    name: "skill",
    description: `Load a skill by name. Available skills:
${listing}`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to load" }
      },
      required: ["name"]
    }
  };
}
function composeSystemPrompt(opts) {
  const parts = [];
  if (opts.claudeMd) {
    parts.push("# Project Instructions\n\n" + opts.claudeMd);
  }
  if (opts.agentTemplate) {
    parts.push("# Agent Role\n\n" + opts.agentTemplate);
  }
  if (opts.skillsSummary) {
    parts.push("# Available Skills\n\nUse the `skill` tool to load a skill when needed.\n\n" + opts.skillsSummary);
  }
  if (opts.userPrompt) {
    parts.push(opts.userPrompt);
  }
  return parts.join("\n\n---\n\n");
}
function readSafe(path) {
  try {
    if (!existsSync3(path))
      return null;
    const content = readFileSync5(path, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match)
    return {};
  const fm = match[1];
  const name = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
  const description = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
  return { name, description };
}
function walkForAgent(dir, agentName, result) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules")
        continue;
      const full = join4(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "agents") {
          result.push(join4(full, `${agentName}.md`));
        } else {
          walkForAgent(full, agentName, result);
        }
      }
    }
  } catch {
  }
}
function walkForSkills(dir, result) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules")
        continue;
      const full = join4(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "skills") {
          result.push(full);
        } else {
          walkForSkills(full, result);
        }
      }
    }
  } catch {
  }
}

// orchestrator/session/loop.js
var MAX_ITERATIONS = 10;
async function executeTool(name, args, cwd) {
  if (name === "skill") {
    const skillName = args.name;
    if (!skillName)
      return "Error: skill name is required";
    const content = loadSkillContent(skillName, cwd);
    return content || `Error: skill "${skillName}" not found`;
  }
  if (isMcpTool(name)) {
    return executeMcpTool(name, args);
  }
  if (isBuiltinTool(name)) {
    return executeBuiltinTool(name, args, cwd);
  }
  return `Error: unknown tool "${name}"`;
}
async function agentLoop(provider, messages, model, tools, onToolCall, cwd, sendOpts) {
  let iterations = 0;
  let toolCallsTotal = 0;
  let lastUsage;
  let response;
  const opts = sendOpts || {};
  while (true) {
    response = await provider.send(messages, model, tools.length ? tools : void 0, opts);
    iterations++;
    if (response.usage) {
      if (lastUsage) {
        lastUsage.inputTokens += response.usage.inputTokens;
        lastUsage.outputTokens += response.usage.outputTokens;
      } else {
        lastUsage = { ...response.usage };
      }
    }
    if (!response.toolCalls?.length)
      break;
    if (iterations > MAX_ITERATIONS) {
      response.content = (response.content || "") + `

[Agent loop stopped: reached ${MAX_ITERATIONS} iterations]`;
      break;
    }
    const calls = response.toolCalls;
    toolCallsTotal += calls.length;
    onToolCall?.(iterations, calls);
    messages.push({
      role: "assistant",
      content: response.content || "",
      toolCalls: calls
    });
    for (const call of calls) {
      let result;
      try {
        result = await executeTool(call.name, call.arguments, cwd);
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({
        role: "tool",
        content: result,
        toolCallId: call.id
      });
    }
  }
  return {
    ...response,
    usage: lastUsage || response.usage,
    iterations,
    toolCallsTotal
  };
}

// orchestrator/session/store.js
import { readFileSync as readFileSync6, writeFileSync as writeFileSync3, existsSync as existsSync4, mkdirSync as mkdirSync2, readdirSync as readdirSync2, unlinkSync } from "fs";
import { join as join5 } from "path";
import { homedir as homedir4 } from "os";
function getStoreDir() {
  const dir = process.env.CLAUDE_PLUGIN_DATA ? join5(process.env.CLAUDE_PLUGIN_DATA, "sessions") : join5(homedir4(), ".config", "trib-orchestrator", "sessions");
  if (!existsSync4(dir))
    mkdirSync2(dir, { recursive: true });
  return dir;
}
function sessionPath(id) {
  return join5(getStoreDir(), `${id}.json`);
}
function saveSession(session) {
  writeFileSync3(sessionPath(session.id), JSON.stringify(session), "utf-8");
}
function loadSession(id) {
  const path = sessionPath(id);
  if (!existsSync4(path))
    return null;
  try {
    return JSON.parse(readFileSync6(path, "utf-8"));
  } catch {
    return null;
  }
}
function deleteSession(id) {
  const path = sessionPath(id);
  if (!existsSync4(path))
    return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
function listStoredSessions() {
  const dir = getStoreDir();
  if (!existsSync4(dir))
    return [];
  const files = readdirSync2(dir).filter((f) => f.endsWith(".json"));
  const sessions = [];
  for (const f of files) {
    try {
      sessions.push(JSON.parse(readFileSync6(join5(dir, f), "utf-8")));
    } catch {
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// orchestrator/session/manager.js
function resolveToolPreset(preset) {
  const mcp = getMcpTools();
  const skills = collectSkills();
  const skillTool = buildSkillToolDef(skills);
  switch (preset) {
    case "mcp":
      return [...mcp, ...skillTool ? [skillTool] : []];
    case "readonly": {
      const readTools = BUILTIN_TOOLS.filter((t) => ["read", "grep", "glob"].includes(t.name));
      return [...readTools, ...mcp, ...skillTool ? [skillTool] : []];
    }
    case "full":
    default:
      return [...BUILTIN_TOOLS, ...mcp, ...skillTool ? [skillTool] : []];
  }
}
var nextId = 1;
var CONTEXT_WINDOWS = {
  "gpt-4o": 128e3,
  "gpt-4.1": 1e6,
  "gpt-4.1-mini": 1e6,
  "o4-mini": 2e5,
  "gpt-5.4-mini": 1e6,
  "gpt-5.4": 1e6,
  "gpt-5.4-nano": 1e6,
  "gpt-5.4-pro": 1e6,
  "gpt-5.2-codex": 1e6,
  "gpt-5.2": 1e6,
  "gpt-5.1-codex": 1e6,
  "claude-opus-4-0": 2e5,
  "claude-sonnet-4-0": 2e5,
  "claude-haiku-4-5-20251001": 2e5,
  "gemini-2.5-pro": 1e6,
  "gemini-2.5-flash": 1e6,
  "gemini-2.0-flash": 1e6,
  "llama-3.3-70b-versatile": 128e3,
  "llama3.3:latest": 8192,
  "grok-3-beta": 131072
};
function guessContextWindow(model) {
  if (CONTEXT_WINDOWS[model])
    return CONTEXT_WINDOWS[model];
  if (model.includes("llama") || model.includes("mistral") || model.includes("phi"))
    return 8192;
  return 128e3;
}
function createSession(opts) {
  const presetObj = opts.preset && typeof opts.preset === "object" ? opts.preset : null;
  const providerName = presetObj?.provider || opts.provider;
  const modelName = presetObj?.model || opts.model;
  const toolPreset = presetObj?.tools || (typeof opts.preset === "string" ? opts.preset : null) || opts.tools || "full";
  const effort = presetObj?.effort || opts.effort || null;
  const fast = presetObj?.fast === true || opts.fast === true;
  if (!providerName)
    throw new Error("createSession: provider is required");
  if (!modelName)
    throw new Error("createSession: model is required");
  const provider = getProvider(providerName);
  if (!provider)
    throw new Error(`Provider "${providerName}" not found or not enabled`);
  const id = `sess_${nextId++}_${Date.now()}`;
  const messages = [];
  const claudeMd = collectClaudeMd(opts.cwd);
  const agentTemplate = opts.agent ? loadAgentTemplate(opts.agent, opts.cwd) : null;
  const skills = collectSkills(opts.cwd);
  const skillsSummary = skills.length ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") : void 0;
  const systemPrompt = composeSystemPrompt({
    userPrompt: opts.systemPrompt,
    claudeMd: claudeMd || void 0,
    agentTemplate: agentTemplate || void 0,
    skillsSummary
  });
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  if (opts.files?.length) {
    const fileContext = opts.files.map((f) => `### ${f.path}
\`\`\`
${f.content}
\`\`\``).join("\n\n");
    messages.push({ role: "user", content: `Reference files:

${fileContext}` });
    messages.push({ role: "assistant", content: "Understood. I have the files in context." });
  }
  const tools = resolveToolPreset(toolPreset);
  const session = {
    id,
    provider: providerName,
    model: modelName,
    messages,
    contextWindow: guessContextWindow(modelName),
    tools,
    preset: toolPreset,
    presetName: presetObj?.name || null,
    effort,
    fast,
    agent: opts.agent,
    cwd: opts.cwd,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalInputTokens: 0,
    totalOutputTokens: 0
  };
  saveSession(session);
  return session;
}
async function askSession(sessionId, prompt, context, onToolCall, cwdOverride) {
  const session = loadSession(sessionId);
  if (!session)
    throw new Error(`Session "${sessionId}" not found`);
  const provider = getProvider(session.provider);
  if (!provider)
    throw new Error(`Provider "${session.provider}" not available`);
  if (context) {
    session.messages.push({ role: "user", content: `Additional context:

${context}` });
    session.messages.push({ role: "assistant", content: "Noted." });
  }
  const beforeCount = session.messages.length + 1;
  const budget = Math.floor(session.contextWindow * 0.8);
  const outgoing = trimMessages([...session.messages, { role: "user", content: prompt }], budget);
  const messagesDropped = beforeCount - outgoing.length;
  const effectiveCwd = cwdOverride || session.cwd;
  const result = await agentLoop(provider, outgoing, session.model, session.tools, onToolCall, effectiveCwd, {
    effort: session.effort || null,
    fast: session.fast === true
  });
  session.messages = outgoing;
  if (result.content) {
    session.messages.push({ role: "assistant", content: result.content });
  }
  session.updatedAt = Date.now();
  if (result.usage) {
    session.totalInputTokens += result.usage.inputTokens;
    session.totalOutputTokens += result.usage.outputTokens;
  }
  saveSession(session);
  return {
    ...result,
    trimmed: messagesDropped > 0,
    messagesDropped
  };
}
function resumeSession(sessionId, preset) {
  const session = loadSession(sessionId);
  if (!session)
    return null;
  session.tools = resolveToolPreset(preset || session.preset || "full");
  saveSession(session);
  return session;
}
function listSessions() {
  return listStoredSessions();
}
function closeSession(id) {
  return deleteSession(id);
}

// orchestrator/config.js
import { readFileSync as readFileSync7, existsSync as existsSync5, renameSync, writeFileSync as writeFileSync4, mkdirSync as mkdirSync3 } from "fs";
import { join as join6, dirname } from "path";
import { homedir as homedir5 } from "os";
var ENV_KEY_MAP = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  xai: "XAI_API_KEY"
};
function buildDefaultConfig() {
  const providers2 = {};
  for (const [name, envKey] of Object.entries(ENV_KEY_MAP)) {
    const apiKey = process.env[envKey];
    providers2[name] = {
      enabled: !!apiKey,
      apiKey: apiKey || void 0
    };
  }
  providers2.copilot = {
    enabled: !!loadGitHubToken(),
    baseURL: "https://api.githubcopilot.com"
  };
  const hasCodexAuth = existsSync5(join6(homedir5(), ".codex", "auth.json"));
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  const hasOwnAuth = pluginData && existsSync5(join6(pluginData, "openai-oauth.json")) || existsSync5(join6(homedir5(), ".config", "trib-orchestrator", "openai-oauth.json"));
  providers2["openai-oauth"] = { enabled: hasCodexAuth || hasOwnAuth };
  providers2.ollama = { enabled: false, baseURL: "http://localhost:11434/v1" };
  providers2.lmstudio = { enabled: false, baseURL: "http://localhost:1234/v1" };
  return { providers: providers2 };
}
function migrateMcpToolsFile(configPath) {
  const dir = dirname(configPath);
  const legacyPath = join6(dir, "mcp-tools.json");
  if (!existsSync5(legacyPath))
    return;
  let configRaw = {};
  try {
    configRaw = JSON.parse(readFileSync7(configPath, "utf-8"));
  } catch {
    return;
  }
  if (configRaw.mcpServers && Object.keys(configRaw.mcpServers).length > 0) {
    return;
  }
  let legacyRaw = {};
  try {
    legacyRaw = JSON.parse(readFileSync7(legacyPath, "utf-8"));
  } catch {
    return;
  }
  const legacyServers = legacyRaw.mcpServers || legacyRaw;
  if (!legacyServers || typeof legacyServers !== "object" || Object.keys(legacyServers).length === 0) {
    return;
  }
  configRaw.mcpServers = legacyServers;
  try {
    mkdirSync3(dirname(configPath), { recursive: true });
    const tmp = configPath + ".tmp";
    writeFileSync4(tmp, JSON.stringify(configRaw, null, 2) + "\n", "utf-8");
    renameSync(tmp, configPath);
    renameSync(legacyPath, legacyPath + ".bak");
    process.stderr.write(`[trib-orchestrator] Migrated mcp-tools.json -> config.json (backup at ${legacyPath}.bak)
`);
  } catch (err) {
    process.stderr.write(`[trib-orchestrator] mcp-tools.json migration failed: ${err}
`);
  }
}
function loadConfig() {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  const configPaths = [
    ...pluginData ? [join6(pluginData, "config.json")] : [],
    join6(process.cwd(), "trib-orchestrator.json"),
    join6(homedir5(), ".config", "trib-orchestrator", "config.json"),
    join6(homedir5(), ".trib-orchestrator.json")
  ];
  for (const configPath of configPaths) {
    if (existsSync5(configPath)) {
      migrateMcpToolsFile(configPath);
      try {
        const raw = JSON.parse(readFileSync7(configPath, "utf-8"));
        const defaults2 = buildDefaultConfig();
        return {
          providers: { ...defaults2.providers, ...raw.providers },
          mcpServers: raw.mcpServers || {},
          presets: Array.isArray(raw.presets) ? raw.presets : [],
          default: raw.default || null
        };
      } catch {
      }
    }
  }
  const defaults = buildDefaultConfig();
  return { ...defaults, mcpServers: {}, presets: [], default: null };
}

// server.mjs
var INSTRUCTIONS = [
  "Tools: `TeamCreate`, `TaskCreate`, `Agent`(subagent_type=Worker/Reviewer, team_name required).",
  "Lead delegates all work to Workers via `Agent`. Lead never uses Read/Write/Edit/Bash/Glob/Grep.",
  "Workflow skill must be invoked before any work begins.",
  "",
  "Orchestrator MCP tools: `create_session`, `list_sessions`, `close_session`, `list_models`.",
  "Use create_session to spawn external AI sessions with tool access (preset: full/readonly/mcp).",
  "Sessions auto-inject CLAUDE.md, agent rules, skills, and register builtin+MCP tools.",
  'ask runs via CLI: `node "${CLAUDE_PLUGIN_ROOT}/orchestrator/cli.js" ask <sessionId> "prompt"` (supports --background, --context).'
].join("\n");
var server = new Server(
  { name: "trib-agent", version: "0.0.5" },
  { capabilities: { tools: {}, experimental: { "claude/channel": {} } }, instructions: INSTRUCTIONS }
);
function ok(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function fail(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}
function notify(text) {
  server.notification({
    method: "notifications/claude/channel",
    params: {
      content: text,
      meta: { user: "trib-orchestrator", user_id: "system", ts: (/* @__PURE__ */ new Date()).toISOString() }
    }
  }).catch(() => {
  });
}
function fmtTokens(n) {
  if (typeof n !== "number") return String(n ?? "?");
  if (n < 1e3) return String(n);
  return `${(n / 1e3).toFixed(1)}k`;
}
var jobSeq = 1;
var TOOLS = [
  {
    name: "create_session",
    description: 'Create an external AI session. Auto-injects CLAUDE.md, agent rules, skills. Registers builtin+MCP tools. Use preset: "full"/"readonly"/"mcp". Use agent: "Worker"/"Reviewer" for role rules. Pass cwd for project-scoped tool execution.',
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "openai, openai-oauth, anthropic, gemini, groq, openrouter, xai, copilot, ollama, lmstudio, local" },
        model: { type: "string", description: "e.g., gpt-4o, claude-sonnet-4-0, gemini-2.5-pro" },
        systemPrompt: { type: "string", description: "Additional system prompt" },
        agent: { type: "string", description: 'Agent template: "Worker", "Reviewer"' },
        preset: { type: "string", enum: ["full", "readonly", "mcp"], description: "Tool preset (default: full)" },
        files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
        cwd: { type: "string", description: "Working directory for builtin tool execution and CLAUDE.md/agents/skills lookup. Pass the project root (e.g. C:/Project). Defaults to MCP server cwd." }
      },
      required: ["provider", "model"]
    }
  },
  {
    name: "ask",
    description: "Send message to session. Async \u2014 returns jobId, result via notification. Model can use tools (bash, read, write, edit, grep, glob, MCP, skills) via auto tool loop. Optional cwd overrides session cwd.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        prompt: { type: "string" },
        context: { type: "string", description: "Additional context to inject" },
        cwd: { type: "string", description: "Override working directory for this turn (default: session cwd or MCP server cwd)" }
      },
      required: ["sessionId", "prompt"]
    }
  },
  {
    name: "list_sessions",
    description: "List all active orchestrator sessions.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "close_session",
    description: "Close an orchestrator session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "list_models",
    description: "List available models from all enabled providers.",
    inputSchema: { type: "object", properties: {} }
  }
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};
  try {
    switch (name) {
      case "create_session": {
        const session = createSession(args);
        return ok({
          sessionId: session.id,
          provider: session.provider,
          model: session.model,
          contextWindow: session.contextWindow,
          toolsAvailable: session.tools.length,
          toolNames: session.tools.map((t) => t.name)
        });
      }
      case "ask": {
        const session = resumeSession(args.sessionId);
        if (!session) return fail(`Session "${args.sessionId}" not found`);
        const jobId = `job_${jobSeq++}_${Date.now()}`;
        const startedAt = Date.now();
        askSession(
          args.sessionId,
          args.prompt,
          args.context,
          (iteration, calls) => {
            const names = calls.map((c) => c.name).join(", ");
            notify(`\u{1F527} [${session.provider}/${session.model}] Tool #${iteration}: ${names}
_job: ${jobId}_`);
          },
          args.cwd
        ).then((result) => {
          const elapsed = ((Date.now() - startedAt) / 1e3).toFixed(1);
          const inTok = fmtTokens(result.usage?.inputTokens);
          const outTok = fmtTokens(result.usage?.outputTokens);
          const trimNote = result.trimmed ? ` \xB7 trimmed (-${result.messagesDropped} msgs)` : "";
          const loopNote = result.iterations > 1 ? ` \xB7 ${result.iterations} loops, ${result.toolCallsTotal} tool calls` : "";
          notify(
            `**[${session.provider}/${session.model}]** (${elapsed}s)

${result.content}

---
_job: ${jobId} \xB7 ${inTok} in \xB7 ${outTok} out${trimNote}${loopNote}_`
          );
        }).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          const elapsed = ((Date.now() - startedAt) / 1e3).toFixed(1);
          notify(`**[${session.provider}/${session.model}]** FAILED (${elapsed}s)

${msg}

---
_job: ${jobId}_`);
        });
        return ok({ jobId, status: "working", toolsAvailable: session.tools.length });
      }
      case "list_sessions": {
        return ok(listSessions().map((s) => ({
          id: s.id,
          provider: s.provider,
          model: s.model,
          messages: s.messages.length,
          tools: s.tools.length,
          inputTokens: s.totalInputTokens,
          outputTokens: s.totalOutputTokens,
          createdAt: new Date(s.createdAt).toISOString()
        })));
      }
      case "close_session": {
        const closed = closeSession(args.sessionId);
        return ok(closed ? `Session ${args.sessionId} closed.` : `Session ${args.sessionId} not found.`);
      }
      case "list_models": {
        const results = [];
        for (const [provName, provider] of getAllProviders()) {
          try {
            const models = await provider.listModels();
            results.push({ provider: provName, models: models.map((m) => ({ id: m.id, name: m.name })) });
          } catch {
            results.push({ provider: provName, models: [] });
          }
        }
        return ok(results);
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err);
  }
});
async function main() {
  const config = loadConfig();
  await initProviders(config.providers);
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    process.stderr.write(`[trib-agent] Loading ${Object.keys(config.mcpServers).length} MCP tool server(s) from config.json
`);
    await connectMcpServers(config.mcpServers);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on("SIGINT", async () => {
    await disconnectAll();
    process.exit(0);
  });
}
main().catch((err) => {
  process.stderr.write(`[trib-agent] Failed to start: ${err}
`);
  process.exit(1);
});
