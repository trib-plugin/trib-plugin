#!/usr/bin/env node

// server.mjs
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// lib/config.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
var currentDir = path.dirname(fileURLToPath(import.meta.url));
var PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(currentDir, "..");
var DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(PLUGIN_ROOT, ".trib-search-data");
var CONFIG_PATH = path.join(DATA_DIR, "config.json");
var USAGE_PATH = path.join(DATA_DIR, "usage.local.json");
var CACHE_PATH = path.join(DATA_DIR, "cache.local.json");
var CLI_HOME_DIR = path.join(DATA_DIR, "cli-home");
var DEFAULT_CONFIG = {
  rawSearch: {
    priority: ["serper", "brave", "perplexity", "firecrawl", "tavily", "xai"],
    maxResults: 10,
    credentials: {
      serper: {
        apiKey: ""
      },
      brave: {
        apiKey: ""
      },
      perplexity: {
        apiKey: ""
      },
      firecrawl: {
        apiKey: ""
      },
      tavily: {
        apiKey: ""
      },
      xai: {
        apiKey: ""
      },
      github: {
        token: ""
      }
    }
  },
  aiSearch: {
    priority: ["codex", "claude", "grok", "gemini"],
    timeoutMs: 12e4,
    profiles: {
      grok: {
        connection: "api",
        apiKey: "",
        model: "grok-4.20-0309-reasoning",
        xSearchEnabled: true
      },
      gemini: {
        connection: "cli",
        model: "gemini-2.5-pro"
      },
      claude: {
        connection: "cli",
        model: "sonnet",
        effort: "medium",
        fastMode: false
      },
      codex: {
        connection: "cli",
        model: "gpt-5.4",
        effort: "xhigh",
        fastMode: true
      }
    }
  },
  requestTimeoutMs: 3e4,
  crawl: {
    maxPages: 10,
    maxDepth: 2,
    sameDomainOnly: true
  },
  siteRules: {
    "x.com": {
      search: "xai.x_search",
      scrape: "xai.x_search"
    }
  }
};
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}
function ensureDataDir() {
  ensureDir(DATA_DIR);
  ensureDir(CLI_HOME_DIR);
}
function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}
function normalizeLegacyConfig(config) {
  if (!config) return DEFAULT_CONFIG;
  if (config.rawSearch || config.aiSearch || config.siteRules) {
    return config;
  }
  return {
    rawSearch: {
      priority: config.rawProviders || DEFAULT_CONFIG.rawSearch.priority,
      maxResults: config.rawMaxResults || DEFAULT_CONFIG.rawSearch.maxResults,
      credentials: {
        ...DEFAULT_CONFIG.rawSearch.credentials,
        serper: {
          apiKey: config.serperApiKey || DEFAULT_CONFIG.rawSearch.credentials.serper.apiKey
        },
        brave: {
          apiKey: config.braveApiKey || DEFAULT_CONFIG.rawSearch.credentials.brave.apiKey
        },
        perplexity: {
          apiKey: config.perplexityApiKey || DEFAULT_CONFIG.rawSearch.credentials.perplexity.apiKey
        },
        firecrawl: {
          apiKey: config.firecrawlApiKey || DEFAULT_CONFIG.rawSearch.credentials.firecrawl.apiKey
        },
        tavily: {
          apiKey: config.tavilyApiKey || DEFAULT_CONFIG.rawSearch.credentials.tavily.apiKey
        },
        xai: {
          apiKey: config.xaiApiKey || config.grokApiKey || DEFAULT_CONFIG.rawSearch.credentials.xai.apiKey
        }
      }
    },
    aiSearch: {
      priority: config.aiPriority || (config.aiDefaultProvider ? [config.aiDefaultProvider, ...DEFAULT_CONFIG.aiSearch.priority.filter((item) => item !== config.aiDefaultProvider)] : DEFAULT_CONFIG.aiSearch.priority),
      timeoutMs: config.aiTimeoutMs || DEFAULT_CONFIG.aiSearch.timeoutMs,
      profiles: {
        grok: {
          ...DEFAULT_CONFIG.aiSearch.profiles.grok,
          apiKey: config.grokApiKey || DEFAULT_CONFIG.aiSearch.profiles.grok.apiKey,
          model: config.aiModels?.grok || DEFAULT_CONFIG.aiSearch.profiles.grok.model
        },
        gemini: {
          ...DEFAULT_CONFIG.aiSearch.profiles.gemini,
          model: config.aiModels?.gemini || DEFAULT_CONFIG.aiSearch.profiles.gemini.model
        },
        claude: {
          ...DEFAULT_CONFIG.aiSearch.profiles.claude,
          model: config.aiModels?.claude || DEFAULT_CONFIG.aiSearch.profiles.claude.model
        },
        codex: {
          ...DEFAULT_CONFIG.aiSearch.profiles.codex,
          model: config.aiModels?.codex || DEFAULT_CONFIG.aiSearch.profiles.codex.model
        }
      }
    },
    requestTimeoutMs: config.requestTimeoutMs || DEFAULT_CONFIG.requestTimeoutMs,
    crawl: {
      ...DEFAULT_CONFIG.crawl,
      ...config.crawl || {}
    },
    siteRules: DEFAULT_CONFIG.siteRules
  };
}
function loadConfig() {
  ensureDataDir();
  const config = readJson(CONFIG_PATH, null);
  if (!config) {
    writeJson(CONFIG_PATH, DEFAULT_CONFIG);
    process.stderr.write(
      `trib-search: default config created at ${CONFIG_PATH}
  use /setup to change provider priority and crawl defaults.
`
    );
  }
  const resolved = normalizeLegacyConfig(config || DEFAULT_CONFIG);
  return {
    ...DEFAULT_CONFIG,
    ...resolved,
    rawSearch: {
      ...DEFAULT_CONFIG.rawSearch,
      ...resolved?.rawSearch || {},
      credentials: {
        ...DEFAULT_CONFIG.rawSearch.credentials,
        ...resolved?.rawSearch?.credentials || {}
      }
    },
    aiSearch: {
      ...DEFAULT_CONFIG.aiSearch,
      ...resolved?.aiSearch || {},
      profiles: {
        ...DEFAULT_CONFIG.aiSearch.profiles,
        ...resolved?.aiSearch?.profiles || {}
      }
    },
    crawl: {
      ...DEFAULT_CONFIG.crawl,
      ...resolved?.crawl || {}
    },
    siteRules: {
      ...DEFAULT_CONFIG.siteRules,
      ...resolved?.siteRules || {}
    }
  };
}
function getRawSearchPriority(config) {
  return config.rawSearch?.priority || DEFAULT_CONFIG.rawSearch.priority;
}
function getRawSearchMaxResults(config) {
  return config.rawSearch?.maxResults || DEFAULT_CONFIG.rawSearch.maxResults;
}
function getRawProviderApiKey(config, provider) {
  const cred = config.rawSearch?.credentials?.[provider];
  if (provider === "github") return cred?.token || "";
  return cred?.apiKey || "";
}
function getRawProviderCredentialSource(config, provider, env = process.env) {
  if (getRawProviderApiKey(config, provider)) {
    return "config";
  }
  const envKeyByProvider = {
    serper: "SERPER_API_KEY",
    brave: "BRAVE_API_KEY",
    perplexity: "PERPLEXITY_API_KEY",
    firecrawl: "FIRECRAWL_API_KEY",
    tavily: "TAVILY_API_KEY",
    xai: ["XAI_API_KEY", "GROK_API_KEY"],
    github: "GITHUB_TOKEN"
  };
  const envKey = envKeyByProvider[provider];
  if (envKey) {
    const keys = Array.isArray(envKey) ? envKey : [envKey];
    if (keys.some((k) => env?.[k])) {
      return "env";
    }
  }
  return null;
}
function getAiSearchPriority(config) {
  return config.aiSearch?.priority || DEFAULT_CONFIG.aiSearch.priority;
}
function getAiTimeoutMs(config) {
  return config.aiSearch?.timeoutMs || DEFAULT_CONFIG.aiSearch.timeoutMs;
}
function getAiProfile(config, provider) {
  return config.aiSearch?.profiles?.[provider] || DEFAULT_CONFIG.aiSearch.profiles?.[provider] || {};
}
function getSiteRule(config, site) {
  return config.siteRules?.[site] || null;
}
function getRequestTimeoutMs(config) {
  return config.requestTimeoutMs || DEFAULT_CONFIG.requestTimeoutMs;
}
function getFirecrawlApiKey(config) {
  return getRawProviderApiKey(config, "firecrawl") || config.firecrawlApiKey || "";
}

// lib/cache.mjs
import crypto from "crypto";
var DEFAULT_CACHE_STATE = {
  entries: {}
};
var FLUSH_DELAY_MS = 5e3;
var cacheDirty = false;
var cacheFlushTimer = null;
var activeCacheState = null;
function nowMs() {
  return Date.now();
}
function scheduleCacheFlush(state) {
  cacheDirty = true;
  activeCacheState = state;
  if (cacheFlushTimer) return;
  cacheFlushTimer = setTimeout(() => {
    flushCacheState();
  }, FLUSH_DELAY_MS);
}
function flushCacheState() {
  if (cacheFlushTimer) {
    clearTimeout(cacheFlushTimer);
    cacheFlushTimer = null;
  }
  if (cacheDirty && activeCacheState) {
    writeJson(CACHE_PATH, activeCacheState);
    cacheDirty = false;
  }
}
process.on("exit", flushCacheState);
var _instance = null;
function loadCacheState() {
  if (_instance) return _instance;
  const state = readJson(CACHE_PATH, DEFAULT_CACHE_STATE);
  if (!state.entries || typeof state.entries !== "object") {
    state.entries = {};
  }
  _instance = state;
  activeCacheState = state;
  pruneExpiredEntries(state);
  return state;
}
function buildCacheKey(namespace, payload) {
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `${namespace}:${hash}`;
}
function getCachedEntry(state, key) {
  const entry = state.entries[key];
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= nowMs()) {
    delete state.entries[key];
    scheduleCacheFlush(state);
    return null;
  }
  return entry;
}
function setCachedEntry(state, key, payload, ttlMs) {
  const cachedAt = nowMs();
  state.entries[key] = {
    cachedAt,
    expiresAt: cachedAt + ttlMs,
    payload
  };
  scheduleCacheFlush(state);
  return state.entries[key];
}
function buildCacheMeta(entry, hit) {
  return {
    hit,
    cachedAt: entry ? new Date(entry.cachedAt).toISOString() : null,
    expiresAt: entry ? new Date(entry.expiresAt).toISOString() : null
  };
}
function pruneExpiredEntries(state) {
  const current = nowMs();
  let dirty = false;
  for (const [key, entry] of Object.entries(state.entries)) {
    if (entry?.expiresAt && entry.expiresAt <= current) {
      delete state.entries[key];
      dirty = true;
    }
  }
  if (dirty) {
    scheduleCacheFlush(state);
  }
}

// lib/provider-usage.mjs
async function fetchJson(url, apiKey) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
  if (!response.ok) {
    throw new Error(`Usage request failed: ${response.status}`);
  }
  return response.json();
}
async function fetchFirecrawlUsage(apiKey) {
  if (!apiKey) return null;
  const payload = await fetchJson("https://api.firecrawl.dev/v2/team/credit-usage", apiKey);
  const data = payload?.data;
  if (!data) return null;
  return {
    remaining: typeof data.remainingCredits === "number" ? data.remainingCredits : null,
    limit: typeof data.planCredits === "number" && data.planCredits > 0 ? data.planCredits : null,
    resetAt: data.billingPeriodEnd || null
  };
}
async function fetchTavilyUsage(apiKey) {
  if (!apiKey) return null;
  const payload = await fetchJson("https://api.tavily.com/usage", apiKey);
  const key = payload?.key;
  if (!key) return null;
  const usage = typeof key.usage === "number" ? key.usage : null;
  const limit = typeof key.limit === "number" && key.limit > 0 ? key.limit : null;
  return {
    remaining: usage !== null && limit !== null ? Math.max(limit - usage, 0) : null,
    limit,
    resetAt: null
  };
}
async function fetchProviderUsageSnapshot(provider, env = process.env) {
  switch (provider) {
    case "firecrawl":
      return fetchFirecrawlUsage(env.FIRECRAWL_API_KEY);
    case "tavily":
      return fetchTavilyUsage(env.TAVILY_API_KEY);
    default:
      return null;
  }
}

// lib/state.mjs
var FLUSH_DELAY_MS2 = 5e3;
var usageDirty = false;
var usageFlushTimer = null;
var activeUsageState = null;
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function defaultState() {
  return {
    providers: {},
    routingCache: {
      rawBySite: {},
      scrapeByHost: {}
    }
  };
}
function scheduleUsageFlush(state) {
  usageDirty = true;
  activeUsageState = state;
  if (usageFlushTimer) return;
  usageFlushTimer = setTimeout(() => {
    flushUsageState();
  }, FLUSH_DELAY_MS2);
}
function flushUsageState() {
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer);
    usageFlushTimer = null;
  }
  if (usageDirty && activeUsageState) {
    writeJson(USAGE_PATH, activeUsageState);
    usageDirty = false;
  }
}
process.on("exit", flushUsageState);
var _instance2 = null;
function loadUsageState() {
  if (_instance2) return _instance2;
  const state = readJson(USAGE_PATH, defaultState());
  _instance2 = state;
  activeUsageState = state;
  return state;
}
function saveUsageState(state) {
  scheduleUsageFlush(state);
}
function updateProviderState(state, provider, patch) {
  let normalizedPatch = { ...patch };
  const remaining = typeof normalizedPatch.remaining === "number" ? normalizedPatch.remaining : null;
  const limit = typeof normalizedPatch.limit === "number" ? normalizedPatch.limit : null;
  if (limit && limit > 0 && remaining !== null && typeof normalizedPatch.percentUsed !== "number") {
    normalizedPatch.percentUsed = Number(((limit - remaining) / limit * 100).toFixed(2));
  }
  state.providers[provider] = {
    ...state.providers[provider] || {},
    ...normalizedPatch,
    updatedAt: normalizedPatch.updatedAt || now()
  };
  scheduleUsageFlush(state);
}
function noteProviderSuccess(state, provider, extra = {}) {
  updateProviderState(state, provider, {
    ...extra,
    error: null,
    lastUsedAt: now(),
    lastSuccessAt: now(),
    cooldownUntil: null
  });
}
function noteProviderFailure(state, provider, errorMessage, cooldownMs = 0) {
  const payload = {
    error: errorMessage,
    lastUsedAt: now(),
    lastFailureAt: now()
  };
  if (cooldownMs > 0) {
    payload.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
  }
  updateProviderState(state, provider, payload);
}
function rankProviders(baseProviders, state, site) {
  const currentTime = Date.now();
  const filtered = baseProviders.filter((provider) => {
    const info = state.providers?.[provider];
    if (!info?.cooldownUntil) return true;
    return new Date(info.cooldownUntil).getTime() <= currentTime;
  });
  const ranked = filtered.length > 0 ? filtered : [...baseProviders];
  if (!site) return ranked;
  const preferred = state.routingCache?.rawBySite?.[site];
  if (!preferred || !Array.isArray(preferred) || preferred.length === 0) {
    return ranked;
  }
  const order = new Map(preferred.map((provider, index) => [provider, index]));
  return ranked.sort((left, right) => {
    const leftIndex = order.has(left) ? order.get(left) : Number.MAX_SAFE_INTEGER;
    const rightIndex = order.has(right) ? order.get(right) : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}
function rememberPreferredRawProviders(state, site, providers) {
  if (!site || !providers?.length) return;
  state.routingCache.rawBySite[site] = [...providers];
  scheduleUsageFlush(state);
}
function rememberPreferredScrapeExtractor(state, host, extractor) {
  if (!host || !extractor) return;
  state.routingCache.scrapeByHost[host] = [extractor];
  scheduleUsageFlush(state);
}
function rankScrapeExtractors(host, state, defaults) {
  const preferred = state.routingCache?.scrapeByHost?.[host];
  let base;
  if (!preferred || !Array.isArray(preferred) || preferred.length === 0) {
    base = [...defaults];
  } else {
    base = [...preferred];
    for (const candidate of defaults) {
      if (!base.includes(candidate)) {
        base.push(candidate);
      }
    }
  }
  const currentTime = Date.now();
  const active = [];
  const coolingDown = [];
  for (const extractor of base) {
    const info = state.providers?.[extractor];
    if (info?.cooldownUntil && new Date(info.cooldownUntil).getTime() > currentTime) {
      coolingDown.push(extractor);
    } else {
      active.push(extractor);
    }
  }
  if (active.length > 0) {
    return [...active, ...coolingDown];
  }
  return coolingDown.sort((a, b) => {
    const aTime = new Date(state.providers?.[a]?.cooldownUntil).getTime();
    const bTime = new Date(state.providers?.[b]?.cooldownUntil).getTime();
    return aTime - bTime;
  });
}

// lib/providers.mjs
var SERPER_ENDPOINTS = {
  web: "https://google.serper.dev/search",
  news: "https://google.serper.dev/news",
  images: "https://google.serper.dev/images"
};
var RAW_PROVIDER_CAPABILITIES = {
  serper: {
    searchTypes: ["web", "news", "images"],
    siteSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: false
    }
  },
  brave: {
    searchTypes: ["web"],
    documentedResultKinds: ["web", "news", "images"],
    siteSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: false
    }
  },
  perplexity: {
    searchTypes: ["web"],
    extendedModes: ["academic", "sec"],
    siteSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: false
    }
  },
  firecrawl: {
    searchTypes: ["web", "news", "images"],
    siteSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: true
    }
  },
  tavily: {
    searchTypes: ["web", "news"],
    siteSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: true
    }
  },
  xai: {
    searchTypes: ["web", "x-posts"],
    siteSearch: true,
    xContentSearch: true,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: true,
      quota: false
    }
  },
  github: {
    searchTypes: ["repositories", "code", "issues"],
    readTypes: ["file", "repo", "issue", "pulls"],
    siteSearch: false,
    xContentSearch: false,
    usageSupport: {
      available: false,
      timestamps: false,
      cost: false,
      quota: false
    }
  }
};
function normalizeKeywords(keywords) {
  if (Array.isArray(keywords)) {
    return keywords.filter(Boolean).join(" ").trim();
  }
  return String(keywords || "").trim();
}
function buildQuery(keywords, site) {
  const query = normalizeKeywords(keywords);
  if (!site) return query;
  return `${query} site:${site}`.trim();
}
function getAvailableRawProviders(env = process.env) {
  const providers = [];
  if (env.SERPER_API_KEY) providers.push("serper");
  if (env.BRAVE_API_KEY) providers.push("brave");
  if (env.PERPLEXITY_API_KEY) providers.push("perplexity");
  if (env.FIRECRAWL_API_KEY) providers.push("firecrawl");
  if (env.TAVILY_API_KEY) providers.push("tavily");
  if (env.XAI_API_KEY || env.GROK_API_KEY) providers.push("xai");
  providers.push("github");
  return providers;
}
function inferLocale(query) {
  const hasKorean = /[가-힣]/.test(query);
  return hasKorean ? { country: "KR", language: "ko" } : { country: "US", language: "en" };
}
async function runSerperSearch({ query, type, maxResults }) {
  const endpoint = SERPER_ENDPOINTS[type] || SERPER_ENDPOINTS.web;
  const locale = inferLocale(query);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": process.env.SERPER_API_KEY
    },
    body: JSON.stringify({
      q: query,
      num: maxResults,
      gl: locale.country.toLowerCase(),
      hl: locale.language
    })
  });
  if (!response.ok) {
    throw new Error(`Serper request failed: ${response.status}`);
  }
  const payload = await response.json();
  const rows = payload?.organic || payload?.news || payload?.images || [];
  return rows.slice(0, maxResults).map((item) => ({
    title: item.title || item.source || "",
    url: item.link || item.imageUrl || item.url || "",
    snippet: item.snippet || item.description || "",
    source: item.source || "serper",
    publishedDate: item.date || null,
    provider: "serper"
  }));
}
async function runBraveSearch({ query, maxResults }) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": process.env.BRAVE_API_KEY
    }
  });
  if (!response.ok) {
    throw new Error(`Brave request failed: ${response.status}`);
  }
  const payload = await response.json();
  const rows = payload?.web?.results || [];
  return rows.slice(0, maxResults).map((item) => ({
    title: item.title || "",
    url: item.url || "",
    snippet: item.description || "",
    source: item.profile?.name || "brave",
    publishedDate: item.age || null,
    provider: "brave"
  }));
}
async function runPerplexitySearch({ query, maxResults }) {
  const locale = inferLocale(query);
  const response = await fetch("https://api.perplexity.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.PERPLEXITY_API_KEY}`
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      max_tokens_per_page: 1024,
      country: locale.country
    })
  });
  if (!response.ok) {
    throw new Error(`Perplexity request failed: ${response.status}`);
  }
  const payload = await response.json();
  const rows = payload?.results || [];
  return rows.slice(0, maxResults).map((item) => ({
    title: item.title || "",
    url: item.url || "",
    snippet: item.snippet || "",
    source: "perplexity",
    publishedDate: item.date || null,
    provider: "perplexity"
  }));
}
async function runFirecrawlSearch({ query, type, maxResults }) {
  const locale = inferLocale(query);
  const source = type === "images" ? "images" : type === "news" ? "news" : "web";
  const response = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`
    },
    body: JSON.stringify({
      query,
      limit: maxResults,
      sources: [source],
      country: locale.country
    })
  });
  if (!response.ok) {
    throw new Error(`Firecrawl request failed: ${response.status}`);
  }
  const payload = await response.json();
  const rows = payload?.data?.[source] || [];
  return rows.slice(0, maxResults).map((item) => ({
    title: item.title || "",
    url: item.url || "",
    snippet: item.description || "",
    source: "firecrawl",
    publishedDate: item.publishedDate || null,
    provider: "firecrawl"
  }));
}
async function runTavilySearch({ query, type, maxResults }) {
  const locale = inferLocale(query);
  const topic = type === "news" ? "news" : "general";
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.TAVILY_API_KEY}`
    },
    body: JSON.stringify({
      query,
      topic,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      country: locale.country === "KR" ? "south korea" : "united states"
    })
  });
  if (!response.ok) {
    throw new Error(`Tavily request failed: ${response.status}`);
  }
  const payload = await response.json();
  const rows = payload?.results || [];
  return rows.slice(0, maxResults).map((item) => ({
    title: item.title || "",
    url: item.url || "",
    snippet: item.content || "",
    source: "tavily",
    publishedDate: item.published_date || null,
    provider: "tavily"
  }));
}
function extractXaiSearchAnswer(payload) {
  const message = payload?.output?.find((item) => item?.type === "message");
  const text = message?.content?.find((item) => item?.type === "output_text")?.text || "";
  return text.trim();
}
function extractXaiSearchCitations(payload) {
  const citations = Array.isArray(payload?.citations) ? payload.citations : [];
  return citations.map((item) => ({
    title: item?.title || item?.source || "xai",
    url: item?.url || "",
    snippet: item?.text || item?.snippet || "",
    source: item?.source || "xai",
    publishedDate: item?.published_date || item?.date || null,
    provider: "xai"
  }));
}
function getGithubHeaders() {
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "trib-search"
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}
function handleGithubError(response, context) {
  if (response.status === 401) {
    throw new Error(`GitHub ${context} requires authentication. Set GITHUB_TOKEN in config or environment.`);
  }
  if (response.status === 403) {
    throw new Error("GitHub API rate limit exceeded. Set GITHUB_TOKEN for higher limits.");
  }
  if (response.status === 404) {
    throw new Error(`GitHub ${context}: not found (404).`);
  }
  if (!response.ok) {
    throw new Error(`GitHub ${context} failed: ${response.status}`);
  }
}
async function runGithubRead({ owner, repo, path: path3, ref }) {
  if (!owner || !repo || !path3) {
    throw new Error("owner, repo, and path are required for GitHub file read.");
  }
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path3.split("/").map((s) => encodeURIComponent(s)).join("/")}`);
  if (ref) url.searchParams.set("ref", ref);
  const response = await fetch(url, { headers: getGithubHeaders() });
  handleGithubError(response, "file read");
  const payload = await response.json();
  if (Array.isArray(payload)) {
    return {
      results: payload.map((item) => ({
        title: item.name,
        url: item.html_url || "",
        snippet: `${item.type} \u2014 ${item.path}${item.size ? ` (${item.size} bytes)` : ""}`,
        source: "github",
        publishedDate: null,
        provider: "github"
      })),
      usage: null
    };
  }
  if (payload.size > 1048576) {
    throw new Error(`File too large (${payload.size} bytes). GitHub contents API does not support files over 1 MB.`);
  }
  const content = Buffer.from(payload.content || "", "base64").toString("utf8");
  return {
    results: [{
      title: `${payload.name} (${owner}/${repo})`,
      url: payload.html_url || "",
      snippet: content,
      source: "github",
      publishedDate: null,
      provider: "github",
      meta: { sha: payload.sha, size: payload.size, path: payload.path, encoding: payload.encoding }
    }],
    usage: null
  };
}
async function runGithubRepoInfo({ owner, repo }) {
  if (!owner || !repo) {
    throw new Error("owner and repo are required for GitHub repo info.");
  }
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: getGithubHeaders()
  });
  handleGithubError(response, "repo info");
  const r = await response.json();
  return {
    results: [{
      title: r.full_name || `${owner}/${repo}`,
      url: r.html_url || "",
      snippet: r.description || "",
      source: "github",
      publishedDate: r.updated_at || null,
      provider: "github",
      meta: {
        stars: r.stargazers_count,
        forks: r.forks_count,
        language: r.language,
        default_branch: r.default_branch,
        open_issues: r.open_issues_count,
        license: r.license?.spdx_id || null,
        topics: r.topics || [],
        archived: r.archived,
        created_at: r.created_at
      }
    }],
    usage: null
  };
}
async function runGithubIssueDetail({ owner, repo, number }) {
  if (!owner || !repo || !number) {
    throw new Error("owner, repo, and number are required for GitHub issue detail.");
  }
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, {
    headers: getGithubHeaders()
  });
  handleGithubError(response, "issue detail");
  const issue = await response.json();
  return {
    results: [{
      title: issue.title || "",
      url: issue.html_url || "",
      snippet: issue.body || "",
      source: "github",
      publishedDate: issue.created_at || null,
      provider: "github",
      meta: {
        state: issue.state,
        labels: (issue.labels || []).map((l) => l.name || l),
        comments: issue.comments,
        user: issue.user?.login,
        is_pull_request: !!issue.pull_request,
        closed_at: issue.closed_at
      }
    }],
    usage: null
  };
}
async function runGithubPulls({ owner, repo, state = "open" }) {
  if (!owner || !repo) {
    throw new Error("owner and repo are required for GitHub pulls list.");
  }
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`);
  url.searchParams.set("state", state);
  url.searchParams.set("per_page", "10");
  const response = await fetch(url, { headers: getGithubHeaders() });
  handleGithubError(response, "pulls list");
  const pulls = await response.json();
  return {
    results: pulls.map((pr) => ({
      title: pr.title || "",
      url: pr.html_url || "",
      snippet: (pr.body || "").slice(0, 200),
      source: "github",
      publishedDate: pr.created_at || null,
      provider: "github",
      meta: {
        number: pr.number,
        state: pr.state,
        user: pr.user?.login,
        head: pr.head?.ref,
        base: pr.base?.ref,
        draft: pr.draft,
        merged_at: pr.merged_at
      }
    })),
    usage: null
  };
}
async function runGithubSearch({ query, maxResults, github_type = "repositories" }) {
  const endpoint = `https://api.github.com/search/${github_type}?q=${encodeURIComponent(query)}&per_page=${maxResults}`;
  const response = await fetch(endpoint, { headers: getGithubHeaders() });
  if (response.status === 422) {
    throw new Error(`GitHub API validation error for query: ${query}`);
  }
  handleGithubError(response, `${github_type} search`);
  const payload = await response.json();
  const items = payload?.items || [];
  return items.slice(0, maxResults).map((item) => {
    switch (github_type) {
      case "code":
        return {
          title: `${item.name} in ${item.repository?.full_name || ""}`,
          url: item.html_url || "",
          snippet: item.path || "",
          source: "github",
          publishedDate: null,
          provider: "github"
        };
      case "issues":
        return {
          title: item.title || "",
          url: item.html_url || "",
          snippet: (item.body || "").slice(0, 200),
          source: "github",
          publishedDate: item.created_at || null,
          provider: "github"
        };
      case "repositories":
      default:
        return {
          title: item.full_name || "",
          url: item.html_url || "",
          snippet: item.description || "",
          source: "github",
          publishedDate: item.updated_at || null,
          provider: "github"
        };
    }
  });
}
async function runXaiSearch({ query, maxResults }) {
  const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error("XAI_API_KEY or GROK_API_KEY is required for xai search");
  }
  const response = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "grok-4-1-fast-reasoning",
      input: [
        {
          role: "user",
          content: query
        }
      ],
      tools: [{ type: "x_search" }],
      max_turns: 2,
      tool_choice: "required"
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`xAI search failed: ${response.status} ${body}`);
  }
  const payload = await response.json();
  const citations = extractXaiSearchCitations(payload);
  if (citations.length > 0) {
    return {
      results: citations.slice(0, maxResults),
      usage: payload.usage || null
    };
  }
  const answer = extractXaiSearchAnswer(payload);
  if (!answer) {
    throw new Error("xAI search returned no citations and no text answer");
  }
  return {
    results: [
      {
        title: "xAI x_search summary",
        url: "",
        snippet: answer,
        source: "xai",
        publishedDate: null,
        provider: "xai"
      }
    ],
    usage: payload.usage || null
  };
}
async function searchWithProvider(provider, args) {
  switch (provider) {
    case "serper":
      return { results: await runSerperSearch(args), usage: null };
    case "brave":
      return { results: await runBraveSearch(args), usage: null };
    case "perplexity":
      return { results: await runPerplexitySearch(args), usage: null };
    case "firecrawl":
      return { results: await runFirecrawlSearch(args), usage: null };
    case "tavily":
      return { results: await runTavilySearch(args), usage: null };
    case "xai":
      return runXaiSearch(args);
    case "github": {
      const ghType = args.github_type;
      if (ghType === "file") return runGithubRead(args);
      if (ghType === "repo") return runGithubRepoInfo(args);
      if (ghType === "issue") return runGithubIssueDetail(args);
      if (ghType === "pulls") return runGithubPulls(args);
      return { results: await runGithubSearch(args), usage: null };
    }
    default:
      throw new Error(`Unsupported raw provider: ${provider}`);
  }
}
async function runRawSearch({
  keywords,
  providers,
  site,
  type = "web",
  maxResults = 10,
  github_type,
  owner,
  repo,
  path: path3,
  number,
  ref,
  state
}) {
  const isGithubReadType = ["file", "repo", "issue", "pulls"].includes(github_type);
  const query = isGithubReadType ? keywords ? buildQuery(keywords, site) : "" : buildQuery(keywords, site);
  if (!query && !isGithubReadType) {
    throw new Error("keywords is required");
  }
  if (!providers?.length) {
    throw new Error("No raw providers are available");
  }
  const failures = [];
  for (const provider of providers) {
    try {
      const searchResult = await searchWithProvider(provider, { query, type, maxResults, github_type, owner, repo, path: path3, number, ref, state });
      return {
        mode: "fallback",
        usedProvider: provider,
        query,
        results: searchResult.results,
        usage: searchResult.usage || null,
        failures
      };
    } catch (error) {
      failures.push({
        provider,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  throw new Error(`All raw providers failed: ${failures.map((item) => `${item.provider}: ${item.error}`).join(" | ")}`);
}

// lib/ai-providers.mjs
import os from "os";
import path2 from "path";
import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
var AI_PROVIDER_IDS = ["grok", "gemini", "claude", "codex"];
var AI_PROVIDER_CAPABILITIES = {
  grok: {
    connectionModes: ["api", "cli"],
    answerSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: true,
      quota: false
    }
  },
  gemini: {
    connectionModes: ["cli"],
    answerSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: false
    }
  },
  claude: {
    connectionModes: ["cli"],
    answerSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: false
    }
  },
  codex: {
    connectionModes: ["cli"],
    answerSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: false
    }
  }
};
function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore"
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}
async function getAvailableAiProviders(config = null) {
  const results = [];
  const grokApiKey = config?.aiSearch?.profiles?.grok?.apiKey || "";
  for (const provider of AI_PROVIDER_IDS) {
    if (provider === "grok" && grokApiKey) {
      results.push(provider);
      continue;
    }
    if (await commandExists(provider)) {
      results.push(provider);
    }
  }
  return results;
}
function buildPrompt(query, site) {
  const siteClause = site ? `
Scope: ${site} only.` : "";
  return `Web search query: ${query}${siteClause}

Search the web and return results in this exact format:

## Summary
(2-3 sentence answer to the query)

## Results
1. **[Title](URL)** \u2014 one-line description
2. **[Title](URL)** \u2014 one-line description
3. **[Title](URL)** \u2014 one-line description

Return 3-5 results with real URLs. No made-up links. If you cannot search the web, answer from your knowledge and note that.`;
}
function extractGrokAnswer(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content.map((item) => item?.text || "").join("\n").trim();
  }
  return "";
}
async function runGrokApi(prompt, model, env, timeoutMs) {
  const apiKey = env.XAI_API_KEY || env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error("XAI_API_KEY or GROK_API_KEY is required for Grok API mode");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        model: model || "grok-4",
        stream: false,
        temperature: 0.3
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Grok API failed: ${response.status} ${body}`);
    }
    const payload = await response.json();
    const answer = extractGrokAnswer(payload);
    if (!answer) {
      throw new Error("Grok API returned an empty answer");
    }
    return {
      stdout: answer,
      stderr: null,
      usage: payload.usage || null
    };
  } finally {
    clearTimeout(timer);
  }
}
function extractXSearchAnswer(payload) {
  const message = payload?.output?.find((item) => item?.type === "message");
  const text = message?.content?.find((item) => item?.type === "output_text")?.text || "";
  return text.trim();
}
async function runGrokXSearch(prompt, model, env, timeoutMs) {
  const apiKey = env.XAI_API_KEY || env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error("XAI_API_KEY or GROK_API_KEY is required for x_search mode");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || "grok-4-1-fast-reasoning",
        input: [
          {
            role: "user",
            content: prompt
          }
        ],
        tools: [
          { type: "x_search" }
        ],
        max_turns: 2,
        tool_choice: "required"
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Grok x_search failed: ${response.status} ${body}`);
    }
    const payload = await response.json();
    const answer = extractXSearchAnswer(payload);
    if (!answer) {
      throw new Error("Grok x_search returned an empty answer");
    }
    return {
      stdout: answer,
      stderr: null,
      usage: payload.usage || null
    };
  } finally {
    clearTimeout(timer);
  }
}
function providerHome(provider) {
  const home = path2.join(CLI_HOME_DIR, provider);
  ensureDir(home);
  if (provider === "gemini") {
    ensureDir(path2.join(home, ".gemini"));
  }
  return home;
}
function buildProviderEnv(provider) {
  if (provider === "claude" || provider === "codex") {
    return { ...process.env };
  }
  const home = providerHome(provider);
  return {
    ...process.env,
    HOME: home
  };
}
function buildProviderCwd(provider, env) {
  if (provider === "claude" || provider === "codex") {
    return env.TRIB_SEARCH_EXEC_CWD || env.PWD || env.HOME || os.tmpdir();
  }
  return process.cwd();
}
function isTrue(value) {
  return value === true || value === "true" || value === 1;
}
function runCli(command, args, env, timeoutMs, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const isWin = process.platform === "win32";
    const safeArgs = isWin ? args.map((a) => `"${a.replace(/"/g, '\\"')}"`) : args;
    const child = spawn(command, safeArgs, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
      timeout: timeoutMs || 12e4
    });
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => reject(new Error(`spawn ${command} failed: ${err.message}`)));
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}
function extractCodexAnswer(stdout) {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try {
      const payload = JSON.parse(line);
      if (payload?.type === "item.completed" && payload?.item?.type === "agent_message" && payload.item.text) {
        messages.push(payload.item.text);
      }
    } catch {
    }
  }
  return messages.join("\n\n") || stdout.trim();
}
async function runAiSearch({
  query,
  provider,
  site,
  model,
  profile,
  timeoutMs
}) {
  const finalProvider = provider;
  if (!finalProvider) {
    throw new Error("provider is required for ai_search");
  }
  const env = buildProviderEnv(finalProvider);
  const cwd = buildProviderCwd(finalProvider, env);
  switch (finalProvider) {
    case "grok": {
      const prompt = buildPrompt(query, site);
      const result = env.XAI_API_KEY || env.GROK_API_KEY ? site === "x.com" && profile?.xSearchEnabled !== false ? await runGrokXSearch(prompt, model, env, timeoutMs) : await runGrokApi(prompt, model, env, timeoutMs) : await runCli(
        "grok",
        model ? ["-m", model, "-p", prompt] : ["-p", prompt],
        env,
        timeoutMs,
        cwd
      );
      return {
        provider: "grok",
        model: model || null,
        answer: result.stdout,
        stderr: result.stderr || null,
        usage: result.usage || null
      };
    }
    case "gemini": {
      const prompt = buildPrompt(query, site);
      const args = ["-p", prompt, "--output-format", "text"];
      if (model) {
        args.push("--model", model);
      }
      const result = await runCli(
        "gemini",
        args,
        env,
        timeoutMs,
        cwd
      );
      return {
        provider: "gemini",
        model: model || null,
        answer: result.stdout,
        stderr: result.stderr || null
      };
    }
    case "claude": {
      const prompt = buildPrompt(query, site);
      const tmpDir = path2.join(tmpdir(), "trib-claude-" + Date.now());
      mkdirSync(tmpDir, { recursive: true });
      const args = [
        "--print",
        "--no-session-persistence",
        ...model ? ["--model", model] : [],
        ...profile?.effort ? ["--effort", profile.effort] : [],
        "--",
        prompt
      ];
      const result = await runCli("claude", args, env, timeoutMs, tmpDir);
      return {
        provider: "claude",
        model: model || null,
        answer: result.stdout,
        stderr: result.stderr || null
      };
    }
    case "codex": {
      const prompt = buildPrompt(query, site);
      const effort = profile?.effort || "medium";
      const args = [
        "exec",
        "-c",
        `model_reasoning_effort=${effort}`,
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--json",
        prompt
      ];
      if (isTrue(profile?.fastMode)) {
        args.splice(1, 0, "-c", "service_tier=fast");
      }
      if (model) {
        args.splice(1, 0, "--model", model);
      }
      const result = await runCli("codex", args, env, timeoutMs, cwd);
      return {
        provider: "codex",
        model: model || null,
        answer: extractCodexAnswer(result.stdout),
        stderr: result.stderr || null
      };
    }
    default:
      throw new Error(`Unsupported ai_search provider: ${finalProvider}`);
  }
}

// lib/web-tools.mjs
import fs2, { readFileSync } from "fs";
import { JSDOM } from "jsdom";
import puppeteer from "puppeteer-core";
import { Readability } from "@mozilla/readability";
var PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.1";
  }
})();
var DEFAULT_EXTRACTORS = ["readability", "puppeteer", "firecrawl"];
var COMMON_BROWSER_PATHS = (() => {
  const platform = process.platform;
  if (platform === "win32") {
    return [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
    ];
  }
  if (platform === "linux") {
    return [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
      "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
      "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
    ];
  }
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ];
})();
function getScrapeCapabilities() {
  const browserAvailable = Boolean(
    process.env.PUPPETEER_EXECUTABLE_PATH && fs2.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH) || COMMON_BROWSER_PATHS.some((item) => fs2.existsSync(item))
  );
  return {
    readability: true,
    puppeteer: browserAvailable,
    firecrawl: Boolean(process.env.FIRECRAWL_API_KEY)
  };
}
function normalizeUrl(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}
function withTimeout(controller, timeoutMs) {
  return setTimeout(() => controller.abort(), timeoutMs);
}
function buildHeaders() {
  return {
    "User-Agent": `trib-search/${PKG_VERSION}`,
    "Accept-Language": "ko,en;q=0.8"
  };
}
function buildContentPayload(url, title, content, extractor, extra = {}) {
  const normalized = (content || "").trim();
  if (!normalized) {
    throw new Error(`${extractor} returned empty content`);
  }
  return {
    url,
    title: (title || "").trim(),
    content: normalized,
    excerpt: normalized.slice(0, 240),
    extractor,
    ...extra
  };
}
function extractReadableArticle(url, html) {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (article?.textContent?.trim()) {
    return buildContentPayload(
      url,
      article.title || dom.window.document.title || "",
      article.textContent,
      "readability"
    );
  }
  const bodyText = dom.window.document.body?.textContent?.trim() || "";
  if (!bodyText) {
    throw new Error("readability returned no readable body");
  }
  return buildContentPayload(
    url,
    dom.window.document.title || "",
    bodyText,
    "dom-text"
  );
}
async function fetchHtml(url, timeoutMs) {
  const controller = new AbortController();
  const timer = withTimeout(controller, timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: buildHeaders()
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
async function scrapeWithReadability(url, timeoutMs) {
  const html = await fetchHtml(url, timeoutMs);
  return extractReadableArticle(url, html);
}
function resolveBrowserLaunchOptions() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs2.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH };
  }
  for (const executablePath of COMMON_BROWSER_PATHS) {
    if (fs2.existsSync(executablePath)) {
      return { executablePath };
    }
  }
  return { channel: "chrome" };
}
async function scrapeWithPuppeteer(url, timeoutMs) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      ...resolveBrowserLaunchOptions(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  } catch (error) {
    throw new Error(`puppeteer launch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      "Accept-Language": "ko,en;q=0.8"
    });
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: timeoutMs
    });
    const html = await page.content();
    try {
      return {
        ...extractReadableArticle(url, html),
        extractor: "puppeteer"
      };
    } catch {
      const bodyText = await page.evaluate(() => document.body?.innerText || "");
      return buildContentPayload(url, await page.title(), bodyText, "puppeteer");
    }
  } finally {
    await browser.close().catch(() => {
    });
  }
}
async function scrapeWithFirecrawl(url, timeoutMs) {
  if (!process.env.FIRECRAWL_API_KEY) {
    throw new Error("FIRECRAWL_API_KEY is not configured");
  }
  const controller = new AbortController();
  const timer = withTimeout(controller, timeoutMs);
  try {
    const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: timeoutMs
      })
    });
    if (!response.ok) {
      throw new Error(`Firecrawl scrape failed: ${response.status}`);
    }
    const payload = await response.json();
    const markdown = payload?.data?.markdown || payload?.markdown || "";
    const title = payload?.data?.metadata?.title || payload?.metadata?.title || "";
    return buildContentPayload(url, title, markdown, "firecrawl");
  } finally {
    clearTimeout(timer);
  }
}
async function tryExtractor(extractor, url, timeoutMs) {
  switch (extractor) {
    case "readability":
      return scrapeWithReadability(url, timeoutMs);
    case "puppeteer":
      return scrapeWithPuppeteer(url, timeoutMs);
    case "firecrawl":
      return scrapeWithFirecrawl(url, timeoutMs);
    default:
      throw new Error(`Unknown extractor: ${extractor}`);
  }
}
function filterLinks(rawLinks, baseUrl, { limit = 50, sameDomainOnly = true, search }) {
  const originHost = new URL(baseUrl).host;
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  for (const rawLink of rawLinks) {
    const href = rawLink?.href;
    if (!href) continue;
    let absolute;
    try {
      absolute = normalizeUrl(new URL(href, baseUrl).toString());
    } catch {
      continue;
    }
    if (sameDomainOnly && new URL(absolute).host !== originHost) {
      continue;
    }
    const text = (rawLink.text || "").trim();
    if (search && !absolute.includes(search) && !text.includes(search)) {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    items.push({ url: absolute, text });
    if (items.length >= limit) break;
  }
  return items;
}
function extractLinksFromHtml(baseUrl, html, options) {
  const dom = new JSDOM(html, { url: baseUrl });
  const links = Array.from(dom.window.document.querySelectorAll("a[href]")).map((link) => ({
    href: link.getAttribute("href"),
    text: link.textContent || ""
  }));
  return filterLinks(links, baseUrl, options);
}
async function mapWithHttp(url, options, timeoutMs) {
  const html = await fetchHtml(url, timeoutMs);
  return extractLinksFromHtml(url, html, options);
}
async function mapWithPuppeteer(url, options, timeoutMs) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      ...resolveBrowserLaunchOptions(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: timeoutMs
    });
    const links = await page.$$eval("a[href]", (nodes) => nodes.map((node) => ({
      href: node.getAttribute("href"),
      text: node.textContent || ""
    })));
    return filterLinks(links, url, options);
  } finally {
    await browser?.close().catch(() => {
    });
  }
}
async function scrapeUrl(url, timeoutMs, usageState) {
  const normalizedUrl = normalizeUrl(url);
  const host = new URL(normalizedUrl).host;
  if (host === "x.com" || host === "www.x.com") {
    throw new Error("x.com is not a reliable scrape target. Use ai_search with x_search instead.");
  }
  const extractors = rankScrapeExtractors(host, usageState, DEFAULT_EXTRACTORS);
  const failures = [];
  for (const extractor of extractors) {
    try {
      const page = await tryExtractor(extractor, normalizedUrl, timeoutMs);
      rememberPreferredScrapeExtractor(usageState, host, extractor);
      noteProviderSuccess(usageState, extractor);
      return {
        ...page,
        triedExtractors: extractors,
        failures
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ extractor, error: message });
      noteProviderFailure(usageState, extractor, message, 6e4);
    }
  }
  throw new Error(`All extractors failed for ${normalizedUrl}: ${failures.map((item) => `${item.extractor}: ${item.error}`).join(" | ")}`);
}
async function scrapeUrls(urls, timeoutMs, usageState) {
  const settled = await Promise.allSettled(urls.map((url) => scrapeUrl(url, timeoutMs, usageState)));
  return settled.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      url: urls[index],
      error: result.reason instanceof Error ? result.reason.message : String(result.reason)
    };
  });
}
async function mapSite(url, { limit = 50, sameDomainOnly = true, search }, timeoutMs) {
  const options = { limit, sameDomainOnly, search };
  try {
    const links = await mapWithHttp(url, options, timeoutMs);
    if (links.length > 0) {
      return links;
    }
  } catch {
  }
  return mapWithPuppeteer(url, options, timeoutMs);
}
async function crawlSite(startUrl, { maxPages = 10, maxDepth = 1, sameDomainOnly = true }, timeoutMs, usageState) {
  const visited = /* @__PURE__ */ new Set();
  const queue = [{ url: normalizeUrl(startUrl), depth: 0 }];
  const pages = [];
  while (queue.length > 0 && pages.length < maxPages) {
    const current = queue.shift();
    if (!current || visited.has(current.url)) continue;
    visited.add(current.url);
    try {
      const page = await scrapeUrl(current.url, timeoutMs, usageState);
      pages.push({
        url: current.url,
        depth: current.depth,
        title: page.title,
        excerpt: page.excerpt,
        extractor: page.extractor
      });
    } catch (error) {
      pages.push({
        url: current.url,
        depth: current.depth,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    if (current.depth >= maxDepth) {
      continue;
    }
    let links = [];
    try {
      links = await mapSite(
        current.url,
        {
          limit: maxPages,
          sameDomainOnly
        },
        timeoutMs
      );
    } catch {
      links = [];
    }
    for (const link of links) {
      if (!visited.has(link.url)) {
        queue.push({
          url: link.url,
          depth: current.depth + 1
        });
      }
    }
  }
  return pages;
}

// lib/formatter.mjs
function formatSearchResults(data) {
  const response = data.response || data;
  const results = response.results || response?.results || [];
  if (!results.length) {
    return "(\uAC80\uC0C9 \uACB0\uACFC \uC5C6\uC74C)";
  }
  return results.map((r, i) => {
    const num = i + 1;
    const title = r.title || "(\uC81C\uBAA9 \uC5C6\uC74C)";
    const url = r.url || "";
    const date = r.publishedDate || "";
    const snippet = (r.snippet || "").trim();
    const urlPart = [url, date].filter(Boolean).join(" \u2014 ");
    const lines = [`${num}. ${title}`];
    if (urlPart) lines.push(`   ${urlPart}`);
    if (snippet) lines.push(`   ${snippet}`);
    return lines.join("\n");
  }).join("\n\n");
}
function formatAiSearch(data) {
  const response = data.response || data;
  const answer = response.answer || response.stdout || "";
  if (data.fallbackSource === "search" && response.results) {
    return formatSearchResults(data);
  }
  return answer.trim() || "(\uB2F5\uBCC0 \uC5C6\uC74C)";
}
function formatScrape(data) {
  const pages = data.pages || [];
  if (data.provider === "xai" && data.response) {
    const response = data.response;
    const results = response.results || [];
    if (results.length) {
      return results.map((r) => (r.snippet || "").trim()).filter(Boolean).join("\n\n") || "(\uB0B4\uC6A9 \uC5C6\uC74C)";
    }
    return response.answer || response.stdout || "(\uB0B4\uC6A9 \uC5C6\uC74C)";
  }
  if (!pages.length) {
    return "(\uC2A4\uD06C\uB7A9 \uACB0\uACFC \uC5C6\uC74C)";
  }
  return pages.map((page) => {
    const url = page.url || "";
    const title = page.title || "";
    const content = (page.content || page.excerpt || "").trim();
    const error = page.error;
    if (error) {
      return `[${url}]
(\uC2E4\uD328)`;
    }
    const header = title ? `[${title}] ${url}` : `[${url}]`;
    return `${header}
${content || "(\uB0B4\uC6A9 \uC5C6\uC74C)"}`;
  }).join("\n\n---\n\n");
}
function formatMap(data) {
  const links = data.links || [];
  if (!links.length) {
    return "(\uB9C1\uD06C \uC5C6\uC74C)";
  }
  return links.map((link, i) => {
    const text = (link.text || "").trim();
    const url = link.url || "";
    return text ? `${i + 1}. ${text} \u2014 ${url}` : `${i + 1}. ${url}`;
  }).join("\n");
}
function formatCrawl(data) {
  const pages = data.pages || [];
  if (!pages.length) {
    return "(\uD06C\uB864\uB9C1 \uACB0\uACFC \uC5C6\uC74C)";
  }
  return pages.map((page) => {
    const url = page.url || "";
    const title = page.title || "";
    const excerpt = (page.excerpt || "").trim();
    const error = page.error;
    if (error) {
      return `[${url}]
(\uC2E4\uD328)`;
    }
    const header = title ? `[${title}] ${url}` : `[${url}]`;
    return `${header}
${excerpt || "(\uB0B4\uC6A9 \uC5C6\uC74C)"}`;
  }).join("\n\n---\n\n");
}
function formatBatchItem(item) {
  switch (item.action) {
    case "search":
      if (item.mode === "ai_first" || item.mode === "ai_only") {
        return formatAiSearch(item);
      }
      return formatSearchResults(item);
    case "firecrawl_scrape":
      return formatScrape(item);
    case "firecrawl_map":
      return formatMap(item);
    default:
      if (item.error) return `(\uC624\uB958: ${item.error})`;
      return JSON.stringify(item, null, 2);
  }
}
function formatBatch(data) {
  const results = data.results || [];
  if (!results.length) {
    return "(\uBC30\uCE58 \uACB0\uACFC \uC5C6\uC74C)";
  }
  return results.map((item, i) => {
    const header = `[${i + 1}] ${item.action || "unknown"}${item.status === "error" ? " (\uC624\uB958)" : ""}`;
    if (item.status === "error") {
      return `${header}
${item.error || "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958"}`;
    }
    return `${header}
${formatBatchItem(item)}`;
  }).join("\n\n---\n\n");
}
function formatResponse(tool, rawResult) {
  switch (tool) {
    case "search":
      return formatSearchResults(rawResult);
    case "ai_search":
      return formatAiSearch(rawResult);
    case "scrape":
      return formatScrape(rawResult);
    case "map":
      return formatMap(rawResult);
    case "crawl":
      return formatCrawl(rawResult);
    case "batch":
      return formatBatch(rawResult);
    default:
      return JSON.stringify(rawResult, null, 2);
  }
}

// lib/setup-handler.mjs
import { writeFileSync } from "fs";
function mask(key) {
  if (!key) return "  not set";
  return "  ****" + key.slice(-4);
}
function icon(key) {
  return key ? "\u25CF" : "\u25CB";
}
function statusBlock(config) {
  const c = config.rawSearch?.credentials || {};
  const a = config.aiSearch?.profiles || {};
  const providers = ["serper", "brave", "perplexity", "tavily", "firecrawl", "xai", "github"];
  const aiProviders = ["grok", "firecrawl"];
  const lines = [
    "",
    "  \u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E",
    "  \u2502  trib-search config                   \u2502",
    "  \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F",
    "",
    "  Search Providers",
    "  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"
  ];
  for (const p of providers) {
    const key = c[p]?.apiKey;
    lines.push(`    ${icon(key)} ${p.padEnd(12)}${mask(key)}`);
  }
  lines.push("");
  lines.push("  AI Search");
  lines.push("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  for (const p of aiProviders) {
    const key = a[p]?.apiKey;
    lines.push(`    ${icon(key)} ${p.padEnd(12)}${mask(key)}`);
  }
  lines.push("");
  lines.push("  Options");
  lines.push("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  lines.push(`    priority    ${(config.rawSearch?.priority || []).join(" > ")}`);
  lines.push(`    max results ${config.rawSearch?.maxResults || 10}`);
  lines.push(`    crawl       ${config.crawl?.maxPages || 10} pages / depth ${config.crawl?.maxDepth || 1}`);
  lines.push("");
  return lines.join("\n");
}
function sectionHeader(config) {
  const c = config.rawSearch?.credentials || {};
  const a = config.aiSearch?.profiles || {};
  const total = Object.values(c).filter((x) => x?.apiKey).length + Object.values(a).filter((x) => x?.apiKey).length;
  return [
    "  \u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E",
    "  \u2502  trib-search setup                    \u2502",
    "  \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F",
    "",
    `    ${total > 0 ? "\u25CF" : "\u25CB"} ${total} key(s) configured`,
    ""
  ].join("\n");
}
function keysHeader(title, entries) {
  const lines = [
    "  \u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E",
    `  \u2502  ${title.padEnd(37)}\u2502`,
    "  \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F",
    "",
    '    empty = keep current / "clear" = remove',
    ""
  ];
  for (const [name, key] of entries) {
    lines.push(`    ${icon(key)} ${name.padEnd(12)}${mask(key)}`);
  }
  return lines.join("\n");
}
function applyKeys(config, section, data) {
  const target = section === "rawSearch" ? "credentials" : "profiles";
  for (const [provider, value] of Object.entries(data)) {
    if (!value || value === "") continue;
    if (!config[section]) config[section] = {};
    if (!config[section][target]) config[section][target] = {};
    if (!config[section][target][provider]) config[section][target][provider] = {};
    const key = section === "rawSearch" && provider === "github" ? "token" : "apiKey";
    config[section][target][provider][key] = value === "clear" ? "" : value;
  }
}
function save(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}
async function handleSetup(server2) {
  const config = loadConfig();
  const step1 = await server2.elicitInput({
    message: sectionHeader(config),
    requestedSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          title: "Section",
          enum: ["search-keys", "ai-keys", "options", "status"]
        }
      },
      required: ["section"]
    }
  });
  if (step1.action !== "accept") {
    return { content: [{ type: "text", text: statusBlock(config) }] };
  }
  const section = step1.content.section;
  if (section === "status") {
    return { content: [{ type: "text", text: statusBlock(config) }] };
  }
  if (section === "search-keys") {
    const c = config.rawSearch?.credentials || {};
    const result = await server2.elicitInput({
      message: keysHeader("Search Provider Keys", [
        ["serper", c.serper?.apiKey],
        ["brave", c.brave?.apiKey],
        ["perplexity", c.perplexity?.apiKey],
        ["tavily", c.tavily?.apiKey],
        ["firecrawl", c.firecrawl?.apiKey],
        ["xai", c.xai?.apiKey],
        ["github", c.github?.token]
      ]),
      requestedSchema: {
        type: "object",
        properties: {
          serper: { type: "string", title: "Serper" },
          brave: { type: "string", title: "Brave" },
          perplexity: { type: "string", title: "Perplexity" },
          tavily: { type: "string", title: "Tavily" },
          firecrawl: { type: "string", title: "Firecrawl" },
          xai: { type: "string", title: "xAI / Grok" },
          github: { type: "string", title: "GitHub Token" }
        }
      }
    });
    if (result.action === "accept" && result.content) {
      applyKeys(config, "rawSearch", result.content);
      save(config);
      return { content: [{ type: "text", text: "  \u2713 Search keys saved.\n" + statusBlock(loadConfig()) }] };
    }
    return { content: [{ type: "text", text: "  \u23CE Cancelled." }] };
  }
  if (section === "ai-keys") {
    const a = config.aiSearch?.profiles || {};
    const result = await server2.elicitInput({
      message: keysHeader("AI Search Keys", [
        ["grok", a.grok?.apiKey],
        ["firecrawl", a.firecrawl?.apiKey]
      ]),
      requestedSchema: {
        type: "object",
        properties: {
          grok: { type: "string", title: "Grok / xAI" },
          firecrawl: { type: "string", title: "Firecrawl" }
        }
      }
    });
    if (result.action === "accept" && result.content) {
      applyKeys(config, "aiSearch", result.content);
      save(config);
      return { content: [{ type: "text", text: "  \u2713 AI keys saved.\n" + statusBlock(loadConfig()) }] };
    }
    return { content: [{ type: "text", text: "  \u23CE Cancelled." }] };
  }
  if (section === "options") {
    const result = await server2.elicitInput({
      message: [
        "  \u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E",
        "  \u2502  Search Options                       \u2502",
        "  \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F",
        "",
        `    max results  ${config.rawSearch?.maxResults || 10}`,
        `    crawl pages  ${config.crawl?.maxPages || 10}`,
        `    crawl depth  ${config.crawl?.maxDepth || 1}`,
        `    same domain  ${config.crawl?.sameDomainOnly ?? true}`
      ].join("\n"),
      requestedSchema: {
        type: "object",
        properties: {
          maxResults: { type: "integer", title: "Max search results" },
          crawlMaxPages: { type: "integer", title: "Crawl max pages" },
          crawlMaxDepth: { type: "integer", title: "Crawl max depth" },
          sameDomainOnly: { type: "boolean", title: "Same domain only" }
        }
      }
    });
    if (result.action === "accept" && result.content) {
      const d = result.content;
      if (d.maxResults != null) {
        if (!config.rawSearch) config.rawSearch = {};
        config.rawSearch.maxResults = d.maxResults;
      }
      if (d.crawlMaxPages != null) {
        if (!config.crawl) config.crawl = {};
        config.crawl.maxPages = d.crawlMaxPages;
      }
      if (d.crawlMaxDepth != null) {
        if (!config.crawl) config.crawl = {};
        config.crawl.maxDepth = d.crawlMaxDepth;
      }
      if (d.sameDomainOnly != null) {
        if (!config.crawl) config.crawl = {};
        config.crawl.sameDomainOnly = d.sameDomainOnly;
      }
      save(config);
      return { content: [{ type: "text", text: "  \u2713 Options saved.\n" + statusBlock(loadConfig()) }] };
    }
    return { content: [{ type: "text", text: "  \u23CE Cancelled." }] };
  }
}

// server.mjs
ensureDataDir();
var searchArgsSchema = z.object({
  keywords: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  site: z.string().optional(),
  type: z.enum(["web", "news", "images"]).optional(),
  github_type: z.enum(["repositories", "code", "issues", "file", "repo", "issue", "pulls"]).optional().describe("GitHub type. Search: repositories/code/issues. Read: file (read file contents), repo (repo info), issue (issue/PR detail), pulls (PR list)."),
  owner: z.string().optional().describe("GitHub owner (org or user). Required for github_type: file, repo, issue, pulls."),
  repo: z.string().optional().describe("GitHub repository name. Required for github_type: file, repo, issue, pulls."),
  path: z.string().optional().describe("File path within repo. Required for github_type: file."),
  number: z.number().int().optional().describe("Issue or PR number. Required for github_type: issue."),
  ref: z.string().optional().describe("Git ref (branch, tag, SHA). Optional for github_type: file."),
  state: z.enum(["open", "closed", "all"]).optional().describe("Filter state for github_type: pulls. Default: open."),
  maxResults: z.number().int().min(1).max(20).optional(),
  mode: z.enum(["search_first", "ai_first", "ai_only"]).optional().describe("Search strategy: search_first (default) = raw search first with AI fallback, ai_first = AI search first with raw fallback, ai_only = AI search only")
}).refine(
  (data) => {
    const isGithubRead = ["file", "repo", "issue", "pulls"].includes(data.github_type);
    if (isGithubRead) return true;
    return !!data.keywords;
  },
  { message: "keywords is required for non-GitHub-read operations" }
);
var aiSearchArgsSchema = z.object({
  query: z.string().min(1),
  site: z.string().optional(),
  timeoutMs: z.number().int().min(1e3).max(3e5).optional()
});
var scrapeArgsSchema = z.object({
  urls: z.array(z.string().url()).min(1)
});
var mapArgsSchema = z.object({
  url: z.string().url(),
  limit: z.number().int().min(1).max(200).optional(),
  sameDomainOnly: z.boolean().optional(),
  search: z.string().optional()
});
var crawlArgsSchema = z.object({
  url: z.string().url(),
  maxPages: z.number().int().min(1).max(200).optional(),
  maxDepth: z.number().int().min(0).max(5).optional(),
  sameDomainOnly: z.boolean().optional()
});
var batchItemSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search"),
    keywords: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    site: z.string().optional(),
    type: z.enum(["web", "news", "images"]).optional(),
    github_type: z.enum(["repositories", "code", "issues", "file", "repo", "issue", "pulls"]).optional(),
    owner: z.string().optional(),
    repo: z.string().optional(),
    path: z.string().optional(),
    number: z.number().int().optional(),
    ref: z.string().optional(),
    state: z.enum(["open", "closed", "all"]).optional(),
    maxResults: z.number().int().min(1).max(20).optional(),
    mode: z.enum(["search_first", "ai_first", "ai_only"]).optional()
  }),
  z.object({
    action: z.literal("firecrawl_scrape"),
    urls: z.array(z.string().url()).min(1)
  }),
  z.object({
    action: z.literal("firecrawl_map"),
    url: z.string().url(),
    limit: z.number().int().min(1).max(200).optional(),
    sameDomainOnly: z.boolean().optional(),
    search: z.string().optional()
  })
]);
var batchArgsSchema = z.object({
  batch: z.array(batchItemSchema).min(1).max(10)
});
function jsonText(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}
function formattedText(tool, payload) {
  const text = formatResponse(tool, payload);
  return {
    content: [{ type: "text", text }]
  };
}
function buildInputSchema(zodSchema) {
  const jsonSchema = zodToJsonSchema(zodSchema, { target: "openApi3" });
  delete jsonSchema.$schema;
  return jsonSchema;
}
function getSearchCacheTtlMs(type = "web") {
  switch (type) {
    case "news":
      return 20 * 60 * 1e3;
    case "images":
      return 60 * 60 * 1e3;
    case "web":
    default:
      return 30 * 60 * 1e3;
  }
}
function getAiSearchCacheTtlMs(site) {
  return site === "x.com" ? 10 * 60 * 1e3 : 20 * 60 * 1e3;
}
function getScrapeCacheTtlMs(isXRoute = false) {
  return isXRoute ? 10 * 60 * 1e3 : 60 * 60 * 1e3;
}
function buildRuntimeEnv(config) {
  return {
    ...process.env,
    ...getRawProviderApiKey(config, "serper") ? { SERPER_API_KEY: getRawProviderApiKey(config, "serper") } : {},
    ...getRawProviderApiKey(config, "brave") ? { BRAVE_API_KEY: getRawProviderApiKey(config, "brave") } : {},
    ...getRawProviderApiKey(config, "perplexity") ? { PERPLEXITY_API_KEY: getRawProviderApiKey(config, "perplexity") } : {},
    ...getFirecrawlApiKey(config) ? { FIRECRAWL_API_KEY: getFirecrawlApiKey(config) } : {},
    ...getRawProviderApiKey(config, "tavily") ? { TAVILY_API_KEY: getRawProviderApiKey(config, "tavily") } : {},
    ...getRawProviderApiKey(config, "github") ? { GITHUB_TOKEN: getRawProviderApiKey(config, "github") } : {},
    ...(() => {
      const grokKey = getRawProviderApiKey(config, "xai") || getAiProfile(config, "grok")?.apiKey;
      return grokKey ? { XAI_API_KEY: process.env.XAI_API_KEY || grokKey, GROK_API_KEY: process.env.GROK_API_KEY || grokKey } : {};
    })()
  };
}
async function executeAiSearch({ query, site, timeoutMs, config, usageState }) {
  const cacheState = loadCacheState();
  const aiAvailable = await getAvailableAiProviders(config);
  const aiPriority = getAiSearchPriority(config);
  const aiCandidates = aiPriority.filter((p) => aiAvailable.includes(p));
  if (!aiCandidates.length) {
    return {
      success: false,
      error: "No AI search provider is available.",
      availableProviders: aiAvailable,
      aiFailures: []
    };
  }
  const aiSearchCacheKey = buildCacheKey("ai_search", {
    query,
    site: site || null
  });
  const cachedAiSearch = getCachedEntry(cacheState, aiSearchCacheKey);
  if (cachedAiSearch) {
    return {
      success: true,
      cached: true,
      payload: cachedAiSearch.payload,
      cacheMeta: buildCacheMeta(cachedAiSearch, true)
    };
  }
  const aiFailures = [];
  for (const candidate of aiCandidates) {
    const profile = getAiProfile(config, candidate);
    const resolvedModel = profile.model || null;
    try {
      const response = await runAiSearch({
        query,
        provider: candidate,
        site,
        model: resolvedModel,
        profile,
        timeoutMs: timeoutMs || getAiTimeoutMs(config)
      });
      noteProviderSuccess(usageState, candidate, {
        lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null
      });
      const cachedEntry = setCachedEntry(
        cacheState,
        aiSearchCacheKey,
        {
          tool: "ai_search",
          site: site || null,
          provider: candidate,
          model: resolvedModel,
          response
        },
        getAiSearchCacheTtlMs(site)
      );
      return {
        success: true,
        cached: false,
        provider: candidate,
        model: resolvedModel,
        response,
        aiFailures: aiFailures.length ? aiFailures : void 0,
        cacheMeta: buildCacheMeta(cachedEntry, false)
      };
    } catch (error) {
      aiFailures.push({
        provider: candidate,
        error: error instanceof Error ? error.message : String(error)
      });
      noteProviderFailure(usageState, candidate, error instanceof Error ? error.message : String(error), 6e4);
    }
  }
  const runtimeEnv = buildRuntimeEnv(config);
  const rawAvailable = getAvailableRawProviders(runtimeEnv);
  const rawProviders = rankProviders(
    getRawSearchPriority(config).filter((p) => rawAvailable.includes(p)),
    usageState,
    site
  );
  if (rawProviders.length) {
    try {
      const rawResponse = await runRawSearch({
        keywords: query,
        providers: rawProviders,
        site,
        type: "web",
        maxResults: getRawSearchMaxResults(config)
      });
      noteProviderSuccess(usageState, rawResponse.usedProvider, {
        lastCostUsdTicks: rawResponse.usage?.cost_in_usd_ticks || null
      });
      for (const failure of rawResponse.failures || []) {
        noteProviderFailure(usageState, failure.provider, failure.error, 6e4);
      }
      return {
        success: true,
        cached: false,
        fallbackSource: "search",
        fallbackProvider: rawResponse.usedProvider || rawProviders[0],
        aiFailures,
        response: rawResponse
      };
    } catch {
    }
  }
  return {
    success: false,
    error: `All AI providers failed: ${aiFailures.map((f) => `${f.provider}: ${f.error}`).join(" | ")}`,
    aiFailures
  };
}
function normalizeCacheUrl(url) {
  try {
    return new URL(url).toString();
  } catch {
    return String(url);
  }
}
async function writeStartupSnapshot() {
  const config = loadConfig();
  const usageState = loadUsageState();
  const runtimeEnv = buildRuntimeEnv(config);
  const rawProviders = getAvailableRawProviders(runtimeEnv);
  const aiProviders = await getAvailableAiProviders(config);
  const scrapeCapabilities = getScrapeCapabilities();
  for (const provider of rawProviders) {
    let usagePatch = null;
    try {
      usagePatch = await fetchProviderUsageSnapshot(provider, runtimeEnv);
    } catch {
      usagePatch = null;
    }
    updateProviderState(usageState, provider, {
      available: true,
      connection: "api",
      source: getRawProviderCredentialSource(config, provider, process.env) || "env",
      usageSupport: RAW_PROVIDER_CAPABILITIES[provider]?.usageSupport || null,
      ...usagePatch || {}
    });
  }
  for (const provider of aiProviders) {
    updateProviderState(usageState, provider, {
      available: true,
      connection: provider === "grok" && getAiProfile(config, "grok").apiKey ? "api" : "cli",
      source: provider === "grok" && getAiProfile(config, "grok").apiKey ? "config" : "binary",
      usageSupport: AI_PROVIDER_CAPABILITIES[provider]?.usageSupport || null
    });
  }
  updateProviderState(usageState, "readability", {
    available: scrapeCapabilities.readability,
    connection: "builtin",
    source: "local"
  });
  updateProviderState(usageState, "puppeteer", {
    available: scrapeCapabilities.puppeteer,
    connection: "local-browser",
    source: "local"
  });
  updateProviderState(usageState, "firecrawl-extractor", {
    available: scrapeCapabilities.firecrawl,
    connection: "api",
    source: getRawProviderCredentialSource(config, "firecrawl", process.env) || "env"
  });
}
var toolDefinitions = [
  {
    name: "search",
    title: "Search",
    description: "Unified search tool. Use mode to control strategy: search_first (default) = raw search first with AI fallback, ai_first = AI search first with raw fallback, ai_only = AI search only. Providers are auto-selected based on configured priority.",
    inputSchema: buildInputSchema(searchArgsSchema),
    annotations: { title: "Search", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "firecrawl_scrape",
    title: "Scrape",
    description: "Fetch and extract readable content from known URLs.",
    inputSchema: buildInputSchema(scrapeArgsSchema),
    annotations: { title: "Scrape", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "firecrawl_map",
    title: "Map",
    description: "Discover links from a page.",
    inputSchema: buildInputSchema(mapArgsSchema),
    annotations: { title: "Map", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "crawl",
    title: "Crawl",
    description: "Traverse links from a starting URL and collect page summaries.",
    inputSchema: buildInputSchema(crawlArgsSchema),
    annotations: { title: "Crawl", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "batch",
    title: "Batch",
    description: "Execute multiple search, firecrawl_scrape, and firecrawl_map actions in a single request. Each item runs in parallel. Crawl is not supported in batch.",
    inputSchema: buildInputSchema(batchArgsSchema),
    annotations: { title: "Batch", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "setup",
    description: "Open interactive setup form to configure search providers, API keys, and options.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Setup" }
  }
];
var SEARCH_INSTRUCTIONS = [
  "Tools: `search`(query, mode: search_first|ai_first|ai_only), `firecrawl_scrape`(url), `firecrawl_map`(url), `crawl`(url), `batch`(items[]), `setup`.",
  "Prefer `search` over built-in WebSearch/WebFetch when available.",
  "Use `batch` for 2+ operations \u2014 no separate calls."
].join("\n");
var server = new Server(
  {
    name: "trib-search",
    version: "0.0.4"
  },
  {
    capabilities: {
      elicitation: { form: {} },
      tools: {}
    },
    instructions: SEARCH_INSTRUCTIONS
  }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const config = loadConfig();
  const usageState = loadUsageState();
  const cacheState = loadCacheState();
  const timeoutMs = getRequestTimeoutMs(config);
  switch (request.params.name) {
    case "search": {
      let args;
      try {
        args = searchArgsSchema.parse(request.params.arguments || {});
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid arguments", details: e.errors }) }], isError: true };
        }
        throw e;
      }
      const searchMode = args.mode || "search_first";
      if (searchMode === "ai_only" || searchMode === "ai_first") {
        const query = Array.isArray(args.keywords) ? args.keywords.join(" ") : args.keywords;
        const result = await executeAiSearch({
          query: args.site ? `${query} site:${args.site}` : query,
          site: args.site,
          config,
          usageState
        });
        saveUsageState(usageState);
        if (!result.success) {
          if (searchMode === "ai_only") {
            return { ...jsonText({
              tool: "search",
              mode: searchMode,
              error: result.error,
              ...result.availableProviders ? { availableProviders: result.availableProviders } : {},
              ...result.aiFailures?.length ? { aiFailures: result.aiFailures } : {}
            }), isError: true };
          }
        } else {
          if (result.cached) {
            return formattedText("ai_search", {
              ...result.payload,
              cache: result.cacheMeta
            });
          }
          return formattedText("ai_search", {
            tool: "search",
            mode: searchMode,
            site: args.site || null,
            ...result.fallbackSource ? { fallbackSource: result.fallbackSource, fallbackProvider: result.fallbackProvider } : { provider: result.provider, model: result.model },
            response: result.response,
            ...result.aiFailures ? { aiFailures: result.aiFailures } : {},
            ...result.cacheMeta ? { cache: result.cacheMeta } : {}
          });
        }
      }
      const isGithubReadType = ["file", "repo", "issue", "pulls"].includes(args.github_type);
      if (isGithubReadType) {
        try {
          const response = await runRawSearch({
            ...args,
            keywords: args.keywords || "",
            providers: ["github"],
            maxResults: args.maxResults || getRawSearchMaxResults(config)
          });
          saveUsageState(usageState);
          return formattedText("search", {
            tool: "search",
            provider: "github",
            github_type: args.github_type,
            response
          });
        } catch (error) {
          return { ...jsonText({
            error: error instanceof Error ? error.message : String(error),
            tool: "search",
            github_type: args.github_type
          }), isError: true };
        }
      }
      const siteRule = args.site ? getSiteRule(config, args.site) : null;
      if (siteRule?.search === "xai.x_search") {
        try {
          const response = await runRawSearch({
            keywords: Array.isArray(args.keywords) ? args.keywords.join(" ") : args.keywords,
            providers: ["xai"],
            site: args.site,
            type: "web",
            maxResults: args.maxResults || getRawSearchMaxResults(config)
          });
          noteProviderSuccess(usageState, "xai", {
            lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null
          });
          saveUsageState(usageState);
          return formattedText("search", {
            tool: "search",
            site: "x.com",
            provider: "xai",
            response
          });
        } catch (error) {
          noteProviderFailure(usageState, "xai", error instanceof Error ? error.message : String(error), 6e4);
          saveUsageState(usageState);
          return { ...jsonText({
            tool: "search",
            site: "x.com",
            provider: "xai",
            error: error instanceof Error ? error.message : String(error)
          }), isError: true };
        }
      }
      const runtimeEnv = buildRuntimeEnv(config);
      const available = getAvailableRawProviders(runtimeEnv);
      const providers = rankProviders(
        getRawSearchPriority(config).filter((provider) => available.includes(provider)),
        usageState,
        args.site
      );
      if (!providers.length) {
        const aiPriority = getAiSearchPriority(config);
        const aiAvailable = await getAvailableAiProviders(config);
        const aiCandidates = aiPriority.filter((p) => aiAvailable.includes(p));
        if (aiCandidates.length > 0) {
          const query = Array.isArray(args.keywords) ? args.keywords.join(" ") : args.keywords;
          const aiFallbackFailures = [];
          for (const aiProvider of aiCandidates) {
            try {
              const aiProfile = getAiProfile(config, aiProvider);
              const aiModel = aiProfile.model || null;
              const aiResponse = await runAiSearch({
                query: args.site ? `${query} site:${args.site}` : query,
                provider: aiProvider,
                site: args.site,
                model: aiModel,
                profile: aiProfile,
                timeoutMs: getAiTimeoutMs(config)
              });
              noteProviderSuccess(usageState, aiProvider, { lastCostUsdTicks: aiResponse.usage?.cost_in_usd_ticks || null });
              saveUsageState(usageState);
              return formattedText("search", {
                tool: "search",
                fallbackSource: "ai_search",
                fallbackProvider: aiProvider,
                fallbackModel: aiModel,
                rawFailures: [],
                aiFallbackFailures,
                response: aiResponse
              });
            } catch (aiError) {
              aiFallbackFailures.push({ provider: aiProvider, error: aiError instanceof Error ? aiError.message : String(aiError) });
              noteProviderFailure(usageState, aiProvider, aiError instanceof Error ? aiError.message : String(aiError), 6e4);
            }
          }
          saveUsageState(usageState);
        }
        return { ...jsonText({
          error: "No search provider available. Configure a rawSearch key or install a CLI (codex, claude, gemini).",
          availableProviders: available
        }), isError: true };
      }
      const searchCacheKey = buildCacheKey("search", {
        keywords: Array.isArray(args.keywords) ? [...args.keywords] : args.keywords,
        providers,
        site: args.site || null,
        type: args.type || "web",
        github_type: args.github_type || null,
        maxResults: args.maxResults || getRawSearchMaxResults(config)
      });
      const cachedSearch = getCachedEntry(cacheState, searchCacheKey);
      if (cachedSearch) {
        return formattedText("search", {
          ...cachedSearch.payload,
          cache: buildCacheMeta(cachedSearch, true)
        });
      }
      try {
        const response = await runRawSearch({
          ...args,
          providers,
          maxResults: args.maxResults || getRawSearchMaxResults(config)
        });
        noteProviderSuccess(usageState, response.usedProvider, {
          lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null
        });
        for (const failure of response.failures || []) {
          noteProviderFailure(usageState, failure.provider, failure.error, 6e4);
        }
        if (args.site) {
          rememberPreferredRawProviders(usageState, args.site, [response.usedProvider, ...providers.filter((item) => item !== response.usedProvider)]);
        }
        saveUsageState(usageState);
        const cachedEntry = setCachedEntry(
          cacheState,
          searchCacheKey,
          {
            tool: "search",
            providers,
            response
          },
          getSearchCacheTtlMs(args.type || "web")
        );
        return formattedText("search", {
          tool: "search",
          providers,
          response,
          cache: buildCacheMeta(cachedEntry, false)
        });
      } catch (error) {
        for (const provider of providers) {
          noteProviderFailure(usageState, provider, error instanceof Error ? error.message : String(error), 6e4);
        }
        saveUsageState(usageState);
        if (!siteRule) {
          const aiPriority = getAiSearchPriority(config);
          const aiAvailable = await getAvailableAiProviders(config);
          const aiCandidates = aiPriority.filter((p) => aiAvailable.includes(p));
          const query = Array.isArray(args.keywords) ? args.keywords.join(" ") : args.keywords;
          const aiFallbackFailures = [];
          for (const aiProvider of aiCandidates) {
            try {
              const aiProfile = getAiProfile(config, aiProvider);
              const aiModel = aiProfile.model || null;
              const aiResponse = await runAiSearch({
                query: args.site ? `${query} site:${args.site}` : query,
                provider: aiProvider,
                site: args.site,
                model: aiModel,
                profile: aiProfile,
                timeoutMs: getAiTimeoutMs(config)
              });
              noteProviderSuccess(usageState, aiProvider, {
                lastCostUsdTicks: aiResponse.usage?.cost_in_usd_ticks || null
              });
              saveUsageState(usageState);
              return formattedText("search", {
                tool: "search",
                fallbackSource: "ai_search",
                fallbackProvider: aiProvider,
                fallbackModel: aiModel,
                rawFailures: providers.map((p) => ({ provider: p })),
                aiFallbackFailures,
                response: aiResponse
              });
            } catch (aiError) {
              aiFallbackFailures.push({
                provider: aiProvider,
                error: aiError instanceof Error ? aiError.message : String(aiError)
              });
              noteProviderFailure(usageState, aiProvider, aiError instanceof Error ? aiError.message : String(aiError), 6e4);
            }
          }
          saveUsageState(usageState);
        }
        return { ...jsonText({
          tool: "search",
          error: error instanceof Error ? error.message : String(error),
          providers
        }), isError: true };
      }
    }
    case "firecrawl_scrape": {
      let args;
      try {
        args = scrapeArgsSchema.parse(request.params.arguments || {});
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid arguments", details: e.errors }) }], isError: true };
        }
        throw e;
      }
      const normalizedUrls = args.urls.map((url) => normalizeCacheUrl(url));
      if (args.urls.length === 1) {
        const host = new URL(args.urls[0]).host;
        const siteRule = getSiteRule(config, host);
        if (siteRule?.scrape === "xai.x_search") {
          const xScrapeCacheKey = buildCacheKey("scrape:x", {
            url: normalizedUrls[0]
          });
          const cachedXRoute = getCachedEntry(cacheState, xScrapeCacheKey);
          if (cachedXRoute) {
            return formattedText("scrape", {
              ...cachedXRoute.payload,
              cache: buildCacheMeta(cachedXRoute, true)
            });
          }
          const response = await runRawSearch({
            keywords: `Summarize the X post at ${args.urls[0]} and include the link.`,
            providers: ["xai"],
            site: "x.com",
            type: "web",
            maxResults: 3
          });
          noteProviderSuccess(usageState, "xai", {
            lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null
          });
          saveUsageState(usageState);
          const cachedEntry = setCachedEntry(
            cacheState,
            xScrapeCacheKey,
            {
              tool: "scrape",
              url: args.urls[0],
              provider: "xai",
              response
            },
            getScrapeCacheTtlMs(true)
          );
          return formattedText("scrape", {
            tool: "scrape",
            url: args.urls[0],
            provider: "xai",
            response,
            cache: buildCacheMeta(cachedEntry, false)
          });
        }
      }
      const pageByUrl = /* @__PURE__ */ new Map();
      const cacheByUrl = /* @__PURE__ */ new Map();
      const missingUrls = [];
      for (let index = 0; index < args.urls.length; index += 1) {
        const url = args.urls[index];
        const normalizedUrl = normalizedUrls[index];
        const scrapeCacheKey = buildCacheKey("scrape:url", {
          url: normalizedUrl
        });
        const cachedPage = getCachedEntry(cacheState, scrapeCacheKey);
        if (cachedPage) {
          pageByUrl.set(normalizedUrl, cachedPage.payload.page);
          cacheByUrl.set(normalizedUrl, buildCacheMeta(cachedPage, true));
          continue;
        }
        missingUrls.push({ url, normalizedUrl, scrapeCacheKey });
      }
      if (missingUrls.length > 0) {
        const fetchedPages = await scrapeUrls(
          missingUrls.map((item) => item.url),
          timeoutMs,
          usageState
        );
        fetchedPages.forEach((page, index) => {
          const target = missingUrls[index];
          if (page.error) {
            pageByUrl.set(target.normalizedUrl, page);
            return;
          }
          const cachedEntry = setCachedEntry(
            cacheState,
            target.scrapeCacheKey,
            {
              page
            },
            getScrapeCacheTtlMs(false)
          );
          pageByUrl.set(target.normalizedUrl, page);
          cacheByUrl.set(target.normalizedUrl, buildCacheMeta(cachedEntry, false));
        });
      }
      const pages = normalizedUrls.map((normalizedUrl) => ({
        ...pageByUrl.get(normalizedUrl),
        cache: cacheByUrl.get(normalizedUrl) || null
      }));
      updateProviderState(usageState, "scrape", {
        lastUsedAt: (/* @__PURE__ */ new Date()).toISOString(),
        lastSuccessAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      saveUsageState(usageState);
      return formattedText("scrape", {
        tool: "scrape",
        pages
      });
    }
    case "firecrawl_map": {
      let args;
      try {
        args = mapArgsSchema.parse(request.params.arguments || {});
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid arguments", details: e.errors }) }], isError: true };
        }
        throw e;
      }
      const links = await mapSite(
        args.url,
        {
          limit: args.limit || 50,
          sameDomainOnly: args.sameDomainOnly ?? true,
          search: args.search
        },
        timeoutMs
      );
      return formattedText("map", {
        tool: "map",
        links
      });
    }
    case "crawl": {
      let args;
      try {
        args = crawlArgsSchema.parse(request.params.arguments || {});
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid arguments", details: e.errors }) }], isError: true };
        }
        throw e;
      }
      const pages = await crawlSite(
        args.url,
        {
          maxPages: args.maxPages || config.crawl?.maxPages || 10,
          maxDepth: args.maxDepth ?? config.crawl?.maxDepth ?? 1,
          sameDomainOnly: args.sameDomainOnly ?? config.crawl?.sameDomainOnly ?? true
        },
        timeoutMs,
        usageState
      );
      saveUsageState(usageState);
      return formattedText("crawl", {
        tool: "crawl",
        pages
      });
    }
    case "batch": {
      let args;
      try {
        args = batchArgsSchema.parse(request.params.arguments || {});
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid arguments", details: e.errors }) }], isError: true };
        }
        throw e;
      }
      const runtimeEnv = buildRuntimeEnv(config);
      const batchPromises = args.batch.map(async (item, idx) => {
        try {
          switch (item.action) {
            case "search": {
              const batchMode = item.mode || "search_first";
              if (batchMode === "ai_only" || batchMode === "ai_first") {
                const query = Array.isArray(item.keywords) ? item.keywords.join(" ") : item.keywords;
                const result = await executeAiSearch({
                  query: item.site ? `${query} site:${item.site}` : query,
                  site: item.site,
                  config,
                  usageState
                });
                if (result.success) {
                  if (result.cached) {
                    return { index: idx + 1, action: "search", mode: batchMode, status: "success", ...result.payload, cache: result.cacheMeta };
                  }
                  return {
                    index: idx + 1,
                    action: "search",
                    mode: batchMode,
                    status: "success",
                    ...result.fallbackSource ? { fallbackSource: result.fallbackSource, fallbackProvider: result.fallbackProvider } : { provider: result.provider, model: result.model },
                    response: result.response,
                    ...result.aiFailures ? { aiFailures: result.aiFailures } : {},
                    ...result.cacheMeta ? { cache: result.cacheMeta } : {}
                  };
                }
                if (batchMode === "ai_only") {
                  return { index: idx + 1, action: "search", mode: batchMode, status: "error", error: result.error, ...result.aiFailures?.length ? { aiFailures: result.aiFailures } : {} };
                }
              }
              const siteRule = item.site ? getSiteRule(config, item.site) : null;
              if (siteRule?.search === "xai.x_search") {
                const response2 = await runRawSearch({
                  keywords: Array.isArray(item.keywords) ? item.keywords.join(" ") : item.keywords,
                  providers: ["xai"],
                  site: item.site,
                  type: "web",
                  maxResults: item.maxResults || getRawSearchMaxResults(config)
                });
                noteProviderSuccess(usageState, "xai", {
                  lastCostUsdTicks: response2.usage?.cost_in_usd_ticks || null
                });
                return { index: idx + 1, action: "search", provider: "xai", type: "web", status: "success", response: response2 };
              }
              const available = getAvailableRawProviders(runtimeEnv);
              const providers = rankProviders(
                getRawSearchPriority(config).filter((p) => available.includes(p)),
                usageState,
                item.site
              );
              if (!providers.length) {
                return { index: idx + 1, action: "search", status: "error", error: "No raw search provider available" };
              }
              const searchCacheKey = buildCacheKey("search", {
                keywords: Array.isArray(item.keywords) ? [...item.keywords] : item.keywords,
                providers,
                site: item.site || null,
                type: item.type || "web",
                github_type: item.github_type || null,
                maxResults: item.maxResults || getRawSearchMaxResults(config)
              });
              const cachedSearch = getCachedEntry(cacheState, searchCacheKey);
              if (cachedSearch) {
                return { index: idx + 1, action: "search", status: "success", ...cachedSearch.payload, cache: buildCacheMeta(cachedSearch, true) };
              }
              const response = await runRawSearch({
                ...item,
                providers,
                maxResults: item.maxResults || getRawSearchMaxResults(config)
              });
              noteProviderSuccess(usageState, response.usedProvider, {
                lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null
              });
              for (const failure of response.failures || []) {
                noteProviderFailure(usageState, failure.provider, failure.error, 6e4);
              }
              setCachedEntry(cacheState, searchCacheKey, { tool: "search", providers, response }, getSearchCacheTtlMs(item.type || "web"));
              return { index: idx + 1, action: "search", providers, status: "success", response };
            }
            case "firecrawl_scrape": {
              const normalizedUrls = item.urls.map((u) => normalizeCacheUrl(u));
              if (item.urls.length === 1) {
                const host = new URL(item.urls[0]).host;
                const siteRule = getSiteRule(config, host);
                if (siteRule?.scrape === "xai.x_search") {
                  const xCacheKey = buildCacheKey("scrape:x", { url: normalizedUrls[0] });
                  const cachedX = getCachedEntry(cacheState, xCacheKey);
                  if (cachedX) {
                    return { index: idx + 1, action: "firecrawl_scrape", status: "success", ...cachedX.payload, cache: buildCacheMeta(cachedX, true) };
                  }
                  const response = await runRawSearch({
                    keywords: `Summarize the X post at ${item.urls[0]} and include the link.`,
                    providers: ["xai"],
                    site: "x.com",
                    type: "web",
                    maxResults: 3
                  });
                  noteProviderSuccess(usageState, "xai", { lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null });
                  setCachedEntry(cacheState, xCacheKey, { tool: "scrape", url: item.urls[0], provider: "xai", response }, getScrapeCacheTtlMs(true));
                  return { index: idx + 1, action: "firecrawl_scrape", provider: "xai", status: "success", response };
                }
              }
              const pageByUrl = /* @__PURE__ */ new Map();
              const cacheByUrl = /* @__PURE__ */ new Map();
              const missingUrls = [];
              for (let i = 0; i < item.urls.length; i += 1) {
                const url = item.urls[i];
                const normalizedUrl = normalizedUrls[i];
                const scrapeCacheKey = buildCacheKey("scrape:url", { url: normalizedUrl });
                const cachedPage = getCachedEntry(cacheState, scrapeCacheKey);
                if (cachedPage) {
                  pageByUrl.set(normalizedUrl, cachedPage.payload.page);
                  cacheByUrl.set(normalizedUrl, buildCacheMeta(cachedPage, true));
                  continue;
                }
                missingUrls.push({ url, normalizedUrl, scrapeCacheKey });
              }
              if (missingUrls.length > 0) {
                const fetchedPages = await scrapeUrls(
                  missingUrls.map((m) => m.url),
                  timeoutMs,
                  usageState
                );
                fetchedPages.forEach((page, i) => {
                  const target = missingUrls[i];
                  if (page.error) {
                    pageByUrl.set(target.normalizedUrl, page);
                    return;
                  }
                  const cachedEntry = setCachedEntry(cacheState, target.scrapeCacheKey, { page }, getScrapeCacheTtlMs(false));
                  pageByUrl.set(target.normalizedUrl, page);
                  cacheByUrl.set(target.normalizedUrl, buildCacheMeta(cachedEntry, false));
                });
              }
              const pages = normalizedUrls.map((nu) => ({
                ...pageByUrl.get(nu),
                cache: cacheByUrl.get(nu) || null
              }));
              return { index: idx + 1, action: "firecrawl_scrape", status: "success", pages };
            }
            case "firecrawl_map": {
              const links = await mapSite(
                item.url,
                {
                  limit: item.limit || 50,
                  sameDomainOnly: item.sameDomainOnly ?? true,
                  search: item.search
                },
                timeoutMs
              );
              return { index: idx + 1, action: "firecrawl_map", status: "success", links };
            }
            default:
              return { index: idx + 1, action: item.action, status: "error", error: `Unknown action: ${item.action}` };
          }
        } catch (error) {
          return { index: idx + 1, action: item.action, status: "error", error: error instanceof Error ? error.message : String(error) };
        }
      });
      const settled = await Promise.allSettled(batchPromises);
      const results = settled.map((outcome, idx) => {
        if (outcome.status === "fulfilled") return outcome.value;
        return { index: idx + 1, action: args.batch[idx].action, status: "error", error: outcome.reason?.message || String(outcome.reason) };
      });
      saveUsageState(usageState);
      return formattedText("batch", { tool: "batch", results });
    }
    case "setup": {
      return await handleSetup(server);
    }
    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});
var transport = new StdioServerTransport();
await writeStartupSnapshot();
await server.connect(transport);
async function shutdown() {
  flushUsageState();
  flushCacheState();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
