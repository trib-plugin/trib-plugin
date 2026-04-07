#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// lib/memory-score-utils.mjs
var memory_score_utils_exports = {};
__export(memory_score_utils_exports, {
  computeExactMatchBonus: () => computeExactMatchBonus,
  computeFinalScore: () => computeFinalScore,
  computeImportanceBoost: () => computeImportanceBoost,
  computeImportanceScore: () => computeImportanceScore,
  getScoringConfig: () => getScoringConfig,
  getTagFactor: () => getTagFactor
});
function getScoringConfig(tuning = {}) {
  return tuning?.scoring ?? {};
}
function getTagFactor(importance) {
  if (!importance) return 1;
  const tags = String(importance).split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length === 0) return 1;
  const factors = tags.map((t) => TAG_FACTORS[t] ?? 1);
  return Math.min(...factors);
}
function computeImportanceBoost(importance) {
  const factor = getTagFactor(importance);
  return 1 + (1 - factor) * 0.5;
}
function computeExactMatchBonus(content, query, baseScore) {
  if (!content || !query) return 0;
  const cleanQuery = String(query).toLowerCase().replace(/\s+/g, " ").trim();
  const cleanContent = String(content).toLowerCase().replace(/\s+/g, " ").trim();
  if (cleanQuery.length >= 4 && cleanContent.includes(cleanQuery)) {
    return baseScore * 0.2;
  }
  return 0;
}
function computeFinalScore(baseScore, item, query, _options = {}) {
  const importanceBoost = computeImportanceBoost(item.importance);
  const exactBonus = computeExactMatchBonus(item.content, query, baseScore);
  let timeFactor = 1;
  if (item.ts) {
    const ageDays = Math.max(0, (Date.now() - new Date(item.ts).getTime()) / 864e5);
    const decay = 1 / Math.pow(1 + ageDays / 30, 0.3);
    const tagFactor = getTagFactor(item.importance);
    const actualLoss = (1 - decay) * tagFactor;
    timeFactor = 1 - actualLoss;
  }
  let roleFactor = 1;
  if (item.type === "episode") {
    if (item.subtype === "assistant") roleFactor = 1.08;
    else if (item.subtype === "user") roleFactor = 0.92;
  }
  let typeFactor = 1;
  if (item.type === "chunk") typeFactor = 1.35;
  else if (item.type === "classification") typeFactor = 1.15;
  return (baseScore + exactBonus) * importanceBoost * timeFactor * roleFactor * typeFactor;
}
function computeImportanceScore(item) {
  const confidence = Number(item?.confidence ?? item?.quality_score ?? 0);
  const retrievalCount = Number(item?.retrieval_count ?? 0);
  const retrievalFactor = Math.log2(1 + retrievalCount) / 10;
  return confidence * 0.7 + Math.min(0.3, retrievalFactor * 0.3);
}
var TAG_FACTORS;
var init_memory_score_utils = __esm({
  "lib/memory-score-utils.mjs"() {
    TAG_FACTORS = {
      rule: 0,
      goal: 0.025,
      directive: 0.05,
      preference: 0.075,
      decision: 0.1,
      incident: 0.125
    };
  }
});

// services/memory-service.mjs
import http from "node:http";
import os from "node:os";
import fs2 from "node:fs";
import path2 from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

// lib/memory.mjs
import { DatabaseSync } from "node:sqlite";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync as mkdirSync3,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "fs";
import { dirname, join as join3, resolve } from "path";
import { homedir } from "os";

// lib/embedding-provider.mjs
import { createRequire } from "module";
import { join } from "path";
import { mkdirSync } from "fs";
var MODEL_ID = "Xenova/bge-m3";
var DEFAULT_DIMS = 1024;
var DEFAULT_DTYPE = "q8";
var INTRA_OP_THREADS = 2;
var INTER_OP_THREADS = 1;
var MODEL_CACHE_DIR = join(process.env.HOME || process.env.USERPROFILE, ".cache", "trib-memory", "models");
var extractorPromise = null;
var cachedDims = null;
var configuredDtype = DEFAULT_DTYPE;
var ortPatched = false;
var queryEmbeddingCache = /* @__PURE__ */ new Map();
var QUERY_EMBEDDING_CACHE_LIMIT = 1e3;
function cacheEmbedding(key, vector) {
  if (queryEmbeddingCache.has(key)) queryEmbeddingCache.delete(key);
  queryEmbeddingCache.set(key, vector);
  if (queryEmbeddingCache.size > QUERY_EMBEDDING_CACHE_LIMIT) {
    const oldestKey = queryEmbeddingCache.keys().next().value;
    if (oldestKey) queryEmbeddingCache.delete(oldestKey);
  }
}
function getCachedEmbedding(key) {
  if (!queryEmbeddingCache.has(key)) return null;
  const value = queryEmbeddingCache.get(key);
  queryEmbeddingCache.delete(key);
  queryEmbeddingCache.set(key, value);
  return value;
}
function configureEmbedding(config = {}) {
  if (config.dtype != null) {
    const dt = String(config.dtype).trim().toLowerCase();
    configuredDtype = ["fp32", "fp16", "q8", "q4"].includes(dt) ? dt : DEFAULT_DTYPE;
  }
  extractorPromise = null;
  cachedDims = null;
  queryEmbeddingCache.clear();
}
function patchOrtThreads() {
  if (ortPatched) return;
  try {
    const require2 = createRequire(import.meta.url);
    const ort = require2("onnxruntime-node");
    if (!ort?.InferenceSession?.create) {
      process.stderr.write("[embed] ORT patch skipped: InferenceSession.create not found\n");
      return;
    }
    const origCreate = ort.InferenceSession.create.bind(ort.InferenceSession);
    ort.InferenceSession.create = async function(pathOrBuffer, options = {}) {
      if (!options.intraOpNumThreads) options.intraOpNumThreads = INTRA_OP_THREADS;
      if (!options.interOpNumThreads) options.interOpNumThreads = INTER_OP_THREADS;
      return origCreate(pathOrBuffer, options);
    };
    ortPatched = true;
    process.stderr.write(`[embed] ORT patched OK: intra=${INTRA_OP_THREADS} inter=${INTER_OP_THREADS}
`);
  } catch (err) {
    process.stderr.write(`[embed] ORT patch failed: ${err?.message || err}
`);
  }
}
async function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      patchOrtThreads();
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      try {
        mkdirSync(MODEL_CACHE_DIR, { recursive: true });
      } catch {
      }
      env.cacheDir = MODEL_CACHE_DIR;
      try {
        env.backends.onnx.wasm.numThreads = INTRA_OP_THREADS;
      } catch {
      }
      const opts = {};
      if (configuredDtype && configuredDtype !== "fp32") {
        opts.dtype = configuredDtype;
      }
      const startMs = Date.now();
      const extractor = await pipeline("feature-extraction", MODEL_ID, opts);
      process.stderr.write(`[embed] loaded ${MODEL_ID} dtype=${configuredDtype} threads=${INTRA_OP_THREADS} in ${Date.now() - startMs}ms
`);
      return extractor;
    })();
  }
  return extractorPromise;
}
function getEmbeddingModelId() {
  return MODEL_ID;
}
function getEmbeddingDims() {
  return cachedDims || DEFAULT_DIMS;
}
function consumeProviderSwitchEvent() {
  return null;
}
async function warmupEmbeddingProvider() {
  const extractor = await loadExtractor();
  await extractor("warmup", { pooling: "mean", normalize: true });
  cachedDims = DEFAULT_DIMS;
  return true;
}
async function embedText(text) {
  const clean = String(text ?? "").trim();
  if (!clean) return [];
  const cacheKey = `${MODEL_ID}
${clean}`;
  const cached = getCachedEmbedding(cacheKey);
  if (cached) return [...cached];
  const extractor = await loadExtractor();
  const output = await extractor(clean, { pooling: "mean", normalize: true });
  cachedDims = output.data?.length || DEFAULT_DIMS;
  const vector = Array.from(output.data ?? []);
  cacheEmbedding(cacheKey, vector);
  return vector;
}

// lib/memory-extraction.mjs
function cleanMemoryText(text) {
  return String(text ?? "").replace(/```[\s\S]*?```/g, "").replace(/<memory-context>[\s\S]*?<\/memory-context>/gi, "").replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "").replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, "").replace(/<command-name>[\s\S]*?<\/command-name>/gi, "").replace(/<command-message>[\s\S]*?<\/command-message>/gi, "").replace(/<command-args>[\s\S]*?<\/command-args>/gi, "").replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, "").replace(/<tool-use-id>[\s\S]*?<\/tool-use-id>/gi, "").replace(/<output-file>[\s\S]*?<\/output-file>/gi, "").replace(/^[ \t]*\|.*\|[ \t]*$/gm, "").replace(/`([^`]+)`/g, "$1").replace(/\*\*/g, "").replace(/^#{1,4}\s+/gm, "").replace(/^>\s?/gm, "").replace(/^[-*]\s+/gm, "").replace(/https?:\/\/\S+/g, "").replace(/<channel[^>]*>\n?([\s\S]*?)\n?<\/channel>/g, "$1").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<schedule-context>[\s\S]*?<\/schedule-context>/g, "").replace(/<teammate-message[\s\S]*?<\/teammate-message>/g, "").replace(/^This session is being continued from a previous conversation[\s\S]*?(?=\n\n|$)/gim, "").replace(/^\[[^\]\n]{1,140}\]\s*$/gm, "").replace(/^\s*●\s.*$/gm, "").replace(/^\s*Ran .*$/gm, "").replace(/^\s*Command: .*$/gm, "").replace(/^\s*Process exited .*$/gm, "").replace(/^\s*Full transcript available at: .*$/gm, "").replace(/^\s*Read the output file to retrieve the result: .*$/gm, "").replace(/^\s*Original token count: .*$/gm, "").replace(/^\s*Wall time: .*$/gm, "").replace(/^\s*Chunk ID: .*$/gm, "").replace(/^\s*tool_uses: .*$/gm, "").replace(/^\s*menu item .*$/gm, "").replace(/<\/?[a-z][-a-z]*(?:\s[^>]*)?\/?>/gi, "").replace(/[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}]/gu, "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").replace(/^\s+|\s+$/gm, "").trim();
}
function classifyCandidateConcept(text, role = "user") {
  const clean = cleanMemoryText(text);
  if (!clean) return { category: "drop", admit: false };
  const isQuestionOnly = /\?$/.test(clean) && !/\b(commit|push|build|deploy|json|schema|language|tone|timezone|source of truth|sqlite|context\.md)\b/i.test(clean);
  const ruleLike = /\b(do not|don't|must not|should not|forbidden|blocked|approval|explicitly requested|json|schema)\b/i.test(clean) || /하지 마|하면 안|금지|승인|명시|JSON|스키마/.test(clean);
  const preferenceLike = /\b(prefer|preferred|want|wants|style|tone|language|timezone)\b/i.test(clean) || /선호|원해|말투|어투|언어|시간대|존댓말/.test(clean);
  const taskLike = /\b(fix|implement|investigate|review|refactor|cleanup|deduplicate|analyze|check|verify)\b/i.test(clean) || /수정|구현|조사|리뷰|리팩터|정리|중복 제거|분석|확인|검증/.test(clean);
  const proposalLike = /\b(should|could|let's|what about|how about)\b/i.test(clean) || /어때|하자|넣자|두자|맞아|되게|가게|전환|구현하자|저장해서|방향이 맞아/.test(clean);
  const storageDecisionLike = /\b(sqlite|context\.md|source of truth|long-term memory|profile data|identity storage|persistence)\b/i.test(clean) || /SQLite|context\.md|source of truth|장기 메모리|프로필 데이터|정체성 저장|저장 구조/.test(clean);
  const internalArchitectureLike = /\b(provider|model selection|embedding model|update cadence|cycle schedule|schema|crud|action field|manual injection|profile\.md|bot\.json|bot role|context generation|memory architecture|three[- ]cycle|three[- ]tier|3[- ]cycle|3[- ]tier)\b/i.test(clean) || /프로바이더|모델 선택|임베딩 모델|갱신 주기|사이클 주기|스키마|CRUD|action 필드|수동 주입|Profile\.md|bot\.json|봇 역할|context 생성|메모리 구조|3-cycle|3-tier|3사이클|3티어/.test(clean);
  const stateObservationLike = /\b(currently empty|currently noisy|data is missing|consolidation is not running|pipeline looks empty|memory is empty|backlog is high)\b/i.test(clean) || /데이터가 없|비어 있|노이즈|consolidation이 돌지 않|파이프라인이 비어|백로그/.test(clean);
  const internalMetaLike = /\b(mcp|profile hints?|memory-context|notification|output|verify chain|state file|cycle status|cycle state|catch-up|pipeline|benchmark|provider abstraction|tool-call|latency|throughput)\b/i.test(clean) || /프로필 힌트|memory-context|알림|출력|verify 체인|state file|cycle status|cycle state|catch-up|파이프라인|벤치마크|provider abstraction|지연|처리량|주기 실행/.test(clean);
  const requestNarrationLike = /\bthe user (asked|requested|wants|wanted)\b/i.test(clean) || /사용자가 .*요청했|유저가 .*요청했|심층분석해달라고/.test(clean);
  if (role !== "user") return { category: "assistant_evidence", admit: false };
  if (requestNarrationLike) return { category: "request_narration", admit: false };
  if (stateObservationLike && (taskLike || proposalLike)) return { category: "maintenance_task", admit: true };
  if (stateObservationLike) return { category: "internal_meta", admit: false };
  if (internalArchitectureLike && (taskLike || proposalLike)) return { category: "maintenance_task", admit: true };
  if (internalArchitectureLike && !ruleLike && !storageDecisionLike) return { category: "internal_meta", admit: false };
  if (internalMetaLike && (taskLike || proposalLike)) return { category: "maintenance_task", admit: true };
  if (internalMetaLike && !ruleLike && !storageDecisionLike) return { category: "internal_meta", admit: false };
  if (ruleLike) return { category: "user_rule", admit: true };
  if (preferenceLike) return { category: "preference", admit: true };
  if (taskLike) return { category: "active_task", admit: true };
  if (storageDecisionLike) return { category: "storage_decision", admit: true };
  if (isQuestionOnly) return { category: "question", admit: false };
  return { category: "generic", admit: false };
}

// lib/memory-text-utils.mjs
var MEMORY_TOKEN_ALIASES = /* @__PURE__ */ new Map([
  ["\uC708\uB3C4\uC6B0", "windows"],
  ["\uD638\uD658\uC131", "compatibility"],
  ["\uB300\uC751", "compatibility"],
  ["\uC911\uBCF5", "duplicate"],
  ["\uBA54\uC2DC\uC9C0", "message"],
  ["\uB9AC\uCF5C", "recall"],
  ["\uBC30\uD3EC", "deploy"],
  ["\uBE4C\uB4DC", "build"],
  ["\uCEE4\uBC0B", "commit"],
  ["\uD478\uC2DC", "push"],
  ["\uD074\uB77C", "client"],
  ["\uC11C\uBC84", "server"],
  ["\uD638\uCE6D", "address"],
  ["\uB9D0\uD22C", "tone"],
  ["\uC5B4\uD22C", "tone"],
  ["\uC2DC\uAC04\uB300", "timezone"],
  ["\uD0C0\uC784\uC874", "timezone"],
  ["deployment", "deploy"],
  // dev & infra terms
  ["\uAD8C\uD55C", "permission"],
  ["\uC2A4\uCF00\uC904", "schedule"],
  ["\uCC44\uB110", "channel"],
  ["\uB514\uC2A4\uCF54\uB4DC", "discord"],
  ["\uD30C\uC774\uD504\uB77C\uC778", "pipeline"],
  ["\uD2B8\uB9AC\uAC70", "trigger"],
  ["\uD50C\uB7EC\uADF8\uC778", "plugin"],
  ["\uC784\uBCA0\uB529", "embedding"],
  ["\uBCA1\uD130", "vector"],
  ["\uBAA8\uB378", "model"],
  ["\uD504\uB86C\uD504\uD2B8", "prompt"],
  ["\uD1A0\uD070", "token"],
  ["\uB370\uC774\uD130", "data"],
  ["\uC778\uB371\uC2A4", "index"],
  ["\uCE90\uC2DC", "cache"],
  ["\uB85C\uADF8", "log"],
  ["\uC5D0\uB7EC", "error"],
  ["\uBC84\uADF8", "bug"],
  ["\uD14C\uC2A4\uD2B8", "test"],
  ["\uD0C0\uC785", "type"],
  ["\uBAA8\uB4DC", "mode"],
  ["\uD6C5", "hook"],
  ["\uC138\uC158", "session"],
  ["\uCEE8\uD14D\uC2A4\uD2B8", "context"],
  ["\uD504\uB85C\uC81D\uD2B8", "project"],
  ["\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4", "workspace"],
  ["\uC54C\uB9BC", "notification"],
  ["\uB3D9\uAE30\uD654", "sync"],
  ["\uC778\uBC14\uC6B4\uB4DC", "inbound"],
  ["\uC544\uC6C3\uBC14\uC6B4\uB4DC", "outbound"],
  ["\uD3EC\uC6CC\uB529", "forwarding"],
  ["\uB9AC\uD329\uD130", "refactor"],
  ["\uB9C8\uC774\uADF8\uB808\uC774\uC158", "migration"]
]);
var MEMORY_TOKEN_STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "so",
  "that",
  "the",
  "their",
  "them",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "who",
  "why",
  "you",
  "your",
  "unless",
  "with",
  "user",
  "assistant",
  "requested",
  "request",
  "asked",
  "ask",
  "stated",
  "state",
  "reported",
  "report",
  "mentioned",
  "mention",
  "clarified",
  "clarify",
  "explicitly",
  "currently",
  "\uC0AC\uC6A9\uC790",
  "\uC720\uC800",
  "\uC694\uCCAD",
  "\uC9C8\uBB38",
  "\uB2F5\uBCC0",
  "\uC5B8\uAE09",
  "\uB9D0\uC500",
  "\uC124\uBA85",
  "\uBCF4\uACE0",
  "\uBB34\uC2A8",
  "\uBB50\uC57C",
  "\uD588\uC9C0"
]);
var SUBJECT_STOPWORDS = /* @__PURE__ */ new Set([
  ...MEMORY_TOKEN_STOPWORDS,
  "active",
  "current",
  "ongoing",
  "issue",
  "issues",
  "problem",
  "weakness",
  "weaknesses",
  "thing",
  "things",
  "\uD604\uC7AC",
  "\uD575\uC2EC",
  "\uBB38\uC81C",
  "\uC57D\uC810",
  "\uC774\uC288"
]);
function firstTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}
function looksLowSignal(text) {
  const clean = cleanMemoryText(text);
  if (!clean) return true;
  if (clean.includes("[Request interrupted by user]")) return true;
  if (/<event-result[\s>]|<event\s/i.test(String(text ?? ""))) return true;
  if (/^(read|list|show|count|find|tell me|summarize)\b/i.test(clean) && /(\/|\.jsonl\b|\.md\b|\.csv\b|\bfilenames?\b)/i.test(clean)) return true;
  if (/^no response requested\.?$/i.test(clean)) return true;
  if (/^stop hook error:/i.test(clean)) return true;
  if (/^you are consolidating high-signal long-term memory candidates/i.test(clean)) return true;
  if (/^you are improving retrieval quality for a long-term memory system/i.test(clean)) return true;
  if (/^analyze the conversation and output only markdown/i.test(clean)) return true;
  if (/^you are analyzing (today's|a day's) conversation to generate/i.test(clean)) return true;
  if (/^summarize the conversation below\.?/i.test(clean)) return true;
  if (/history directory:/i.test(clean) && /data sources/i.test(clean)) return true;
  if (/use read tool/i.test(clean) && /existing files/i.test(clean)) return true;
  if (/return this exact shape:/i.test(clean)) return true;
  if (/^trib-memory setup\b/i.test(clean) && /parse the command arguments/i.test(clean)) return true;
  if (/\b(chat_id|gmail_search_messages|newer_than:\d+[dh]|query:\s*")/i.test(clean)) return true;
  if (/^new session started\./i.test(clean) && /one short message only/i.test(clean)) return true;
  if (/^before starting any work/i.test(clean) && /tell the user/i.test(clean)) return true;
  const compact = clean.replace(/\s+/g, "");
  const hasKorean = /[\uAC00-\uD7AF]/.test(compact);
  const shortKoreanMeaningful = hasKorean && compact.length >= 2 && (/[?？]$/.test(clean) || /일정|상태|시간|규칙|정책|언어|말투|호칭|기억|검색|중복|설정|오류|버그|왜|뭐|언제|어디|누구|무엇/.test(clean) || /해봐|해줘|진행|시작|고쳐|수정|확인|돌려|ㄱㄱ|ㅇㅇ|ㄴㄴ|좋아|오케이/.test(clean) || classifyCandidateConcept(clean, "user")?.admit);
  const minCompactLen = hasKorean ? 4 : 8;
  if (compact.length < minCompactLen && !shortKoreanMeaningful) return true;
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 2 && compact.length < (hasKorean ? 4 : 16) && !shortKoreanMeaningful) return true;
  const symbolCount = (clean.match(/[^\p{L}\p{N}\s]/gu) ?? []).length;
  if (symbolCount > clean.length * 0.45) return true;
  return false;
}
function looksLowSignalQuery(text) {
  const clean = cleanMemoryText(text);
  if (!clean) return true;
  if (clean.includes("[Request interrupted by user]")) return true;
  const compact = clean.replace(/\s+/g, "");
  if (!/[\p{L}\p{N}]/u.test(compact)) return true;
  if (compact.length <= 1) return true;
  return false;
}
function normalizeMemoryToken(token) {
  let normalized = String(token ?? "").trim().toLowerCase();
  if (!normalized) return "";
  if (/[\uAC00-\uD7AF]/.test(normalized) && normalized.length > 2) {
    const stripped = normalized.replace(/(했었지|했더라|됐었나|됐던가|했는지|였는지|인건가|하려면|에서는|이라서|였더라|에서도|이었지|으로도|거였지|한건지|이었나)$/u, "").replace(/(했던|했지|됐던|됐지|하게|되던|이라|에서|으로|하는|없는|있는|었던|하자|않게|할때|인지|인데|인건|이고|보다|처럼|까지|부터|마다|밖에|없이)$/u, "").replace(/(은|는|이|가|을|를|랑|과|와|도|에|의|로|만|며|나|고|서|자|요)$/u, "");
    if (stripped.length >= 2) normalized = stripped;
  }
  if (/^[a-z][a-z0-9_-]+$/i.test(normalized)) {
    if (normalized.length > 5 && normalized.endsWith("ing")) normalized = normalized.slice(0, -3);
    else if (normalized.length > 4 && normalized.endsWith("ed")) normalized = normalized.slice(0, -2);
    else if (normalized.length > 4 && normalized.endsWith("es")) normalized = normalized.slice(0, -2);
    else if (normalized.length > 3 && normalized.endsWith("s")) normalized = normalized.slice(0, -1);
  }
  normalized = MEMORY_TOKEN_ALIASES.get(normalized) ?? normalized;
  return normalized;
}
function tokenizeMemoryText(text) {
  return cleanMemoryText(text).toLowerCase().split(/[^\p{L}\p{N}_]+/u).map((token) => normalizeMemoryToken(token)).filter((token) => token.length >= 2).filter((token) => !MEMORY_TOKEN_STOPWORDS.has(token)).slice(0, 24);
}
var KO_COMPOUND_KEYWORDS = [
  "\uC2A4\uD2B8\uB7ED\uCCD0\uB4DC",
  "\uC2F1\uAE00\uD1A4",
  "\uB514\uC2A4\uCF54\uB4DC",
  "\uBCA4\uCE58\uB9C8\uD06C",
  "\uC544\uC6C3\uD48B",
  "\uD50C\uB7EC\uADF8\uC778",
  "\uBC14\uC778\uB529",
  "\uB9AC\uC2A4\uD0C0\uD2B8",
  "\uD504\uB85C\uBC14\uC774\uB354",
  "\uC2AC\uB798\uC2DC\uCEE4\uB9E8\uB4DC",
  "\uC2A4\uCF00\uC974\uB7EC",
  "\uC784\uBCA0\uB529",
  "\uC784\uBCA0\uB4DC",
  "\uD3EC\uC6CC\uB354",
  "\uD3EC\uC6CC\uB4DC",
  "\uB9AC\uD2B8\uB9AC\uBC8C",
  "\uC544\uD0A4\uD14D\uCC98",
  "\uC778\uC81D\uC158",
  "\uD2B8\uB9AC\uAC70",
  "\uCEE8\uC194\uB9AC",
  "\uBA54\uBAA8\uB9AC",
  "\uBA54\uC2DC\uC9C0",
  "\uBA54\uC138\uC9C0",
  "\uD0C0\uC774\uBC0D",
  "\uB9AC\uCF5C",
  "\uCC44\uB110",
  "\uB3D9\uAE30\uD654",
  "\uC138\uC158",
  "\uC2B9\uC778",
  "\uB3D9\uAE30",
  "\uC218\uC2E0",
  "\uC989\uC2DC",
  "\uC778\uB77C\uC778",
  "\uD074\uB9AC\uC5B4",
  "\uACB0\uACFC",
  "\uCC98\uB9AC",
  "\uAE30\uC900",
  "\uBE44\uAD50",
  "\uAD6C\uC870",
  "\uC5ED\uD560",
  "\uD6C5",
  "\uC124\uC815",
  "\uAC80\uC0C9",
  "\uC800\uC7A5",
  "\uC0AD\uC81C",
  "\uBCF5\uC6D0",
  "\uD14C\uC2A4\uD2B8"
].sort((a, b) => b.length - a.length);
function buildFtsQuery(text) {
  const tokens = tokenizeMemoryText(text);
  if (tokens.length === 0) return "";
  const ftsTokens = [...new Set(tokens)].filter((t) => t.length >= 3 || t.length === 2 && /[\uAC00-\uD7AF]/.test(t));
  if (ftsTokens.length === 0) return "";
  return ftsTokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}
function getShortTokensForLike(text) {
  const tokens = tokenizeMemoryText(text);
  return [...new Set(tokens)].filter((t) => t.length === 2);
}
function shortTokenMatchScore(content, shortTokens = []) {
  const clean = cleanMemoryText(content);
  if (!clean || shortTokens.length === 0) return 0;
  const matched = shortTokens.filter((token) => clean.includes(token)).length;
  if (matched === 0) return 0;
  return -(matched / shortTokens.length) * 1.5;
}
function candidateScore(text, role) {
  const clean = cleanMemoryText(text);
  if (!clean || looksLowSignal(clean)) return 0;
  const concept = classifyCandidateConcept(clean, role);
  if (!concept.admit) return 0;
  const compact = clean.replace(/\s+/g, "");
  const lenScore = Math.min(1, compact.length / 120);
  const wordCount = clean.split(/\s+/).filter(Boolean).length;
  const lineCount = clean.split("\n").filter(Boolean).length;
  const colonCount = (clean.match(/:/g) ?? []).length;
  const pathCount = (String(text ?? "").match(/\/[A-Za-z0-9._-]+/g) ?? []).length;
  const tagCount = (String(text ?? "").match(/<[^>]+>/g) ?? []).length;
  const hasKoreanChars = /[\uAC00-\uD7AF]/.test(clean);
  if (role === "assistant" && wordCount < (hasKoreanChars ? 4 : 8)) return 0;
  const roleBoost = role === "user" ? 0.25 : 0.08;
  const conceptBoost = concept.category === "user_rule" ? 0.22 : concept.category === "active_task" ? 0.16 : concept.category === "maintenance_task" ? 0.14 : concept.category === "preference" ? 0.14 : concept.category === "storage_decision" ? 0.12 : 0;
  const structureBoost = /\n/.test(clean) ? 0.04 : 0;
  const overlongPenalty = compact.length > 768 ? Math.min(0.45, (compact.length - 768) / 1200 * 0.45) : 0;
  const proceduralPenalty = lineCount > 8 && colonCount >= 4 ? 0.18 : 0;
  const artifactPenalty = pathCount >= 3 || tagCount >= 2 ? 0.14 : 0;
  const explicitRuleBoost = /\b(do not|don't|must not|should not|forbidden|blocked|explicit approval|explicitly requested|json|schema)\b/i.test(clean) || /하지 마|하면 안|금지|승인|명시|JSON|스키마/.test(clean) ? 0.22 : 0;
  const explicitTaskBoost = /\b(fix|implement|verify|review|investigate|refactor|cleanup|deduplicate|stabilize)\b/i.test(clean) || /수정|구현|검증|리뷰|조사|정리|중복 제거|안정화/.test(clean) ? 0.16 : 0;
  const metaPenalty = /\b(consolidation-dependent|candidate threshold|backlog control|provider\/model choice configurable|runtime bot settings|context sections|why the pipeline)\b/i.test(clean) || /후보 임계값|컨텍스트 섹션|파이프라인이 비어|설정이 비어|config commentary|cleanup state/.test(clean) ? 0.28 : 0;
  const questionPenalty = /\?$/.test(clean) && explicitRuleBoost === 0 && explicitTaskBoost === 0 ? 0.08 : 0;
  return Math.max(
    0,
    Math.min(
      1,
      Number((0.22 + lenScore * 0.45 + roleBoost + structureBoost + conceptBoost + explicitRuleBoost + explicitTaskBoost - overlongPenalty - proceduralPenalty - artifactPenalty - metaPenalty - questionPenalty).toFixed(3))
    )
  );
}
function splitMessageIntoCandidateUnits(text) {
  const clean = cleanMemoryText(text);
  if (!clean) return [];
  const lines = clean.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const units = [];
  for (const line of lines) {
    const chunks = line.split(/(?<=[.!?。！？])\s+|(?<=다\.|요\.|죠\.|니다\.)\s+/).map((chunk) => chunk.trim()).filter(Boolean);
    if (chunks.length <= 1) {
      units.push(line);
      continue;
    }
    for (const chunk of chunks) {
      units.push(chunk);
    }
  }
  const deduped = [];
  const seen = /* @__PURE__ */ new Set();
  for (const unit of units) {
    const normalized = cleanMemoryText(unit).toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(unit);
  }
  return deduped.length > 0 ? deduped : [clean];
}
function insertCandidateUnits(insertStmt, episodeId, ts, dayKey, role, content) {
  const units = splitMessageIntoCandidateUnits(content);
  let inserted = 0;
  for (const unit of units) {
    const concept = classifyCandidateConcept(unit, role);
    if (!concept.admit) continue;
    const score = candidateScore(unit, role);
    if (score <= 0) continue;
    insertStmt.run(episodeId, ts, dayKey, role, unit, score);
    inserted += 1;
  }
  return inserted;
}
function generateQueryVariants(query) {
  const clean = cleanMemoryText(query);
  if (!clean) return [clean];
  const baseVariants = [clean];
  const tokens = tokenizeMemoryText(clean);
  const aliasedTokens = tokens.map((t) => {
    const alias = MEMORY_TOKEN_ALIASES.get(t);
    return alias && alias !== t ? alias : t;
  });
  const aliased = aliasedTokens.join(" ");
  const aliasVariants = aliased !== tokens.join(" ") ? [aliased] : [];
  const koToEn = {
    "\uC218\uC815": "fix",
    "\uC0C1\uD0DC": "status",
    "\uAD6C\uC870": "structure",
    "\uBC29\uC2DD": "method",
    "\uC124\uC815": "config settings",
    "\uC791\uC5C5": "task work",
    "\uADDC\uCE59": "rule policy",
    "\uBAA9\uB85D": "list",
    "\uAD00\uB828": "related",
    "\uD604\uC7AC": "current",
    "\uC9C4\uD589": "progress",
    "\uC774\uAD00": "migration",
    "\uC815\uB9AC": "cleanup",
    "\uC548\uC815\uD654": "stabilize",
    "\uC544\uD0A4\uD14D\uCC98": "architecture",
    "\uAC80\uC0C9": "search retrieval",
    "\uC800\uC7A5": "storage",
    "\uC778\uC99D": "authentication auth",
    "\uBA54\uBAA8\uB9AC": "memory",
    "\uC5B8\uC5B4": "language",
    "\uD638\uCE6D": "address name honorific",
    "\uC751\uB2F5": "response",
    "\uD615\uC2DD": "format style",
    "\uCE90\uC8FC\uC5BC": "casual informal",
    "\uB204\uC801": "accumulate",
    // extended coverage for cross-lingual retrieval
    "\uAD8C\uD55C": "permission access",
    "\uC2A4\uCF00\uC904": "schedule cron",
    "\uCC44\uB110": "channel",
    "\uBAA8\uB4DC": "mode",
    "\uB514\uC2A4\uCF54\uB4DC": "discord",
    "\uD30C\uC774\uD504\uB77C\uC778": "pipeline",
    "\uD2B8\uB9AC\uAC70": "trigger",
    "\uD50C\uB7EC\uADF8\uC778": "plugin",
    "\uC784\uBCA0\uB529": "embedding vector",
    "\uD504\uB86C\uD504\uD2B8": "prompt",
    "\uD1A0\uD070": "token",
    "\uB370\uC774\uD130": "data",
    "\uC778\uB371\uC2A4": "index",
    "\uC5D0\uB7EC": "error",
    "\uBC84\uADF8": "bug",
    "\uD14C\uC2A4\uD2B8": "test",
    "\uBAA8\uB378": "model",
    "\uD6C5": "hook",
    "\uC138\uC158": "session",
    "\uCEE8\uD14D\uC2A4\uD2B8": "context",
    "\uC54C\uB9BC": "notification",
    "\uB3D9\uAE30\uD654": "sync synchronize",
    "\uBD84\uB958": "classification classify",
    "\uD6C4\uBCF4": "candidate",
    "\uC810\uC218": "score",
    "\uAC00\uC911\uCE58": "weight",
    "\uBCA1\uD130": "vector",
    "\uCC28\uC6D0": "dimension dims",
    "\uD504\uB85C\uC81D\uD2B8": "project",
    "\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4": "workspace",
    "\uC778\uBC14\uC6B4\uB4DC": "inbound",
    "\uC544\uC6C3\uBC14\uC6B4\uB4DC": "outbound",
    "\uD3EC\uC6CC\uB529": "forwarding",
    "\uB9AC\uD329\uD130": "refactor",
    "\uB9C8\uC774\uADF8\uB808\uC774\uC158": "migration",
    "\uC911\uBCF5": "duplicate dedup",
    "\uC0AD\uC81C": "delete remove",
    "\uCD94\uAC00": "add create",
    "\uBCC0\uACBD": "change update modify",
    "\uD655\uC778": "check verify",
    "\uC2E4\uD589": "execute run",
    "\uC885\uB8CC": "stop terminate",
    "\uC2DC\uC791": "start begin",
    "\uC7AC\uC2DC\uC791": "restart",
    "\uBC30\uD3EC": "deploy",
    "\uD638\uCD9C": "call invoke",
    "\uBC18\uD658": "return",
    "\uD30C\uC2F1": "parse parsing",
    "\uCE90\uC2DC": "cache",
    "\uD0C0\uC784\uC544\uC6C3": "timeout",
    "\uC7AC\uC2DC\uB3C4": "retry"
  };
  const translated = tokens.map((t) => koToEn[t] ?? t).join(" ");
  const translatedVariants = translated !== tokens.join(" ") ? [translated] : [];
  const phraseExpansions = [];
  if (/단독|독립|분리|standalone|independent|separate/i.test(clean)) {
    phraseExpansions.push(`${clean} standalone independent separate plugin`);
  }
  if (/동작가능|동작 가능|작동가능|작동 가능|가능해|가능하/i.test(clean)) {
    phraseExpansions.push(`${clean} supported capability standalone`);
  }
  if (/채널 ?id|채널아이디|channel id|mapping|매핑/i.test(clean)) {
    phraseExpansions.push(`${clean} channel id mapping access config inbound`);
  }
  if (/자동바인딩|자동 바인딩|binding|바인딩/i.test(clean)) {
    phraseExpansions.push(`${clean} automatic binding reconnect restore discord`);
  }
  if (/인바운드|inbound/i.test(clean)) {
    phraseExpansions.push(`${clean} inbound delivery binding discord channel receive`);
  }
  if (/메세지안옴|메시지안옴|message.*not|안옴|안 와|안와/i.test(clean)) {
    phraseExpansions.push(`${clean} message delivery inbound discord notification`);
  }
  if (/임베드|embed|embedding/i.test(clean) && /즉시|timing|immediate/i.test(clean)) {
    phraseExpansions.push(`${clean} inline embedding immediate timing`);
  }
  const enToKo = {
    "permission": "\uAD8C\uD55C \uC811\uADFC",
    "schedule": "\uC2A4\uCF00\uC904 \uC608\uC57D",
    "channel": "\uCC44\uB110",
    "discord": "\uB514\uC2A4\uCF54\uB4DC",
    "pipeline": "\uD30C\uC774\uD504\uB77C\uC778",
    "plugin": "\uD50C\uB7EC\uADF8\uC778",
    "embedding": "\uC784\uBCA0\uB529 \uBCA1\uD130",
    "model": "\uBAA8\uB378",
    "prompt": "\uD504\uB86C\uD504\uD2B8",
    "hook": "\uD6C5",
    "session": "\uC138\uC158",
    "context": "\uCEE8\uD14D\uC2A4\uD2B8",
    "notification": "\uC54C\uB9BC",
    "config": "\uC124\uC815",
    "settings": "\uC124\uC815",
    "deploy": "\uBC30\uD3EC",
    "test": "\uD14C\uC2A4\uD2B8",
    "search": "\uAC80\uC0C9",
    "memory": "\uBA54\uBAA8\uB9AC \uAE30\uC5B5",
    "cache": "\uCE90\uC2DC",
    "trigger": "\uD2B8\uB9AC\uAC70",
    "inbound": "\uC778\uBC14\uC6B4\uB4DC \uC218\uC2E0",
    "project": "\uD504\uB85C\uC81D\uD2B8",
    "sync": "\uB3D9\uAE30\uD654",
    "migration": "\uB9C8\uC774\uADF8\uB808\uC774\uC158 \uC774\uAD00",
    "refactor": "\uB9AC\uD329\uD130 \uC815\uB9AC",
    "error": "\uC5D0\uB7EC \uC624\uB958",
    "bug": "\uBC84\uADF8",
    "mode": "\uBAA8\uB4DC"
  };
  const reverseTokens = tokens.map((t) => enToKo[t] ?? t).join(" ");
  const reverseVariants = reverseTokens !== tokens.join(" ") ? [reverseTokens] : [];
  const variants = [
    ...baseVariants,
    ...phraseExpansions,
    ...aliasVariants,
    ...translatedVariants,
    ...reverseVariants
  ];
  return [...new Set(variants)].slice(0, 6);
}
function localNow() {
  const d = /* @__PURE__ */ new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function toLocalTs(input) {
  const d = new Date(input);
  if (isNaN(d.getTime())) return input;
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function localDateStr(date = /* @__PURE__ */ new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// lib/ko-date-parser.mjs
function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function addMonths(d, n) {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}
function startOfWeek(d) {
  const day = d.getDay();
  const diff = (day + 6) % 7;
  return addDays(d, -diff);
}
function lastDayOfMonth(year, month) {
  const d = new Date(year, month + 1, 0);
  return d.getDate();
}
var WEEKDAY_MAP = { "\uC77C": 0, "\uC6D4": 1, "\uD654": 2, "\uC218": 3, "\uBAA9": 4, "\uAE08": 5, "\uD1A0": 6 };
var KO_PATTERNS = [
  // Exact single-day (longer patterns first to prevent partial match)
  { re: /오늘/, fn: (d) => ({ date: d, exact: true }) },
  { re: /어제/, fn: (d) => ({ date: addDays(d, -1), exact: true }) },
  { re: /엊그제|엊그저께/, fn: (d) => ({ start: addDays(d, -3), end: addDays(d, -2), exact: false }) },
  { re: /그저께|그제/, fn: (d) => ({ date: addDays(d, -2), exact: true }) },
  { re: /내일/, fn: (d) => ({ date: addDays(d, 1), exact: true }) },
  { re: /모레/, fn: (d) => ({ date: addDays(d, 2), exact: true }) },
  // N일/주/달/개월/년 전
  { re: /(\d+)\s*일\s*전/, fn: (d, m) => ({ date: addDays(d, -parseInt(m[1])), exact: true }) },
  { re: /(\d+)\s*주\s*전/, fn: (d, m) => {
    const weeks = parseInt(m[1]);
    return { start: addDays(d, -weeks * 7 - 6), end: addDays(d, -(weeks - 1) * 7), exact: false };
  } },
  { re: /(\d+)\s*(?:달|개월)\s*전/, fn: (d, m) => {
    const n = parseInt(m[1]);
    const s = addMonths(d, -n);
    return { start: s, end: addDays(addMonths(d, -(n - 1)), -1), exact: false };
  } },
  { re: /(\d+)\s*년\s*전/, fn: (d, m) => {
    const n = parseInt(m[1]);
    const y = d.getFullYear() - n;
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), exact: false };
  } },
  // 지난/이번/다음 주/달
  { re: /지난\s*주/, fn: (d) => {
    const thisMonday = startOfWeek(d);
    return { start: addDays(thisMonday, -7), end: addDays(thisMonday, -1), exact: false };
  } },
  { re: /이번\s*주/, fn: (d) => {
    const thisMonday = startOfWeek(d);
    return { start: thisMonday, end: addDays(thisMonday, 6), exact: false };
  } },
  { re: /다음\s*주/, fn: (d) => {
    const thisMonday = startOfWeek(d);
    return { start: addDays(thisMonday, 7), end: addDays(thisMonday, 13), exact: false };
  } },
  { re: /지난\s*달/, fn: (d) => {
    const prev = addMonths(d, -1);
    const y = prev.getFullYear(), m = prev.getMonth();
    return { start: new Date(y, m, 1), end: new Date(y, m, lastDayOfMonth(y, m)), exact: false };
  } },
  { re: /이번\s*달/, fn: (d) => {
    const y = d.getFullYear(), m = d.getMonth();
    return { start: new Date(y, m, 1), end: new Date(y, m, lastDayOfMonth(y, m)), exact: false };
  } },
  { re: /다음\s*달/, fn: (d) => {
    const next = addMonths(d, 1);
    const y = next.getFullYear(), m = next.getMonth();
    return { start: new Date(y, m, 1), end: new Date(y, m, lastDayOfMonth(y, m)), exact: false };
  } },
  // 작년/올해/내년
  { re: /작년|지난\s*해/, fn: (d) => {
    const y = d.getFullYear() - 1;
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), exact: false };
  } },
  { re: /올해/, fn: (d) => {
    const y = d.getFullYear();
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), exact: false };
  } },
  { re: /내년/, fn: (d) => {
    const y = d.getFullYear() + 1;
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), exact: false };
  } },
  // 방금/아까/조금 전
  { re: /방금|아까|조금\s*전/, fn: (d) => ({ date: d, exact: false }) },
  // 최근/요즘
  { re: /최근|요즘/, fn: (d) => ({ start: addDays(d, -3), end: d, exact: false }) },
  // YYYY년 M월 D일
  { re: /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/, fn: (_d, m) => {
    return { date: new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])), exact: true };
  } },
  // M월 D일 (current year)
  { re: /(\d{1,2})월\s*(\d{1,2})일/, fn: (d, m) => {
    return { date: new Date(d.getFullYear(), parseInt(m[1]) - 1, parseInt(m[2])), exact: true };
  } },
  // M월 (whole month, current year)
  { re: /(\d{1,2})월/, fn: (d, m) => {
    const mo = parseInt(m[1]) - 1;
    const y = d.getFullYear();
    return { start: new Date(y, mo, 1), end: new Date(y, mo, lastDayOfMonth(y, mo)), exact: false };
  } },
  // 지난 X요일
  { re: /지난\s*([일월화수목금토])요일/, fn: (d, m) => {
    const target = WEEKDAY_MAP[m[1]];
    if (target == null) return null;
    const current = d.getDay();
    let diff = (current - target + 7) % 7 || 7;
    return { date: addDays(d, -diff), exact: true };
  } },
  // 이번 X요일
  { re: /이번\s*([일월화수목금토])요일/, fn: (d, m) => {
    const target = WEEKDAY_MAP[m[1]];
    if (target == null) return null;
    const thisMonday = startOfWeek(d);
    const targetOffset = (target + 6) % 7;
    return { date: addDays(thisMonday, targetOffset), exact: true };
  } },
  // 다음 X요일
  { re: /다음\s*([일월화수목금토])요일/, fn: (d, m) => {
    const target = WEEKDAY_MAP[m[1]];
    if (target == null) return null;
    const thisMonday = startOfWeek(d);
    const nextMonday = addDays(thisMonday, 7);
    const targetOffset = (target + 6) % 7;
    return { date: addDays(nextMonday, targetOffset), exact: true };
  } }
];
var EN_PATTERNS = [
  { re: /\btoday\b/i, fn: (d) => ({ date: d, exact: true }) },
  { re: /\byesterday\b/i, fn: (d) => ({ date: addDays(d, -1), exact: true }) },
  { re: /\btomorrow\b/i, fn: (d) => ({ date: addDays(d, 1), exact: true }) },
  { re: /\b(?:two days ago|day before yesterday)\b/i, fn: (d) => ({ date: addDays(d, -2), exact: true }) },
  { re: /\b(\d+)\s+days?\s+ago\b/i, fn: (d, m) => ({ date: addDays(d, -parseInt(m[1])), exact: true }) },
  { re: /\b(\d+)\s+weeks?\s+ago\b/i, fn: (d, m) => {
    const w = parseInt(m[1]);
    return { start: addDays(d, -w * 7 - 6), end: addDays(d, -(w - 1) * 7), exact: false };
  } },
  { re: /\b(\d+)\s+months?\s+ago\b/i, fn: (d, m) => {
    const n = parseInt(m[1]);
    return { start: addMonths(d, -n), end: addDays(addMonths(d, -(n - 1)), -1), exact: false };
  } },
  { re: /\blast\s*week\b/i, fn: (d) => {
    const thisMonday = startOfWeek(d);
    return { start: addDays(thisMonday, -7), end: addDays(thisMonday, -1), exact: false };
  } },
  { re: /\bthis[-_\s]*week\b/i, fn: (d) => {
    const thisMonday = startOfWeek(d);
    return { start: thisMonday, end: addDays(thisMonday, 6), exact: false };
  } },
  { re: /\bnext\s*week\b/i, fn: (d) => {
    const thisMonday = startOfWeek(d);
    return { start: addDays(thisMonday, 7), end: addDays(thisMonday, 13), exact: false };
  } },
  { re: /\blast\s*month\b/i, fn: (d) => {
    const prev = addMonths(d, -1);
    const y = prev.getFullYear(), m = prev.getMonth();
    return { start: new Date(y, m, 1), end: new Date(y, m, lastDayOfMonth(y, m)), exact: false };
  } },
  { re: /\bthis\s*month\b/i, fn: (d) => {
    const y = d.getFullYear(), m = d.getMonth();
    return { start: new Date(y, m, 1), end: new Date(y, m, lastDayOfMonth(y, m)), exact: false };
  } },
  { re: /\blast\s*year\b/i, fn: (d) => {
    const y = d.getFullYear() - 1;
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), exact: false };
  } },
  { re: /\bthis\s*year\b/i, fn: (d) => {
    const y = d.getFullYear();
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), exact: false };
  } },
  { re: /\brecently\b/i, fn: (d) => ({ start: addDays(d, -3), end: d, exact: false }) }
];
var NEUTRAL_PATTERNS = [
  // YYYY-MM-DD or YYYY.MM.DD
  { re: /(\d{4})[-.](\d{2})[-.](\d{2})/, fn: (_d, m) => {
    return { date: new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])), exact: true };
  } },
  // YYYY-MM (whole month)
  { re: /(\d{4})[-.](\d{2})(?![-.]\d)/, fn: (_d, m) => {
    const y = parseInt(m[1]), mo = parseInt(m[2]) - 1;
    if (mo < 0 || mo > 11) return null;
    return { start: new Date(y, mo, 1), end: new Date(y, mo, lastDayOfMonth(y, mo)), exact: false };
  } },
  // M/D (current year)
  { re: /\b(\d{1,2})\/(\d{1,2})\b/, fn: (d, m) => {
    const mo = parseInt(m[1]) - 1, day = parseInt(m[2]);
    if (mo < 0 || mo > 11 || day < 1 || day > 31) return null;
    return { date: new Date(d.getFullYear(), mo, day), exact: true };
  } }
];
var ALL_PATTERNS = [...KO_PATTERNS, ...EN_PATTERNS, ...NEUTRAL_PATTERNS];
function resolveResult(matched, match) {
  if (!matched) return null;
  if (matched.date) {
    const s = fmt(matched.date);
    return { text: match[0], start: s, end: null, exact: matched.exact ?? true };
  }
  if (matched.start) {
    return {
      text: match[0],
      start: fmt(matched.start),
      end: fmt(matched.end ?? matched.start),
      exact: matched.exact ?? false
    };
  }
  return null;
}
function parseKoreanDate(text, refDate) {
  const ref = refDate ? new Date(refDate) : /* @__PURE__ */ new Date();
  for (const { re, fn } of ALL_PATTERNS) {
    const match = text.match(re);
    if (match) {
      const result = fn(ref, match);
      const resolved = resolveResult(result, match);
      if (resolved) return resolved;
    }
  }
  return null;
}
function parseTemporalHint(query) {
  const parsed = parseKoreanDate(query);
  if (!parsed) return null;
  return {
    start: parsed.start,
    end: parsed.end ?? parsed.start,
    exact: parsed.exact ?? true
  };
}

// lib/reranker.mjs
import { createRequire as createRequire2 } from "module";
import { join as join2 } from "path";
import { mkdirSync as mkdirSync2 } from "fs";
import { AutoTokenizer, AutoModelForSequenceClassification, env as hfEnv } from "@huggingface/transformers";
var MODEL_CACHE_DIR2 = join2(process.env.HOME || process.env.USERPROFILE, ".cache", "trib-memory", "models");
var INTRA_OP_THREADS2 = 2;
var INTER_OP_THREADS2 = 1;
var _ortPatched = false;
function patchOrtThreads2() {
  if (_ortPatched) return;
  try {
    const require2 = createRequire2(import.meta.url);
    const ort = require2("onnxruntime-node");
    if (!ort?.InferenceSession?.create) {
      process.stderr.write("[reranker] ORT patch skipped: InferenceSession.create not found\n");
      return;
    }
    const origCreate = ort.InferenceSession.create.bind(ort.InferenceSession);
    ort.InferenceSession.create = async function(pathOrBuffer, options = {}) {
      if (!options.intraOpNumThreads) options.intraOpNumThreads = INTRA_OP_THREADS2;
      if (!options.interOpNumThreads) options.interOpNumThreads = INTER_OP_THREADS2;
      return origCreate(pathOrBuffer, options);
    };
    _ortPatched = true;
    process.stderr.write(`[reranker] ORT patched OK: intra=${INTRA_OP_THREADS2} inter=${INTER_OP_THREADS2}
`);
  } catch (err) {
    process.stderr.write(`[reranker] ORT patch failed: ${err?.message || err}
`);
  }
}
var _tokenizer = null;
var _model = null;
var _loading = null;
var _device = "cpu";
var _scoreCache = /* @__PURE__ */ new Map();
var SCORE_CACHE_LIMIT = 2e3;
var MAX_QUERY_CHARS = 192;
var MAX_TEXT_CHARS = 240;
var DEFAULT_MODEL_ID = "Xenova/bge-reranker-large";
function getRerankerModelId() {
  return process.env.TRIB_MEMORY_RERANKER_MODEL_ID || DEFAULT_MODEL_ID;
}
function normalizeRerankText(value, maxChars) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxChars);
}
function scoreCacheKey(query, text) {
  return `${getRerankerModelId()}
${normalizeRerankText(query, MAX_QUERY_CHARS)}
${normalizeRerankText(text, MAX_TEXT_CHARS)}`;
}
function getCachedScore(query, text) {
  const key = scoreCacheKey(query, text);
  if (!_scoreCache.has(key)) return null;
  const value = _scoreCache.get(key);
  _scoreCache.delete(key);
  _scoreCache.set(key, value);
  return value;
}
function setCachedScore(query, text, score) {
  const key = scoreCacheKey(query, text);
  if (_scoreCache.has(key)) _scoreCache.delete(key);
  _scoreCache.set(key, score);
  if (_scoreCache.size > SCORE_CACHE_LIMIT) {
    const oldestKey = _scoreCache.keys().next().value;
    if (oldestKey) _scoreCache.delete(oldestKey);
  }
}
async function ensureModel() {
  const modelId = getRerankerModelId();
  if (_model && _tokenizer) return;
  if (_loading) return _loading;
  _loading = (async () => {
    patchOrtThreads2();
    try {
      mkdirSync2(MODEL_CACHE_DIR2, { recursive: true });
    } catch {
    }
    hfEnv.cacheDir = MODEL_CACHE_DIR2;
    _tokenizer = await AutoTokenizer.from_pretrained(modelId);
    const preferGpu = (process.env.TRIB_MEMORY_RERANKER_DEVICE || "auto") !== "cpu";
    if (preferGpu) {
      try {
        hfEnv.backends.onnx = hfEnv.backends.onnx || {};
        hfEnv.backends.onnx.executionProviders = [{ name: "dml" }, { name: "cpu" }];
        _model = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: "q4" });
        _device = "dml";
        process.stderr.write(`[reranker] loaded ${modelId} on DirectML (GPU)
`);
      } catch (gpuErr) {
        process.stderr.write(`[reranker] DML failed (${gpuErr.message?.slice(0, 80)}), falling back to CPU
`);
        hfEnv.backends.onnx.executionProviders = [{ name: "cpu" }];
        _model = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: "q4" });
        _device = "cpu";
        process.stderr.write(`[reranker] loaded ${modelId} on CPU
`);
      }
    } else {
      _model = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: "q4" });
      _device = "cpu";
      process.stderr.write(`[reranker] loaded ${modelId} on CPU (forced)
`);
    }
    _loading = null;
  })();
  return _loading;
}
async function scoreOne(queryText, docText) {
  const inputs = _tokenizer(queryText, { text_pair: docText, truncation: true, max_length: 512 });
  const output = await _model(inputs);
  return output.logits.data[0];
}
async function rerank(query, items, topK) {
  const limit = Math.min(Number(topK ?? 5), items.length);
  if (limit === 0) return [];
  const queryText = normalizeRerankText(query, MAX_QUERY_CHARS);
  const entries = items.slice(0, Math.max(limit * 3, items.length)).map((item) => ({ item, text: normalizeRerankText(item.content ?? item.text ?? "", MAX_TEXT_CHARS) })).filter((entry) => entry.text);
  if (entries.length === 0) return [];
  await ensureModel();
  const scored = [];
  for (const entry of entries) {
    const cached = getCachedScore(queryText, entry.text);
    if (cached != null) {
      scored.push({ ...entry.item, reranker_score: Number(cached) });
      continue;
    }
    const score = await scoreOne(queryText, entry.text);
    setCachedScore(queryText, entry.text, score);
    scored.push({ ...entry.item, reranker_score: score });
    if (_device === "cpu") await new Promise((r) => setTimeout(r, 10));
  }
  return scored.sort((a, b) => Number(b.reranker_score) - Number(a.reranker_score)).slice(0, limit);
}

// lib/memory-vector-utils.mjs
import { createHash } from "crypto";
function vecToHex(vector) {
  const hex = Buffer.from(new Float32Array(vector).buffer).toString("hex");
  if (!/^[0-9a-f]+$/.test(hex)) throw new Error("invalid hex from vector");
  return hex;
}
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function averageVectors(vectors = []) {
  const rows = vectors.filter((vector) => Array.isArray(vector) && vector.length > 0);
  if (rows.length === 0) return [];
  const dims = rows[0].length;
  const out = new Array(dims).fill(0);
  for (const vector of rows) {
    if (vector.length !== dims) continue;
    for (let i = 0; i < dims; i += 1) out[i] += vector[i];
  }
  for (let i = 0; i < dims; i += 1) out[i] /= rows.length;
  return out;
}
function embeddingItemKey(entityType, entityId) {
  return `${entityType}:${entityId}`;
}
function hashEmbeddingInput(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}
function contextualizeEmbeddingInput(item) {
  const entityType = String(item.entityType ?? "");
  const content = cleanMemoryText(item.content ?? "");
  if (!content) return "";
  if (entityType === "fact") {
    const label = String(item.subtype ?? "fact");
    const slot = item.slot ? ` slot=${item.slot}` : "";
    const workstream = item.workstream ? ` workstream=${item.workstream}` : "";
    return cleanMemoryText(`memory fact type=${label}${slot}${workstream}
${content}`);
  }
  if (entityType === "task") {
    const status = item.status ? ` status=${item.status}` : "";
    const priority = item.priority ? ` priority=${item.priority}` : "";
    const workstream = item.workstream ? ` workstream=${item.workstream}` : "";
    return cleanMemoryText(`memory task${status}${priority}${workstream}
${content}`);
  }
  if (entityType === "signal") {
    const kind = item.subtype ? ` kind=${item.subtype}` : "";
    return cleanMemoryText(`memory signal${kind}
${content}`);
  }
  if (entityType === "entity") {
    const etype = item.subtype ? ` type=${item.subtype}` : "";
    return cleanMemoryText(`knowledge entity${etype}
${content}`);
  }
  if (entityType === "relation") {
    const rtype = item.subtype ? ` type=${item.subtype}` : "";
    return cleanMemoryText(`knowledge relation${rtype}
${content}`);
  }
  return content;
}

// lib/memory-tuning.mjs
function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function deepMerge(target, source) {
  if (!isPlainObject(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}
var DEFAULT_MEMORY_TUNING = Object.freeze({
  devBias: {
    queryThreshold: 0.3,
    taskBoost: 0.25,
    decisionBoost: 0.15,
    profileSuppress: 0.15,
    eventSuppress: 0.08,
    workstreamBoost: 0.2,
    generalSuppress: 0.6
  },
  intent: {
    topScoreMin: 0.74,
    gapMin: 0.05
  },
  secondStageThreshold: {
    default: -0.3,
    profile: -0.28,
    task: -0.28,
    policy: -0.3,
    history: -0.26,
    event: -0.26,
    graph: -0.32
  },
  hintInjection: {
    compositeWeights: {
      relevance: 0.58,
      confidence: 0.27,
      overlap: 0.15
    },
    thresholds: {
      default: { relevance: 0.65, composite: 0.6, confidence: 1, overlap: 1 },
      profile: { relevance: 0.74, composite: 0.7, confidence: 0.86, overlap: 0.34 },
      signal: { relevance: 0.78, composite: 0.74, confidence: 0.88, overlap: 0.34 },
      task: { relevance: 0.62, composite: 0.58, confidence: 0.88, overlap: 0.34 },
      fact: { relevance: 0.62, composite: 0.58, confidence: 0.9, overlap: 0.34 },
      proposition: { relevance: 0.62, composite: 0.58, confidence: 0.9, overlap: 0.34 }
    }
  },
  taskSeed: {
    stageBonus: {
      implementing: 0.42,
      wired: 0.34,
      verified: 0.26,
      investigating: 0.12,
      planned: -0.24,
      done: 0.08
    },
    statusBonus: {
      in_progress: 0.28,
      active: 0.22,
      paused: -0.06,
      done: 0.68,
      doneExcluded: -0.32
    },
    priorityBonus: {
      high: 0.14,
      normal: 0.06,
      low: 0
    },
    ongoingQuery: {
      plannedPenalty: -1.05,
      pausedPenalty: -0.2,
      activeBonus: 0.22,
      inProgressBonus: 0.28
    }
  },
  history: {
    representative: {
      overlapMultiplier: 6,
      semanticMultiplier: 4,
      contentLengthDivisor: 180,
      contentLengthMax: 1.25,
      assistantBonus: 0.2,
      turnBonus: 0.1,
      recencyBonus: 1e-6
    },
    exactDate: {
      overlapMultiplier: 8,
      weightedScoreMultiplier: -1,
      contentLengthDivisor: 180,
      contentLengthMax: 1.2,
      assistantBonus: 0.24,
      turnBonus: 0.12
    }
  },
  weights: {
    recency: {
      maxPenalty: 0.4,
      stabilityStep: 0.8,
      maxRetrievalFactor: 5,
      windowDays: 15
    },
    overlap: {
      defaultMax: 0.38,
      policyMax: 0.5,
      historyMax: 0.42
    },
    retrieval: {
      maxBoost: 0.08,
      step: 0.01
    },
    focus: {
      maxBoost: 0.14,
      multiplier: 0.12
    },
    quality: {
      strongMax: 0.12,
      strongMultiplier: 0.3,
      lightMax: 0.08,
      lightMultiplier: 0.2
    },
    densityPenalty: {
      signalNoOverlap: 0.12,
      episodeNoOverlap: 0.1
    },
    entityBoost: {
      entityMatch: -0.28,
      relationMatch: -0.24,
      scopedMatch: -0.26
    },
    doneTask: {
      doneBoost: -0.42,
      activePenalty: 0.28
    },
    taskStagePenalty: {
      planned: 0.18,
      investigating: 0.08,
      implementing: -0.05,
      wired: -0.04,
      verified: -0.03
    },
    relationPenalty: {
      default: 0.12
    },
    typeBoost: {
      fact: {
        preference: -0.16,
        constraint: -0.15,
        decision: -0.11,
        default: -0.09
      },
      task: -0.1,
      proposition: -0.12,
      entity: -0.08,
      relation: -0.1,
      profile: -0.08,
      signal: {
        tone: -0.08,
        language: -0.08,
        default: -0.04
      },
      episode: -0.04
    },
    intentBoost: {
      profile: {
        fact: { preference: -0.18, constraint: -0.18 },
        proposition: -0.14,
        signal: { tone: -0.14, language: -0.14 },
        profile: -0.22,
        task: 0.1,
        episode: 0.12
      },
      task: {
        task: -0.26,
        proposition: 0.04,
        fact: { decision: 0.04, constraint: 0.02, default: 0.12 },
        signal: 0.12,
        episode: 0.12
      },
      policy: {
        fact: { constraint: -0.18, decision: -0.1 },
        proposition: -0.14,
        relation: -0.08,
        entity: -0.06,
        signal: -0.04,
        task: 0.08,
        episode: 0.04
      },
      event: {
        episode: -0.22,
        proposition: -0.12,
        taskWithSource: -0.06,
        factWithSource: -0.04,
        signal: 0.08
      },
      history: {
        episode: -0.12,
        proposition: -0.12,
        entity: -0.1,
        relation: -0.1,
        task: -0.04,
        signal: 0.06
      },
      decision: {
        fact: { decision: -0.12, constraint: -0.1 },
        proposition: -0.12,
        entity: -0.12,
        relation: -0.14,
        profile: -0.08,
        task: -0.03
      }
    }
  },
  reranker: {
    enabled: true,
    model: "Xenova/bge-reranker-large",
    overFetch: 15,
    minRerankerScore: -2,
    maxCandidates: 15
  }
});
function mergeMemoryTuning(overrides = {}) {
  const base = JSON.parse(JSON.stringify(DEFAULT_MEMORY_TUNING));
  return deepMerge(base, overrides);
}

// lib/memory-retrievers.mjs
async function getEpisodeSessionId(store2, sourceEpisodeId, cache) {
  const id = Number(sourceEpisodeId ?? 0);
  if (!id) return "";
  if (cache.has(id)) return cache.get(id);
  try {
    const value = String(store2.db.prepare(`SELECT session_id FROM episodes WHERE id = ?`).get(id)?.session_id ?? "");
    cache.set(id, value);
    return value;
  } catch {
    cache.set(id, "");
    return "";
  }
}
function parseComparableTime(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1e3 : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}
async function applyMetadataFilters(store2, rows = [], filters = {}) {
  const memoryKind = String(filters.memory_kind ?? "").trim();
  const taskStatus = String(filters.task_status ?? "").trim();
  const sourceType = String(filters.source_type ?? "").trim().toLowerCase();
  const sessionId = String(filters.session_id ?? "").trim();
  const startTs = parseComparableTime(filters.start_ts ?? "");
  const endTs = parseComparableTime(filters.end_ts ?? "");
  if (!memoryKind && !taskStatus && !sourceType && !sessionId && startTs == null && endTs == null) return rows;
  const sessionCache = /* @__PURE__ */ new Map();
  const filtered = [];
  for (const row of rows) {
    if (memoryKind && String(row?.type ?? "") !== memoryKind) continue;
    if (taskStatus && row?.type === "task" && String(row?.status ?? "") !== taskStatus) continue;
    if (sourceType) {
      const kind = String(row?.source_kind ?? "").toLowerCase();
      const backend = String(row?.source_backend ?? "").toLowerCase();
      if (kind !== sourceType && backend !== sourceType) continue;
    }
    if (sessionId) {
      const matchedSessionId = await getEpisodeSessionId(store2, row?.source_episode_id ?? row?.entity_id, sessionCache);
      if (matchedSessionId !== sessionId) continue;
    }
    if (startTs != null || endTs != null) {
      const rowTs = parseComparableTime(row?.source_ts ?? row?.updated_at ?? "");
      if (rowTs == null) continue;
      if (startTs != null && rowTs < startTs) continue;
      if (endTs != null && rowTs > endTs) continue;
    }
    filtered.push(row);
  }
  return filtered;
}

// lib/memory-recall-store.mjs
var RECALL_EPISODE_KIND_SQL = `'message', 'turn'`;
var DEBUG_RECALL_EPISODE_KIND_SQL = `'message', 'turn', 'transcript'`;
async function getEpisodeRecallRows(store2, options = {}) {
  const {
    query = "",
    startDate,
    endDate,
    limit = 5,
    queryVector = null,
    ftsQuery = "",
    includeTranscripts = false
  } = options;
  const clean = String(query ?? "").trim();
  const queryLimit = Math.max(1, Number(limit));
  let episodes = [];
  if (store2.vecEnabled && Array.isArray(queryVector) && queryVector.length > 0) {
    try {
      const hex = vecToHex(queryVector);
      const knnRows = store2.vecReadDb.prepare(
        `SELECT rowid, distance FROM vec_memory WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT ?`
      ).all(queryLimit * 5);
      for (const knn of knnRows) {
        const { entityType, entityId } = store2._vecRowToEntity(knn.rowid);
        if (entityType !== "episode") continue;
        const ep = store2.db.prepare(`
          SELECT id, ts, day_key, role, kind, content, source_ref, backend AS source_backend
          FROM episodes
          WHERE id = ? AND day_key >= ? AND day_key <= ?
            AND kind IN (${includeTranscripts ? DEBUG_RECALL_EPISODE_KIND_SQL : RECALL_EPISODE_KIND_SQL})
        `).get(entityId, startDate, endDate);
        if (ep) episodes.push({ ...ep, similarity: 1 - knn.distance });
      }
    } catch {
    }
  }
  if (episodes.length === 0 && clean) {
    try {
      episodes = store2.db.prepare(`
        SELECT e.id, e.ts, e.day_key, e.role, e.kind, e.content, e.source_ref, e.backend AS source_backend, bm25(episodes_fts) AS score
        FROM episodes_fts
        JOIN episodes e ON e.id = episodes_fts.rowid
        WHERE episodes_fts MATCH ? AND e.day_key >= ? AND e.day_key <= ?
          AND e.kind IN (${includeTranscripts ? DEBUG_RECALL_EPISODE_KIND_SQL : RECALL_EPISODE_KIND_SQL})
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, startDate, endDate, queryLimit * 2);
    } catch {
    }
  }
  if (episodes.length === 0 && !clean) {
    episodes = store2.db.prepare(`
      SELECT e.id, e.ts, e.day_key, e.role, e.kind, e.content, e.source_ref, e.backend AS source_backend
      FROM episodes e
      WHERE e.day_key >= ? AND e.day_key <= ?
        AND e.kind IN (${includeTranscripts ? DEBUG_RECALL_EPISODE_KIND_SQL : RECALL_EPISODE_KIND_SQL})
      ORDER BY e.ts DESC
      LIMIT ?
    `).all(startDate, endDate, queryLimit);
  }
  const seen = /* @__PURE__ */ new Set();
  return episodes.filter((row) => {
    const id = Number(row.id ?? row.entity_id ?? 0);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, queryLimit);
}
function getRecallShortcutRows(store2, kind = "all", limit = 5, options = {}) {
  const queryLimit = Math.max(1, Number(limit));
  const { startDate = null, endDate = null } = options;
  let rows = [];
  if (kind === "all" || kind === "episodes") {
    rows.push(...store2.db.prepare(`
      SELECT 'episode' AS type, role AS subtype, content, ts AS last_seen
      FROM episodes
      WHERE kind IN (${RECALL_EPISODE_KIND_SQL})
        AND content NOT LIKE 'You are consolidating%'
        AND LENGTH(content) >= 10
        ${startDate && endDate ? "AND day_key >= ? AND day_key <= ?" : ""}
      ORDER BY ts DESC
      LIMIT ?
    `).all(...startDate && endDate ? [startDate, endDate, kind === "all" ? Math.ceil(queryLimit / 2) : queryLimit] : [kind === "all" ? Math.ceil(queryLimit / 2) : queryLimit]));
  }
  if (kind === "all" || kind === "classifications") {
    rows.push(...store2.db.prepare(`
      SELECT 'classification' AS type, classification AS subtype,
             trim(classification || ' | ' || topic || ' | ' || element || CASE WHEN state IS NOT NULL AND state != '' THEN ' | ' || state ELSE '' END) AS content,
             confidence, updated_at AS last_seen
      FROM classifications
      WHERE status = 'active'
        ${startDate && endDate ? "AND day_key >= ? AND day_key <= ?" : ""}
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ?
    `).all(...startDate && endDate ? [startDate, endDate, kind === "all" ? Math.ceil(queryLimit / 2) : queryLimit] : [kind === "all" ? Math.ceil(queryLimit / 2) : queryLimit]));
  }
  return rows;
}

// lib/memory-maintenance-store.mjs
function getEpisodesSince(store2, timestamp) {
  const ts = typeof timestamp === "number" ? new Date(timestamp).toISOString() : String(timestamp);
  return store2.db.prepare(`
    SELECT id, ts, role, kind, content
    FROM episodes
    WHERE ts > ?
    ORDER BY ts, id
  `).all(ts);
}
function countEpisodes(store2) {
  return store2.db.prepare(`SELECT count(*) AS n FROM episodes`).get().n;
}
function getCandidatesForDate(store2, dayKey) {
  return store2.db.prepare(`
    SELECT mc.id, mc.episode_id, mc.ts, mc.role, mc.content, mc.score
    FROM memory_candidates mc
    JOIN episodes e ON e.id = mc.episode_id
    WHERE mc.day_key = ?
      AND mc.status = 'pending'
      AND e.role IN ('user', 'assistant')
      AND e.kind = 'message'
    ORDER BY mc.score DESC, mc.ts ASC
  `).all(dayKey);
}
function getPendingCandidateDays(store2, limit = 7, minCount = 1) {
  return store2.db.prepare(`
    SELECT mc.day_key, count(*) AS n
    FROM memory_candidates mc
    JOIN episodes e ON e.id = mc.episode_id
    WHERE mc.status = 'pending'
      AND e.role IN ('user', 'assistant')
      AND e.kind = 'message'
    GROUP BY mc.day_key
    HAVING count(*) >= ?
    ORDER BY mc.day_key DESC
    LIMIT ?
  `).all(minCount, limit);
}
function getDecayRows(_store, _kind = "fact") {
  return [];
}
function resetEmbeddingIndex(store2, options = {}) {
  store2.clearVectorsStmt.run();
  try {
    store2.db.prepare("DELETE FROM pending_embeds").run();
  } catch {
  }
  if (store2.vecEnabled) {
    try {
      store2.db.exec("DROP TABLE IF EXISTS vec_memory");
      store2.db.exec(`CREATE VIRTUAL TABLE vec_memory USING vec0(embedding float[${getEmbeddingDims()}])`);
    } catch {
    }
  }
  store2.syncEmbeddingMetadata({
    reason: options.reason ?? "reset_embedding_index",
    reindexRequired: 1,
    reindexReason: options.reindexReason ?? "embedding index reset"
  });
}
function vacuumDatabase(store2) {
  try {
    store2.db.exec("VACUUM");
    return true;
  } catch {
    return false;
  }
}
function getRecentCandidateDays(store2, limit = 7) {
  return store2.db.prepare(`
    SELECT mc.day_key, count(*) AS n
    FROM memory_candidates mc
    JOIN episodes e ON e.id = mc.episode_id
    WHERE e.role = 'user'
      AND e.kind = 'message'
    GROUP BY mc.day_key
    ORDER BY mc.day_key DESC
    LIMIT ?
  `).all(limit);
}
function countPendingCandidates(store2, dayKey = null) {
  if (dayKey) {
    return store2.db.prepare(`
      SELECT count(*) AS n
      FROM memory_candidates mc
      JOIN episodes e ON e.id = mc.episode_id
      WHERE mc.status = 'pending'
        AND mc.day_key = ?
        AND e.role = 'user'
        AND e.kind = 'message'
    `).get(dayKey).n;
  }
  return store2.db.prepare(`
    SELECT count(*) AS n
    FROM memory_candidates mc
    JOIN episodes e ON e.id = mc.episode_id
    WHERE mc.status = 'pending'
      AND e.role = 'user'
      AND e.kind = 'message'
  `).get().n;
}
function rebuildCandidates(store2) {
  store2.clearCandidatesStmt.run();
  const rows = store2.db.prepare(`
    SELECT id, ts, day_key, role, kind, content
    FROM episodes
    ORDER BY ts, id
  `).all();
  let created = 0;
  for (const row of rows) {
    const clean = cleanMemoryText(row.content);
    if (!clean) continue;
    const shouldCandidate = (row.role === "user" || row.role === "assistant") && row.kind === "message";
    if (shouldCandidate) {
      created += insertCandidateUnits(store2.insertCandidateStmt, row.id, row.ts, row.day_key, row.role, clean);
    }
  }
  return created;
}
function resetConsolidatedMemory(store2) {
  store2.clearClassificationsStmt.run();
  store2.clearClassificationsFtsStmt.run();
  store2.clearVectorsStmt.run();
  if (store2.vecEnabled) {
    try {
      store2.db.exec("DELETE FROM vec_memory");
    } catch {
    }
  }
  store2.db.prepare(`UPDATE memory_candidates SET status = 'pending'`).run();
}
function resetConsolidatedMemoryForDays(store2, dayKeys = []) {
  const keys = [...new Set(dayKeys.map((key) => String(key).trim()).filter(Boolean))];
  if (keys.length === 0) return;
  const placeholders = keys.map(() => "?").join(", ");
  const episodeIds = store2.db.prepare(`
    SELECT id
    FROM episodes
    WHERE day_key IN (${placeholders})
  `).all(...keys).map((row) => Number(row.id)).filter(Number.isFinite);
  if (episodeIds.length > 0) {
    const episodePlaceholders = episodeIds.map(() => "?").join(", ");
    const classificationIds = store2.db.prepare(`
      SELECT id FROM classifications WHERE episode_id IN (${episodePlaceholders})
    `).all(...episodeIds).map((row) => Number(row.id)).filter(Number.isFinite);
    if (classificationIds.length > 0) {
      const clsPlaceholders = classificationIds.map(() => "?").join(", ");
      for (const id of classificationIds) store2.deleteClassificationFtsStmt.run(id);
      store2.db.prepare(`DELETE FROM classifications WHERE id IN (${clsPlaceholders})`).run(...classificationIds);
      store2.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'classification' AND entity_id IN (${clsPlaceholders})`).run(...classificationIds);
      if (store2.vecEnabled) {
        for (const id of classificationIds) {
          const rowid = store2._vecRowId("classification", id);
          try {
            store2.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`);
          } catch {
          }
        }
      }
    }
  }
  store2.db.prepare(`
    UPDATE memory_candidates
    SET status = 'pending'
    WHERE day_key IN (${placeholders})
  `).run(...keys);
}
function pruneConsolidatedMemoryOutsideDays(store2, dayKeys = []) {
  const keys = [...new Set(dayKeys.map((key) => String(key).trim()).filter(Boolean))];
  if (keys.length === 0) return;
  const placeholders = keys.map(() => "?").join(", ");
  const keepEpisodeIds = store2.db.prepare(`
    SELECT id
    FROM episodes
    WHERE day_key IN (${placeholders})
  `).all(...keys).map((row) => Number(row.id)).filter(Number.isFinite);
  if (keepEpisodeIds.length === 0) return;
  const keepPlaceholders = keepEpisodeIds.map(() => "?").join(", ");
  const staleClassificationIds = store2.db.prepare(`
    SELECT id FROM classifications
    WHERE episode_id IS NOT NULL
      AND episode_id NOT IN (${keepPlaceholders})
  `).all(...keepEpisodeIds).map((row) => Number(row.id)).filter(Number.isFinite);
  if (staleClassificationIds.length > 0) {
    const stalePlaceholders = staleClassificationIds.map(() => "?").join(", ");
    for (const id of staleClassificationIds) store2.deleteClassificationFtsStmt.run(id);
    store2.db.prepare(`DELETE FROM classifications WHERE id IN (${stalePlaceholders})`).run(...staleClassificationIds);
    store2.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'classification' AND entity_id IN (${stalePlaceholders})`).run(...staleClassificationIds);
    if (store2.vecEnabled) {
      for (const id of staleClassificationIds) {
        const rowid = store2._vecRowId("classification", id);
        try {
          store2.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`);
        } catch {
        }
      }
    }
  }
}
function markCandidateIdsConsolidated(store2, candidateIds = []) {
  const ids = [...new Set(candidateIds.map((id) => Number(id)).filter(Number.isFinite))];
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  const stmt = store2.db.prepare(`
    DELETE FROM memory_candidates
    WHERE status = 'pending'
      AND id IN (${placeholders})
  `);
  const result = stmt.run(...ids);
  return Number(result.changes ?? 0);
}
function markCandidatesConsolidated(store2, dayKey) {
  return Number(store2.db.prepare(`
    DELETE FROM memory_candidates
    WHERE day_key = ? AND status = 'pending'
  `).run(dayKey).changes ?? 0);
}

// lib/memory-context-builder.mjs
import fs from "node:fs";
import path from "node:path";

// lib/memory-context-utils.mjs
function buildHintKey(item, overrides = {}) {
  const type = overrides.type ?? item?.type ?? "episode";
  const rawText = String(overrides.text ?? item?.content ?? item?.text ?? item?.value ?? "").trim();
  if (!rawText) return "";
  const normalized = cleanMemoryText(rawText).toLowerCase().replace(/\s+/g, " ").slice(0, 160);
  return `${type}:${normalized}`;
}
function formatHintTag(item, overrides = {}, _options = {}) {
  const type = overrides.type ?? item?.type ?? "episode";
  if (type === "chunk") {
    const topic = item?.classification_topic || item?.topic || "";
    const text2 = String(item?.content || "").trim();
    return text2 ? `- ${topic ? topic + ": " : ""}${text2}` : "";
  }
  if (type === "classification") {
    const topic = item?.topic || "";
    const element = item?.element || "";
    const text2 = [topic, element].filter(Boolean).join(" \u2014 ");
    return text2 ? `- ${text2}` : "";
  }
  if (item?.classification_element) {
    let chunks = [];
    try {
      chunks = JSON.parse(item.classification_chunks || "[]");
    } catch {
    }
    if (chunks.length > 0) {
      const prefix2 = item.classification_topic ? `${item.classification_topic}: ` : "";
      return `- ${prefix2}${chunks.join(" / ")}`;
    }
    const prefix = item.classification_topic ? `${item.classification_topic} \u2014 ` : "";
    return `- ${prefix}${item.classification_element}`;
  }
  const raw = String(overrides.text ?? item?.content ?? item?.text ?? item?.value ?? "");
  let text = raw.replace(/\s+/g, " ").trim();
  if (item?.subtype === "assistant") {
    text = text.replace(/^(죄송합니다[.,]?\s*|알겠습니다[.,]?\s*|네[.,]\s*|바로\s+하겠습니다[.,]?\s*)+/u, "");
  }
  return text ? `- ${text.slice(0, 200)}` : "";
}

// lib/memory-ops-policy.mjs
var DEFAULT_OPS_POLICY = {
  features: {
    reranker: false,
    temporalParser: false
  },
  startup: {
    backfill: {
      mode: "if-empty",
      window: "7d",
      scope: "all",
      limit: 80
    },
    // Startup catch-up disabled by default: was running inline embeddings
    // ~5s after server start, causing perceptible lag right after user typed.
    // Pending work is still handled by the regular 5-min cycle1 interval.
    cycle1CatchUp: {
      mode: "off",
      delayMs: 5e3,
      minPendingCandidates: 8,
      requireDue: false
    },
    cycle2CatchUp: {
      mode: "off",
      delayMs: 5e3,
      requireDue: true
    }
  },
  scheduler: {
    checkIntervalMs: 6e4
  }
};
function coercePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
function normalizeBackfillWindow(value) {
  const normalized = String(value ?? "all").trim().toLowerCase();
  if (["none", "off", "disabled", "0"].includes(normalized)) return "none";
  if (["1d", "1day", "1-day", "1 day", "day", "today"].includes(normalized)) return "1d";
  if (["3d", "3days", "3-day", "3 day"].includes(normalized)) return "3d";
  if (["7d", "7days", "7-day", "7 day", "week"].includes(normalized)) return "7d";
  if (["30d", "30days", "30-day", "30 day", "month"].includes(normalized)) return "30d";
  return "all";
}
function normalizeCatchUpMode(value, fallback = "light") {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  if (["off", "none", "disabled"].includes(normalized)) return "off";
  if (["full", "all", "aggressive"].includes(normalized)) return "full";
  return "light";
}
function normalizeBackfillMode(value) {
  const normalized = String(value ?? "if-empty").trim().toLowerCase();
  if (["off", "none", "disabled"].includes(normalized)) return "off";
  if (["always", "force"].includes(normalized)) return "always";
  return "if-empty";
}
function normalizeBackfillScope(value) {
  const normalized = String(value ?? "all").trim().toLowerCase();
  if (["workspace", "project", "current"].includes(normalized)) return "workspace";
  return "all";
}
function envFlag(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}
function readMemoryOpsPolicy(mainConfig2 = {}) {
  const runtimeConfig = mainConfig2?.runtime ?? {};
  const featuresConfig = runtimeConfig?.features ?? {};
  const startupConfig = runtimeConfig?.startup ?? {};
  const backfillConfig = mainConfig2?.backfill ?? startupConfig?.backfill ?? {};
  const cycle1CatchUpConfig = startupConfig?.cycle1CatchUp ?? {};
  const cycle2CatchUpConfig = startupConfig?.cycle2CatchUp ?? {};
  const schedulerConfig = runtimeConfig?.scheduler ?? {};
  return {
    features: {
      // Opt-in: reranker must be explicitly `true` in config.
      // Previous `!== false` treated undefined as true, contradicting
      // DEFAULT_OPS_POLICY.features.reranker=false.
      reranker: featuresConfig.reranker === true,
      temporalParser: featuresConfig.temporalParser === true
    },
    startup: {
      backfill: {
        mode: normalizeBackfillMode(backfillConfig.mode ?? DEFAULT_OPS_POLICY.startup.backfill.mode),
        window: normalizeBackfillWindow(backfillConfig.window ?? DEFAULT_OPS_POLICY.startup.backfill.window),
        scope: normalizeBackfillScope(backfillConfig.scope ?? DEFAULT_OPS_POLICY.startup.backfill.scope),
        limit: coercePositiveInt(backfillConfig.limit, DEFAULT_OPS_POLICY.startup.backfill.limit)
      },
      cycle1CatchUp: {
        mode: normalizeCatchUpMode(cycle1CatchUpConfig.mode, DEFAULT_OPS_POLICY.startup.cycle1CatchUp.mode),
        delayMs: coercePositiveInt(cycle1CatchUpConfig.delayMs, DEFAULT_OPS_POLICY.startup.cycle1CatchUp.delayMs),
        minPendingCandidates: coercePositiveInt(
          cycle1CatchUpConfig.minPendingCandidates,
          DEFAULT_OPS_POLICY.startup.cycle1CatchUp.minPendingCandidates
        ),
        requireDue: cycle1CatchUpConfig.requireDue === true
      },
      cycle2CatchUp: {
        mode: normalizeCatchUpMode(cycle2CatchUpConfig.mode, DEFAULT_OPS_POLICY.startup.cycle2CatchUp.mode),
        delayMs: coercePositiveInt(cycle2CatchUpConfig.delayMs, DEFAULT_OPS_POLICY.startup.cycle2CatchUp.delayMs),
        requireDue: cycle2CatchUpConfig.requireDue !== false
      }
    },
    scheduler: {
      checkIntervalMs: coercePositiveInt(schedulerConfig.checkIntervalMs, DEFAULT_OPS_POLICY.scheduler.checkIntervalMs)
    }
  };
}
function readMemoryFeatureFlags(mainConfig2 = {}) {
  const policy = readMemoryOpsPolicy(mainConfig2);
  return {
    reranker: envFlag(process.env.TRIB_MEMORY_ENABLE_RERANKER, policy.features.reranker),
    temporalParser: envFlag(process.env.TRIB_MEMORY_ENABLE_TEMPORAL_PARSER, policy.features.temporalParser)
  };
}
function resolveBackfillSinceMs(windowValue, now = Date.now()) {
  const normalized = normalizeBackfillWindow(windowValue);
  if (normalized === "1d") return now - 1 * 24 * 60 * 60 * 1e3;
  if (normalized === "3d") return now - 3 * 24 * 60 * 60 * 1e3;
  if (normalized === "7d") return now - 7 * 24 * 60 * 60 * 1e3;
  if (normalized === "30d") return now - 30 * 24 * 60 * 60 * 1e3;
  return null;
}
function buildStartupBackfillOptions(policy, store2, now = Date.now()) {
  const backfill = policy?.startup?.backfill;
  if (!backfill || backfill.mode === "off") return null;
  if (backfill.mode === "if-empty" && Number(store2?.countEpisodes?.() ?? 0) > 0) return null;
  return {
    scope: backfill.scope,
    limit: backfill.limit,
    sinceMs: resolveBackfillSinceMs(backfill.window, now)
  };
}
function shouldRunCycleCatchUp(kind, policy, state = {}) {
  const config = kind === "cycle2" ? policy?.startup?.cycle2CatchUp : policy?.startup?.cycle1CatchUp;
  const mode = config?.mode ?? "off";
  if (mode === "off") return false;
  const due = Boolean(state.due);
  const pendingCandidates = Number(state.pendingCandidates ?? 0);
  const pendingEmbeds = Number(state.pendingEmbeds ?? 0);
  const missingLastRun = !state.lastRunAt;
  if (kind === "cycle2") {
    if (mode === "full") return due || pendingCandidates > 0 || missingLastRun;
    return config?.requireDue !== false ? due : due || pendingCandidates > 0 || missingLastRun;
  }
  if (mode === "full") return due || pendingCandidates > 0 || pendingEmbeds > 0 || missingLastRun;
  if (config?.requireDue === true) return due;
  return due || pendingCandidates >= Number(config?.minPendingCandidates ?? 0) || missingLastRun && (pendingCandidates > 0 || pendingEmbeds > 0);
}

// lib/memory-context-builder.mjs
function nextDateStr(value) {
  const date = /* @__PURE__ */ new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}
function readContextBuilderConfig(store2) {
  try {
    return JSON.parse(fs.readFileSync(path.join(store2.dataDir, "config.json"), "utf8"));
  } catch {
    return {};
  }
}
async function buildInboundMemoryContext(store2, query, options = {}) {
  const clean = cleanMemoryText(query);
  if (!clean) return "";
  if (!options.skipLowSignal && looksLowSignalQuery(clean)) return "";
  const totalStartedAt = Date.now();
  const stageTimings = [];
  const tuning = store2.getRetrievalTuning();
  const measureStage = async (label, work) => {
    const startedAt = Date.now();
    try {
      return await work();
    } finally {
      stageTimings.push(`${label}=${Date.now() - startedAt}ms`);
    }
  };
  const limit = Number(options.limit ?? 3);
  const lines = [];
  const seenHintKeys = /* @__PURE__ */ new Set();
  const queryTokenCount = Math.max(1, tokenizeMemoryText(clean).length);
  const featureFlags2 = readMemoryFeatureFlags(readContextBuilderConfig(store2));
  const queryVector = await measureStage("embed_query", () => embedText(clean));
  const pushHint = (item, overrides = {}) => {
    const rawText = String(overrides.text ?? item.content ?? item.text ?? item.value ?? "").trim();
    if (!rawText) return;
    if (item.weighted_score == null || item.weighted_score < 0.012) return;
    const key = buildHintKey(item, overrides);
    if (!key) return;
    if (seenHintKeys.has(key)) return;
    seenHintKeys.add(key);
    lines.push(formatHintTag(item, overrides, { queryTokenCount, nowTs: totalStartedAt }));
  };
  let relevant = await measureStage("hybrid_search", () => store2.searchRelevantHybrid(clean, limit, {
    queryVector,
    channelId: options.channelId,
    userId: options.userId,
    recordRetrieval: false,
    tuning
  }));
  relevant = relevant.filter((item) => {
    if (item.type !== "classification" && item.type !== "episode" && item.type !== "chunk") return false;
    if (item.type === "episode") {
      const text = String(item.content || "").replace(/\s+/g, "");
      if (text.length < 5) return false;
    }
    return true;
  });
  const chunkEpisodeIds = new Set(
    relevant.filter((r) => r.type === "chunk" && r.chunk_episode_id).map((r) => Number(r.chunk_episode_id))
  );
  if (chunkEpisodeIds.size > 0) {
    relevant = relevant.filter(
      (item) => item.type !== "episode" || !chunkEpisodeIds.has(Number(item.entity_id))
    );
  }
  const serverStartedAt2 = options.serverStartedAt;
  if (serverStartedAt2) {
    relevant = relevant.filter((item) => {
      if (item.type !== "episode") return true;
      const ts = item.source_ts || item.updated_at;
      if (!ts) return true;
      return ts < serverStartedAt2;
    });
  }
  const typePriority = { chunk: 0, classification: 1, episode: 2 };
  relevant.sort((a, b) => {
    const pa = typePriority[a.type] ?? 2;
    const pb = typePriority[b.type] ?? 2;
    if (pa !== pb) return pa - pb;
    return (b.weighted_score || 0) - (a.weighted_score || 0);
  });
  relevant = relevant.slice(0, Math.max(3, limit));
  if (relevant.length > 0) {
    for (const item of relevant) {
      pushHint(item);
    }
  } else {
    const fallbackClassifications = store2.getClassificationRows(4).map((item) => ({
      type: "classification",
      subtype: item.classification,
      content: [item.classification, item.topic, item.element, item.state].filter(Boolean).join(" | "),
      confidence: item.confidence,
      updated_at: item.updated_at,
      entity_id: item.id
    }));
    for (const item of fallbackClassifications) {
      pushHint(item, { type: "classification" });
    }
  }
  if (lines.length > 0) {
    try {
      let recentTopics = [];
      if (options.channelId) {
        recentTopics = store2.db.prepare(`
          SELECT content FROM episodes
          WHERE role = 'user'
            AND kind = 'message'
            AND channel_id = ?
            AND content NOT LIKE 'You are consolidating%'
            AND content NOT LIKE 'You are improving%'
            AND LENGTH(content) BETWEEN 10 AND 200
            AND ts >= datetime('now', '-1 day')
          ORDER BY ts DESC
          LIMIT 3
        `).all(String(options.channelId));
      }
      if (recentTopics.length === 0 && options.userId) {
        recentTopics = store2.db.prepare(`
          SELECT content FROM episodes
          WHERE role = 'user'
            AND kind = 'message'
            AND user_id = ?
            AND content NOT LIKE 'You are consolidating%'
            AND content NOT LIKE 'You are improving%'
            AND LENGTH(content) BETWEEN 10 AND 200
            AND ts >= datetime('now', '-1 day')
          ORDER BY ts DESC
          LIMIT 3
        `).all(String(options.userId));
      }
      if (recentTopics.length > 0) {
        lines.push("<recent>" + recentTopics.map((r) => cleanMemoryText(r.content).slice(0, 40)).join(" / ") + "</recent>");
      }
    } catch {
    }
  }
  const temporal = parseTemporalHint(clean);
  if (lines.length === 0 && temporal) {
    try {
      const startDate = temporal.start;
      const endDate = nextDateStr(temporal.end ?? temporal.start);
      const fallbackDays = "-3 days";
      let recentEpisodes;
      if (startDate) {
        recentEpisodes = store2.db.prepare(`
          SELECT ts, role, content FROM episodes
          WHERE kind IN ('message', 'turn')
            AND content NOT LIKE 'You are consolidating%'
            AND content NOT LIKE 'You are improving%'
            AND LENGTH(content) BETWEEN 10 AND 500
            AND ts >= ? AND ts < ?
          ORDER BY ts DESC
          LIMIT 5
        `).all(startDate, endDate);
      } else {
        recentEpisodes = store2.db.prepare(`
          SELECT ts, role, content FROM episodes
          WHERE kind IN ('message', 'turn')
            AND content NOT LIKE 'You are consolidating%'
            AND content NOT LIKE 'You are improving%'
            AND LENGTH(content) BETWEEN 10 AND 500
            AND ts >= datetime('now', ?)
          ORDER BY ts DESC
          LIMIT 5
        `).all(fallbackDays);
      }
      for (const ep of recentEpisodes) {
        const prefix = ep.role === "user" ? "u" : "a";
        const text = cleanMemoryText(ep.content).slice(0, 150);
        lines.push(`<hint type="episode" age="${ep.ts}">[${prefix}] ${text}</hint>`);
      }
    } catch {
    }
  }
  if (Array.isArray(queryVector) && queryVector.length > 0) {
    try {
      const activeModel = getEmbeddingModelId();
      const classVectors = store2.db.prepare(`
        SELECT mv.entity_id, mv.vector_json
        FROM memory_vectors mv
        JOIN classifications c ON c.id = mv.entity_id
        WHERE mv.entity_type = 'classification'
          AND mv.model = ?
          AND c.status = 'active'
      `).all(activeModel);
      const nowTs = Math.floor(Date.now() / 1e3);
      const mentionedIds = [];
      for (const row of classVectors) {
        try {
          const vec = JSON.parse(row.vector_json);
          if (!Array.isArray(vec) || vec.length === 0) continue;
          const sim = cosineSimilarity(queryVector, vec);
          if (sim >= 0.4) mentionedIds.push(row.entity_id);
        } catch {
        }
      }
      if (mentionedIds.length > 0) {
        const placeholders = mentionedIds.map(() => "?").join(",");
        store2.db.prepare(`
          UPDATE classifications
          SET retrieval_count = COALESCE(retrieval_count, 0) + 1,
              last_retrieved_at = ?
          WHERE id IN (${placeholders})
        `).run(nowTs, ...mentionedIds);
      }
    } catch {
    }
  }
  const validLines = lines.filter((l) => l && l.trim());
  if (validLines.length === 0) return "";
  const ctx = `<memory-context>
${validLines.join("\n")}
</memory-context>`;
  const totalMs = Date.now() - totalStartedAt;
  process.stderr.write(
    `[memory-timing] q="${clean.slice(0, 40)}" total=${totalMs}ms ${stageTimings.join(" ")}
`
  );
  process.stderr.write(`[memory] recall q="${clean.slice(0, 40)}" hints=${lines.filter((l) => l.startsWith("<hint ")).length}
`);
  return ctx;
}

// lib/memory.mjs
init_memory_score_utils();
var sqliteVec = null;
try {
  sqliteVec = await import("sqlite-vec");
} catch {
}
var stores = /* @__PURE__ */ new Map();
function applyMMR(results, lambda = 0.7) {
  if (results.length <= 1) return results;
  const selected = [results[0]];
  const remaining = results.slice(1);
  while (selected.length < results.length && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const maxSim = Math.max(...selected.map((s) => {
        const a = String(s.content || "").toLowerCase();
        const b = String(candidate.content || "").toLowerCase();
        if (!a || !b) return 0;
        const wordsA = new Set(a.split(/\s+/));
        const wordsB = new Set(b.split(/\s+/));
        const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
        const union = (/* @__PURE__ */ new Set([...wordsA, ...wordsB])).size;
        return union > 0 ? intersection / union : 0;
      }));
      const mmrScore = lambda * (candidate.weighted_score || 0) - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      selected.push(remaining.splice(bestIdx, 1)[0]);
    } else {
      break;
    }
  }
  return selected;
}
function logIgnoredError(scope, error) {
  if (!error) return;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[memory] ${scope}: ${message}
`);
}
function ensureDir(dirPath) {
  mkdirSync3(dirPath, { recursive: true });
}
function workspaceToProjectSlug(workspacePath) {
  return resolve(workspacePath).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1-").replace(/\//g, "-");
}
var RECALL_EPISODE_KIND_SQL2 = `'message', 'turn'`;
var DEBUG_RECALL_EPISODE_KIND_SQL2 = `'message', 'turn', 'transcript'`;
function isTranscriptQuarantineContent(text) {
  const clean = cleanMemoryText(text);
  if (!clean) return true;
  if (clean.length >= 1e4) return true;
  if (clean.length > 2e3 && /(?:^|\n)[ua]:\s/.test(clean)) return true;
  if (/^you are summarizing a day's conversation\b/i.test(clean)) return true;
  if (/^you are compressing summaries\b/i.test(clean)) return true;
  if (/below is the cleaned conversation log/i.test(clean)) return true;
  if (/output only the summary/i.test(clean) && /what tasks were worked on/i.test(clean)) return true;
  if (/summarize in ~?\d+ lines/i.test(clean) && /date:\s*\d{4}-\d{2}-\d{2}/i.test(clean)) return true;
  if (/^you are (analyzing|consolidating|improving|summarizing)\b/i.test(clean)) return true;
  if (/^summarize the conversation\b/i.test(clean)) return true;
  if (/history directory:/i.test(clean) && /read existing files/i.test(clean)) return true;
  if (/return this exact shape:/i.test(clean)) return true;
  if (/output json only/i.test(clean) && /(memory system|trib-memory)/i.test(clean)) return true;
  return false;
}
var MemoryStore = class {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.historyDir = join3(dataDir, "history");
    this.dbPath = join3(dataDir, "memory.sqlite");
    ensureDir(dirname(this.dbPath));
    this.db = new DatabaseSync(this.dbPath, { allowExtension: true });
    this.vecEnabled = false;
    this.readDb = null;
    this._transcriptOffsets = /* @__PURE__ */ new Map();
    this._loadVecExtension();
    this._openReadDb();
    this.init();
    this.syncEmbeddingMetadata();
  }
  _loadVecExtension() {
    if (!sqliteVec) return;
    try {
      sqliteVec.load(this.db);
      this.vecEnabled = true;
      let dims = getEmbeddingDims();
      try {
        const forcedDims = Number(process.env.CLAUDE2BOT_FORCE_VEC_DIMS ?? "0");
        if (forcedDims > 0) {
          dims = forcedDims;
        } else {
          const hasMeta = this.db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='memory_meta'`).get()?.ok;
          if (hasMeta) {
            const storedDims = Number(this.db.prepare(`SELECT value FROM memory_meta WHERE key = 'embedding.vector_dims'`).get()?.value ?? "0");
            if (storedDims > 0) dims = storedDims;
          }
        }
      } catch {
      }
      try {
        const existing = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_memory'`).get();
        if (existing?.sql && !existing.sql.includes(`float[${dims}]`)) {
          this.db.exec("DROP TABLE vec_memory");
          process.stderr.write(`[memory] vec_memory dimension changed, recreating with float[${dims}]
`);
        }
      } catch {
      }
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[${dims}])`);
    } catch (e) {
      process.stderr.write(`[memory] sqlite-vec load failed: ${e.message}
`);
    }
  }
  _openReadDb() {
    try {
      const rdb = new DatabaseSync(this.dbPath, { readOnly: true, allowExtension: true });
      if (sqliteVec) sqliteVec.load(rdb);
      rdb.exec(`PRAGMA busy_timeout = 1000;`);
      this.readDb = rdb;
    } catch (e) {
      process.stderr.write(`[memory] readDb open failed, falling back to main db: ${e.message}
`);
      this.readDb = null;
    }
  }
  get vecReadDb() {
    return this.readDb ?? this.db;
  }
  close() {
    try {
      this.readDb?.close();
    } catch {
    }
    this.readDb = null;
    try {
      this.db?.close();
    } catch {
    }
  }
  async switchEmbeddingModel(config = {}) {
    const oldModel = getEmbeddingModelId();
    configureEmbedding(config);
    await warmupEmbeddingProvider();
    const newModel = getEmbeddingModelId();
    if (oldModel === newModel) return { changed: false };
    process.stderr.write(`[memory] switching embedding model: ${oldModel} \u2192 ${newModel}
`);
    const reset = this.resetDerivedMemoryForEmbeddingChange({ newModel });
    process.stderr.write(
      `[memory] embedding model changed; cleared derived memory and rebuilt ${reset.rebuiltCandidates} candidates for ${newModel}
`
    );
    return { changed: true, oldModel, newModel, reset };
  }
  resetDerivedMemoryForEmbeddingChange(options = {}) {
    const preservedEpisodes = Number(this.countEpisodes() ?? 0);
    this.db.exec(`
      DELETE FROM memory_candidates;
      DELETE FROM classifications;
      DELETE FROM classifications_fts;
      DELETE FROM documents;
      DELETE FROM memory_vectors;
      DELETE FROM pending_embeds;
      DELETE FROM memory_meta;
    `);
    if (this.vecEnabled) {
      try {
        this.db.exec("DROP TABLE IF EXISTS vec_memory");
        const dims = getEmbeddingDims();
        this.db.exec(`CREATE VIRTUAL TABLE vec_memory USING vec0(embedding float[${dims}])`);
        try {
          this.readDb?.close();
        } catch {
        }
        this.readDb = null;
        this._openReadDb();
      } catch {
      }
    }
    this.clearHistoryOutputs();
    const rebuiltCandidates = this.rebuildCandidates();
    this.writeContextFile();
    this.syncEmbeddingMetadata({ reason: "switch_embedding_model" });
    return {
      preservedEpisodes,
      rebuiltCandidates,
      historyCleared: true,
      targetModel: options.newModel ?? getEmbeddingModelId()
    };
  }
  clearHistoryOutputs() {
    ensureDir(this.historyDir);
    const directFiles = ["context.md", "identity.md", "ongoing.md", "lifetime.md", "interests.json"];
    for (const name of directFiles) {
      try {
        rmSync(join3(this.historyDir, name), { force: true });
      } catch {
      }
    }
    for (const dir of ["daily", "weekly", "monthly", "yearly"]) {
      try {
        rmSync(join3(this.historyDir, dir), { recursive: true, force: true });
      } catch {
      }
    }
  }
  init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
    `);
    const ftsToMigrate = ["episodes_fts", "facts_fts", "tasks_fts", "signals_fts"];
    for (const table of ftsToMigrate) {
      try {
        const info = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table);
        if (info?.sql && !info.sql.includes("trigram")) {
          this.db.exec(`DROP TABLE IF EXISTS ${table}`);
        }
      } catch {
      }
    }
    this.db.exec(`

      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        day_key TEXT NOT NULL,
        backend TEXT NOT NULL DEFAULT 'trib-memory',
        channel_id TEXT,
        user_id TEXT,
        user_name TEXT,
        session_id TEXT,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source_ref TEXT UNIQUE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      DROP INDEX IF EXISTS idx_episodes_source_ref;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_source_ref ON episodes(source_ref);
      CREATE INDEX IF NOT EXISTS idx_episodes_day ON episodes(day_key, ts);
      CREATE INDEX IF NOT EXISTS idx_episodes_role ON episodes(role, ts);

      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts
        USING fts5(content, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS memory_candidates (
        id INTEGER PRIMARY KEY,
        episode_id INTEGER NOT NULL,
        ts TEXT NOT NULL,
        day_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_day ON memory_candidates(day_key, status, score DESC);

      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        doc_key TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(kind, doc_key)
      );

      CREATE TABLE IF NOT EXISTS classifications (
        id INTEGER PRIMARY KEY,
        episode_id INTEGER NOT NULL UNIQUE,
        ts TEXT NOT NULL,
        day_key TEXT NOT NULL,
        classification TEXT NOT NULL,
        topic TEXT NOT NULL,
        element TEXT NOT NULL,
        state TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active',
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        last_retrieved_at TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_classifications_day ON classifications(day_key, status, updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS classifications_fts
        USING fts5(classification, topic, element, state, tokenize='trigram');
    `);
    try {
      this.db.exec(`ALTER TABLE classifications ADD COLUMN importance TEXT DEFAULT ''`);
    } catch {
    }
    try {
      this.db.exec(`ALTER TABLE classifications ADD COLUMN chunks TEXT DEFAULT '[]'`);
    } catch {
    }
    this.db.exec(`

      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_embeds (
        id INTEGER PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(entity_type, entity_id)
      );

      CREATE TABLE IF NOT EXISTS memory_vectors (
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        content_hash TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY(entity_type, entity_id, model)
      );

      CREATE TABLE IF NOT EXISTS memory_chunks (
        id INTEGER PRIMARY KEY,
        episode_id INTEGER NOT NULL,
        classification_id INTEGER,
        content TEXT NOT NULL,
        topic TEXT,
        importance TEXT,
        seq INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_episode ON memory_chunks(episode_id, status);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts
        USING fts5(content, topic, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS core_memory (
        id INTEGER PRIMARY KEY,
        classification_id INTEGER NOT NULL UNIQUE,
        topic TEXT NOT NULL,
        element TEXT NOT NULL,
        importance TEXT,
        final_score REAL NOT NULL DEFAULT 0,
        promoted_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'demoted')),
        FOREIGN KEY(classification_id) REFERENCES classifications(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_core_memory_status ON core_memory(status, final_score DESC);
      CREATE INDEX IF NOT EXISTS idx_core_memory_cls ON core_memory(classification_id);

      CREATE TABLE IF NOT EXISTS classification_stats (
        classification_id INTEGER NOT NULL UNIQUE,
        mention_count INTEGER NOT NULL DEFAULT 0,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        last_seen TEXT,
        FOREIGN KEY(classification_id) REFERENCES classifications(id) ON DELETE CASCADE
      );
    `);
    try {
      this.db.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TABLE IF EXISTS task_events;
        DROP TABLE IF EXISTS interests;
        DROP TABLE IF EXISTS entity_links;
        DROP TABLE IF EXISTS relations;
        DROP TABLE IF EXISTS entities;
        DROP TABLE IF EXISTS propositions_fts;
        DROP TABLE IF EXISTS signals_fts;
        DROP TABLE IF EXISTS tasks_fts;
        DROP TABLE IF EXISTS facts_fts;
        DROP TABLE IF EXISTS propositions;
        DROP TABLE IF EXISTS signals;
        DROP TABLE IF EXISTS tasks;
        DROP TABLE IF EXISTS facts;
        DROP TABLE IF EXISTS profiles;
        PRAGMA foreign_keys = ON;
      `);
      this.db.prepare(`
        DELETE FROM memory_vectors
        WHERE entity_type NOT IN ('classification', 'episode')
      `).run();
      this.db.prepare(`
        DELETE FROM pending_embeds
        WHERE entity_type NOT IN ('classification', 'episode')
      `).run();
    } catch (error) {
      logIgnoredError("legacy schema cleanup", error);
    }
    try {
      this.db.exec(`ALTER TABLE memory_vectors ADD COLUMN content_hash TEXT;`);
    } catch {
    }
    this.insertEpisodeStmt = this.db.prepare(`
      INSERT OR IGNORE INTO episodes (
        ts, day_key, backend, channel_id, user_id, user_name, session_id,
        role, kind, content, source_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertEpisodeFtsStmt = this.db.prepare(`
      INSERT INTO episodes_fts(rowid, content) VALUES (?, ?)
    `);
    this.getEpisodeBySourceStmt = this.db.prepare(`
      SELECT id FROM episodes WHERE source_ref = ?
    `);
    this.insertCandidateStmt = this.db.prepare(`
      INSERT INTO memory_candidates (episode_id, ts, day_key, role, content, score)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.upsertClassificationStmt = this.db.prepare(`
      INSERT INTO classifications (episode_id, ts, day_key, classification, topic, element, state, importance, chunks, confidence, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', unixepoch())
      ON CONFLICT(episode_id) DO UPDATE SET
        ts = excluded.ts,
        day_key = excluded.day_key,
        classification = excluded.classification,
        topic = excluded.topic,
        element = excluded.element,
        state = excluded.state,
        importance = excluded.importance,
        chunks = excluded.chunks,
        confidence = MAX(classifications.confidence, excluded.confidence),
        status = 'active',
        updated_at = unixepoch()
    `);
    this.getClassificationByEpisodeStmt = this.db.prepare(`
      SELECT id
      FROM classifications
      WHERE episode_id = ?
    `);
    this.deleteClassificationFtsStmt = this.db.prepare(`DELETE FROM classifications_fts WHERE rowid = ?`);
    this.insertClassificationFtsStmt = this.db.prepare(`
      INSERT INTO classifications_fts(rowid, classification, topic, element, state)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.bumpClassificationRetrievalStmt = this.db.prepare(`
      UPDATE classifications
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `);
    this.clearCandidatesStmt = this.db.prepare(`DELETE FROM memory_candidates`);
    this.clearClassificationsStmt = this.db.prepare(`DELETE FROM classifications`);
    this.clearClassificationsFtsStmt = this.db.prepare(`DELETE FROM classifications_fts`);
    this.clearVectorsStmt = this.db.prepare(`DELETE FROM memory_vectors`);
    this.getMetaStmt = this.db.prepare(`SELECT value FROM memory_meta WHERE key = ?`);
    this.upsertMetaStmt = this.db.prepare(`
      INSERT INTO memory_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.hasVectorModelStmt = this.db.prepare(`
      SELECT 1 AS ok
      FROM memory_vectors
      WHERE model = ?
      LIMIT 1
    `);
    this.upsertVectorStmt = this.db.prepare(`
      INSERT INTO memory_vectors (entity_type, entity_id, model, dims, vector_json, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(entity_type, entity_id, model) DO UPDATE SET
        dims = excluded.dims,
        vector_json = excluded.vector_json,
        content_hash = excluded.content_hash,
        updated_at = unixepoch()
    `);
    this.getVectorStmt = this.db.prepare(`
      SELECT entity_type, entity_id, model, dims, vector_json, content_hash
      FROM memory_vectors
      WHERE entity_type = ? AND entity_id = ? AND model = ?
    `);
    this.listDenseClassificationRowsStmt = this.db.prepare(`
      SELECT 'classification' AS type, c.classification AS subtype, c.id AS entity_id,
             trim(c.element || ' | ' || c.topic || CASE WHEN c.importance IS NOT NULL AND c.importance != '' THEN ' | ' || c.importance ELSE '' END || CASE WHEN c.state IS NOT NULL AND c.state != '' THEN ' | ' || c.state ELSE '' END) AS content,
             c.updated_at AS updated_at, c.retrieval_count AS retrieval_count,
             c.confidence AS quality_score, c.importance AS importance,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN classifications c ON c.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = c.episode_id
      WHERE mv.entity_type = 'classification'
        AND mv.model = ?
        AND c.status = 'active'
    `);
    this.listDenseEpisodeRowsStmt = this.db.prepare(`
      SELECT 'episode' AS type, e.role AS subtype, e.id AS entity_id, e.content AS content,
             e.created_at AS updated_at, 0 AS retrieval_count,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN episodes e ON e.id = mv.entity_id
      WHERE mv.entity_type = 'episode'
        AND mv.model = ?
        AND e.kind IN (${RECALL_EPISODE_KIND_SQL2})
    `);
  }
  getMetaValue(key, fallback = null) {
    const row = this.getMetaStmt.get(key);
    return row?.value ?? fallback;
  }
  getRetrievalTuning() {
    const configPath = join3(this.dataDir, "config.json");
    try {
      const mtimeMs = statSync(configPath).mtimeMs;
      if (this._retrievalTuningCache?.mtimeMs === mtimeMs) return this._retrievalTuningCache.value;
      const raw = JSON.parse(readFileSync(configPath, "utf8"));
      const value = mergeMemoryTuning(raw?.retrieval ?? {});
      const featureFlags2 = readMemoryFeatureFlags(raw);
      value.reranker.enabled = featureFlags2.reranker;
      this._retrievalTuningCache = { mtimeMs, value };
      return value;
    } catch {
      if (this._retrievalTuningCache?.value) return this._retrievalTuningCache.value;
      const value = mergeMemoryTuning();
      this._retrievalTuningCache = { mtimeMs: 0, value };
      return value;
    }
  }
  setMetaValue(key, value) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    this.upsertMetaStmt.run(key, serialized);
  }
  syncEmbeddingMetadata(extra = {}) {
    this.setMetaValue("embedding.current_model", getEmbeddingModelId());
    this.setMetaValue("embedding.current_dims", String(getEmbeddingDims()));
    this.setMetaValue("embedding.index_version", "2");
    this.setMetaValue("embedding.updated_at", localNow());
    if (extra.vectorModel) this.setMetaValue("embedding.vector_model", extra.vectorModel);
    if (extra.vectorDims) this.setMetaValue("embedding.vector_dims", String(extra.vectorDims));
    if (extra.reason) this.setMetaValue("embedding.last_reason", extra.reason);
    if (extra.reindexRequired != null) this.setMetaValue("embedding.reindex_required", extra.reindexRequired ? "1" : "0");
    if (extra.reindexReason) this.setMetaValue("embedding.reindex_reason", extra.reindexReason);
    if (extra.reindexCompleted) {
      this.setMetaValue("embedding.reindex_required", "0");
      this.setMetaValue("embedding.reindex_reason", "");
    }
  }
  noteVectorWrite(model, dims) {
    const switchEvent = consumeProviderSwitchEvent();
    this.syncEmbeddingMetadata({
      vectorModel: model,
      vectorDims: dims,
      reason: switchEvent ? `vector_write_after_${switchEvent.phase}_switch` : "vector_write",
      reindexRequired: switchEvent ? 1 : 0,
      reindexReason: switchEvent ? `${switchEvent.previousModelId} -> ${switchEvent.currentModelId} (${switchEvent.phase}: ${switchEvent.reason})` : ""
    });
  }
  /**
   * Retrieve a stored vector from memory_vectors, or compute and store it.
   * @param {string} entityType - 'fact', 'task', 'signal', 'episode'
   * @param {number} entityId - row id
   * @param {string} text - text to embed if no stored vector found
   * @returns {number[]} embedding vector
   */
  async getStoredVector(entityType, entityId, text) {
    const lookupModel = getEmbeddingModelId();
    const existing = this.getVectorStmt.get(entityType, entityId, lookupModel);
    if (existing?.vector_json) {
      try {
        const parsed = JSON.parse(existing.vector_json);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {
      }
    }
    const vector = await embedText(String(text).slice(0, 768));
    if (Array.isArray(vector) && vector.length > 0) {
      const activeModel = getEmbeddingModelId();
      const contentHash = hashEmbeddingInput(text);
      this.upsertVectorStmt.run(entityType, entityId, activeModel, vector.length, JSON.stringify(vector), contentHash);
      this._syncToVecTable(entityType, entityId, vector);
      this.noteVectorWrite(activeModel, vector.length);
    }
    return vector;
  }
  appendEpisode(entry) {
    const clean = cleanMemoryText(entry.content);
    if (!clean) return null;
    const ts = entry.ts || localNow();
    const dayKey = localDateStr(new Date(ts));
    const sourceRef = entry.sourceRef || null;
    const episodeKind = entry.kind || "message";
    this.insertEpisodeStmt.run(
      ts,
      dayKey,
      entry.backend || "trib-memory",
      entry.channelId || null,
      entry.userId || null,
      entry.userName || null,
      entry.sessionId || null,
      entry.role,
      episodeKind,
      clean,
      sourceRef
    );
    const episodeId = sourceRef ? this.getEpisodeBySourceStmt.get(sourceRef)?.id : null;
    const finalEpisodeId = episodeId ?? this.db.prepare("SELECT last_insert_rowid() AS id").get().id;
    if (finalEpisodeId) {
      if (episodeKind === "message" || episodeKind === "turn") {
        try {
          this.insertEpisodeFtsStmt.run(finalEpisodeId, clean);
        } catch {
        }
      }
      const shouldCandidate = entry.role === "user" && episodeKind === "message" || entry.role === "assistant" && episodeKind === "message";
      if (shouldCandidate) {
        insertCandidateUnits(this.insertCandidateStmt, finalEpisodeId, ts, dayKey, entry.role, clean);
      }
    }
    return finalEpisodeId ?? null;
  }
  _embedEpisodeAsync(episodeId, content) {
    const lookupModel = getEmbeddingModelId();
    const contentHash = hashEmbeddingInput(content);
    const existing = this.getVectorStmt.get("episode", episodeId, lookupModel);
    if (existing?.content_hash === contentHash) return;
    try {
      this.db.prepare("INSERT OR IGNORE INTO pending_embeds (entity_type, entity_id, content) VALUES (?, ?, ?)").run("episode", episodeId, content.slice(0, 768));
    } catch {
    }
    const task = async () => {
      const vector = await embedText(content.slice(0, 768));
      if (!Array.isArray(vector) || vector.length === 0) return;
      const activeModel = getEmbeddingModelId();
      this.upsertVectorStmt.run("episode", episodeId, activeModel, vector.length, JSON.stringify(vector), contentHash);
      this._syncToVecTable("episode", episodeId, vector);
      this.noteVectorWrite(activeModel, vector.length);
      try {
        this.db.prepare("DELETE FROM pending_embeds WHERE entity_type = ? AND entity_id = ?").run("episode", episodeId);
      } catch {
      }
    };
    if (!this._embedQueue) this._embedQueue = Promise.resolve();
    this._embedQueue = this._embedQueue.then(task).catch(() => {
    });
  }
  async processPendingEmbeds() {
    const batchSize = Number(this.getMetaValue("embedding.batchSize")) || 20;
    const pending = this.db.prepare("SELECT entity_type, entity_id, content FROM pending_embeds ORDER BY id LIMIT ?").all(batchSize);
    if (pending.length === 0) return 0;
    let processed = 0;
    for (const item of pending) {
      const vector = await embedText(item.content.slice(0, 768));
      if (!Array.isArray(vector) || vector.length === 0) continue;
      const activeModel = getEmbeddingModelId();
      const contentHash = hashEmbeddingInput(item.content);
      this.upsertVectorStmt.run(item.entity_type, item.entity_id, activeModel, vector.length, JSON.stringify(vector), contentHash);
      this._syncToVecTable(item.entity_type, item.entity_id, vector);
      this.noteVectorWrite(activeModel, vector.length);
      this.db.prepare("DELETE FROM pending_embeds WHERE entity_type = ? AND entity_id = ?").run(item.entity_type, item.entity_id);
      processed += 1;
    }
    if (processed > 0) process.stderr.write(`[memory] recovered ${processed} pending embeds
`);
    return processed;
  }
  ingestTranscriptFile(transcriptPath) {
    if (!existsSync(transcriptPath)) return 0;
    const prev = this._transcriptOffsets.get(transcriptPath) ?? { bytes: 0, lineIndex: 0 };
    let fd = null;
    let lines;
    try {
      const stat = statSync(transcriptPath);
      if (stat.size < prev.bytes) {
        prev.bytes = 0;
        prev.lineIndex = 0;
      }
      if (stat.size <= prev.bytes) return 0;
      fd = openSync(transcriptPath, "r");
      const buf = Buffer.alloc(stat.size - prev.bytes);
      readSync(fd, buf, 0, buf.length, prev.bytes);
      prev.bytes = stat.size;
      lines = buf.toString("utf8").split("\n").filter(Boolean);
    } catch {
      return 0;
    } finally {
      if (fd != null) closeSync(fd);
    }
    let count = 0;
    let index = prev.lineIndex;
    for (const line of lines) {
      index += 1;
      try {
        const parsed = JSON.parse(line);
        const role = parsed.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = firstTextContent(parsed.message?.content);
        if (!text.trim()) continue;
        const clean = cleanMemoryText(text);
        if (!clean || clean.includes("[Request interrupted by user]")) continue;
        if (isTranscriptQuarantineContent(clean)) continue;
        const rawTs = parsed.timestamp ?? parsed.ts ?? null;
        const ts = rawTs ? toLocalTs(rawTs) : localNow();
        const sourceRef = `transcript:${resolve(transcriptPath)}:${index}:${role}`;
        const id = this.appendEpisode({
          ts,
          backend: "claude-session",
          channelId: null,
          userId: role === "user" ? "session:user" : "session:assistant",
          userName: role,
          sessionId: null,
          role,
          kind: "message",
          content: clean,
          sourceRef
        });
        if (id) count += 1;
      } catch {
      }
    }
    prev.lineIndex = index;
    this._transcriptOffsets.set(transcriptPath, prev);
    return count;
  }
  ingestTranscriptFiles(paths) {
    let total = 0;
    for (const filePath of paths) {
      total += this.ingestTranscriptFile(filePath);
    }
    return total;
  }
  getEpisodesForDate(dayKey, options = {}) {
    const includeTranscripts = Boolean(options.includeTranscripts);
    return this.db.prepare(`
      SELECT id, ts, role, content
      FROM episodes
      WHERE day_key = ?
        AND kind IN (${includeTranscripts ? DEBUG_RECALL_EPISODE_KIND_SQL2 : RECALL_EPISODE_KIND_SQL2})
      ORDER BY ts, id
    `).all(dayKey);
  }
  getEpisodeDayKey(episodeId) {
    return this.db.prepare(`
      SELECT day_key
      FROM episodes
      WHERE id = ?
    `).get(episodeId)?.day_key ?? null;
  }
  async getEpisodeRecallRows(options = {}) {
    return getEpisodeRecallRows(this, options);
  }
  getRecallShortcutRows(kind = "all", limit = 5, options = {}) {
    return getRecallShortcutRows(this, kind, limit, options);
  }
  async applyMetadataFilters(rows = [], filters = {}) {
    return applyMetadataFilters(this, rows, filters);
  }
  getEpisodesSince(timestamp) {
    return getEpisodesSince(this, timestamp);
  }
  countEpisodes() {
    return countEpisodes(this);
  }
  getCandidatesForDate(dayKey) {
    return getCandidatesForDate(this, dayKey);
  }
  getPendingCandidateDays(limit = 7, minCount = 1) {
    return getPendingCandidateDays(this, limit, minCount);
  }
  getDecayRows(kind = "fact") {
    return getDecayRows(this, kind);
  }
  resetEmbeddingIndex(options = {}) {
    return resetEmbeddingIndex(this, options);
  }
  vacuumDatabase() {
    return vacuumDatabase(this);
  }
  getRecentCandidateDays(limit = 7) {
    return getRecentCandidateDays(this, limit);
  }
  countPendingCandidates(dayKey = null) {
    return countPendingCandidates(this, dayKey);
  }
  rebuildCandidates() {
    return rebuildCandidates(this);
  }
  resetConsolidatedMemory() {
    return resetConsolidatedMemory(this);
  }
  resetConsolidatedMemoryForDays(dayKeys = []) {
    return resetConsolidatedMemoryForDays(this, dayKeys);
  }
  pruneConsolidatedMemoryOutsideDays(dayKeys = []) {
    return pruneConsolidatedMemoryOutsideDays(this, dayKeys);
  }
  markCandidateIdsConsolidated(candidateIds = []) {
    return markCandidateIdsConsolidated(this, candidateIds);
  }
  markCandidatesConsolidated(dayKey) {
    return markCandidatesConsolidated(this, dayKey);
  }
  upsertDocument(kind, docKey, content) {
    const clean = cleanMemoryText(content);
    if (!clean) return;
    this.db.prepare(`
      INSERT INTO documents (kind, doc_key, content, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(kind, doc_key) DO UPDATE SET
        content = excluded.content,
        updated_at = unixepoch()
    `).run(kind, docKey, clean);
  }
  upsertClassifications(rows = [], seenAt = null, sourceEpisodeId = null) {
    const ts = seenAt || localNow();
    const dayKey = localDateStr(new Date(ts));
    for (const row of rows) {
      const episodeId = Number(row?.episode_id ?? sourceEpisodeId ?? 0);
      if (!Number.isFinite(episodeId) || episodeId <= 0) continue;
      const classification = cleanMemoryText(row?.classification);
      const topic = cleanMemoryText(row?.topic);
      const element = cleanMemoryText(row?.element);
      const state = cleanMemoryText(row?.state);
      const importance = String(row?.importance ?? "").trim() || null;
      const chunks = JSON.stringify(Array.isArray(row?.chunks) ? row.chunks : []);
      const confidence = Number(row?.confidence ?? 0.6);
      if (!classification || !topic || !element) continue;
      this.upsertClassificationStmt.run(
        episodeId,
        ts,
        dayKey,
        classification,
        topic,
        element,
        state || null,
        importance,
        chunks,
        confidence
      );
      const id = this.getClassificationByEpisodeStmt.get(episodeId)?.id;
      if (!id) continue;
      try {
        this.deleteClassificationFtsStmt.run(id);
      } catch {
      }
      try {
        this.insertClassificationFtsStmt.run(
          id,
          classification,
          topic,
          element,
          state || ""
        );
      } catch {
      }
    }
  }
  getClassificationRows(limit = 12) {
    return this.db.prepare(`
      SELECT c.id, c.episode_id, c.classification, c.topic, c.element, c.state,
             c.confidence, c.day_key, c.ts, c.updated_at, c.retrieval_count,
             e.content AS episode_content
      FROM classifications c
      LEFT JOIN episodes e ON e.id = c.episode_id
      WHERE c.status = 'active'
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT ?
    `).all(Math.max(1, Number(limit ?? 12)));
  }
  syncHistoryFromFiles() {
    ensureDir(this.historyDir);
  }
  backfillProject(workspacePath, options = {}) {
    const limit = Number(options.limit ?? 50);
    const sinceMs = Number.isFinite(Number(options.sinceMs)) ? Number(options.sinceMs) : null;
    const projectDir = join3(homedir(), ".claude", "projects", workspaceToProjectSlug(workspacePath));
    if (!existsSync(projectDir)) return this.backfillAllProjects(options);
    const files = readdirSync(projectDir).filter((file) => file.endsWith(".jsonl") && !file.startsWith("agent-")).map((file) => ({
      path: join3(projectDir, file),
      mtime: statSync(join3(projectDir, file)).mtimeMs
    })).filter((item) => !sinceMs || item.mtime >= sinceMs).sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((item) => item.path).reverse();
    return this.ingestTranscriptFiles(files);
  }
  /**
   * Scan all project dirs under ~/.claude/projects/ for transcripts.
   * No slug-to-path conversion needed — reads directories directly.
   * Works on macOS, Windows, and WSL without path format issues.
   */
  backfillAllProjects(options = {}) {
    const limit = Number(options.limit ?? 50);
    const sinceMs = Number.isFinite(Number(options.sinceMs)) ? Number(options.sinceMs) : null;
    const projectsRoot = join3(homedir(), ".claude", "projects");
    if (!existsSync(projectsRoot)) return 0;
    const allFiles = [];
    try {
      for (const d of readdirSync(projectsRoot)) {
        if (d.includes("tmp") || d.includes("cache") || d.includes("plugins")) continue;
        const full = join3(projectsRoot, d);
        try {
          for (const f of readdirSync(full)) {
            if (!f.endsWith(".jsonl") || f.startsWith("agent-")) continue;
            const fp = join3(full, f);
            const mtime = statSync(fp).mtimeMs;
            if (sinceMs && mtime < sinceMs) continue;
            allFiles.push({ path: fp, mtime });
          }
        } catch {
        }
      }
    } catch {
      return 0;
    }
    allFiles.sort((a, b) => b.mtime - a.mtime);
    const selected = allFiles.slice(0, limit).reverse().map((f) => f.path);
    return this.ingestTranscriptFiles(selected);
  }
  buildContextText() {
    const parts = [];
    const allClassifications = this.db.prepare(`
      SELECT id, classification, topic, element, state, importance
      FROM classifications
      WHERE status = 'active' AND importance IS NOT NULL AND importance != ''
      ORDER BY updated_at DESC
    `).all();
    const promoted = allClassifications.filter((row) => getTagFactor(row.importance) <= 0.2);
    if (promoted.length > 0) {
      const lines = promoted.map((row) => {
        const tag = String(row.importance || "").split(",")[0].trim();
        return `- [${tag}] ${row.topic} \u2014 ${row.element}`;
      });
      parts.push(`## Core Memory
${lines.join("\n")}`);
    }
    return parts.join("\n\n").trim();
  }
  writeContextFile() {
    const contextPath = join3(this.historyDir, "context.md");
    ensureDir(this.historyDir);
    const content = this.buildContextText();
    writeFileSync(contextPath, `<!-- Auto-generated by memory store -->

${content}
`);
    return contextPath;
  }
  syncChunksFromClassifications() {
    const rows = this.db.prepare(`
      SELECT id, episode_id, topic, importance, chunks
      FROM classifications
      WHERE chunks IS NOT NULL AND chunks != '[]' AND status = 'active'
    `).all();
    let synced = 0;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO memory_chunks (episode_id, classification_id, content, topic, importance, seq)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      let chunks;
      try {
        chunks = JSON.parse(row.chunks);
      } catch {
        continue;
      }
      if (!Array.isArray(chunks) || chunks.length === 0) continue;
      const existing = this.db.prepare("SELECT COUNT(*) as cnt FROM memory_chunks WHERE episode_id = ?").get(row.episode_id);
      if (existing?.cnt > 0) continue;
      for (let seq = 0; seq < chunks.length; seq++) {
        const text = String(chunks[seq]).trim();
        if (!text) continue;
        insert.run(row.episode_id, row.id, text, row.topic || "", row.importance || "", seq);
        const chunkId = this.db.prepare("SELECT last_insert_rowid() as id").get().id;
        try {
          this.db.prepare("INSERT INTO memory_chunks_fts(rowid, content, topic) VALUES (?, ?, ?)").run(chunkId, text, row.topic || "");
        } catch {
        }
        synced++;
      }
    }
    const missingFts = this.db.prepare(`
      SELECT mc.id, mc.content, mc.topic FROM memory_chunks mc
      WHERE mc.id NOT IN (SELECT rowid FROM memory_chunks_fts)
    `).all();
    for (const mc of missingFts) {
      try {
        this.db.prepare("INSERT INTO memory_chunks_fts(rowid, content, topic) VALUES (?, ?, ?)").run(mc.id, mc.content, mc.topic || "");
        synced++;
      } catch {
      }
    }
    return synced;
  }
  writeRecentFile(options = {}) {
    try {
      ensureDir(this.historyDir);
      const serverStartedAt2 = options.serverStartedAt;
      let lines = [];
      const timeFilter = serverStartedAt2 ? "AND e.ts < ?" : "";
      const timeParams = serverStartedAt2 ? [serverStartedAt2] : [];
      const chunkRows = this.db.prepare(`
        SELECT mc.topic, mc.content, mc.importance
        FROM memory_chunks mc
        JOIN episodes e ON e.id = mc.episode_id
        WHERE mc.status = 'active'
          ${timeFilter}
        ORDER BY e.ts DESC, mc.seq ASC
        LIMIT 10
      `).all(...timeParams);
      if (chunkRows.length > 0) {
        lines = chunkRows.map((r) => {
          const prefix = r.topic ? `${r.topic}: ` : "";
          return `- ${prefix}${r.content}`;
        });
      } else {
        const episodeSql = `
          SELECT role, content FROM episodes
          WHERE kind = 'message'
            AND role IN ('user', 'assistant')
            AND content NOT LIKE 'You are%'
            AND LENGTH(content) >= 5
            ${timeFilter}
          ORDER BY ts DESC, id DESC
          LIMIT 10
        `;
        const recentEpisodes = this.db.prepare(episodeSql).all(...timeParams).reverse();
        lines = recentEpisodes.map((r) => `${r.role === "user" ? "u" : "a"}: ${r.content}`);
      }
      const text = lines.length > 0 ? `## Recent
${lines.join("\n")}
` : "";
      writeFileSync(join3(this.historyDir, "recent.md"), text, "utf8");
    } catch {
    }
  }
  appendRetrievalTrace(record = {}) {
    try {
      ensureDir(this.historyDir);
      const tracePath = join3(this.historyDir, "retrieval-trace.jsonl");
      appendFileSync(tracePath, `${JSON.stringify(record)}
`, "utf8");
    } catch (error) {
      logIgnoredError("appendRetrievalTrace", error);
    }
  }
  async warmupEmbeddings() {
    await warmupEmbeddingProvider();
  }
  getEmbeddableItems(options = {}) {
    const perTypeLimit = options.all ? 1e9 : Math.max(1, Number(options.perTypeLimit ?? 128));
    const items = [];
    const classificationRows = this.db.prepare(`
      SELECT id, classification, topic, element, importance, state
      FROM classifications
      WHERE status = 'active'
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(Math.max(8, Math.floor(perTypeLimit / 2)));
    for (const row of classificationRows) {
      items.push({
        key: embeddingItemKey("classification", row.id),
        entityType: "classification",
        entityId: row.id,
        subtype: row.classification,
        content: [row.element, row.topic, row.importance, row.state].filter(Boolean).join(" | ")
      });
    }
    const episodeLimit = Math.max(8, Math.floor(perTypeLimit / 2));
    const maxAgeDays = options.maxAgeDays ?? null;
    const ageFilter = maxAgeDays ? `AND ts >= datetime('now', '-${Number(maxAgeDays)} days')` : "";
    const episodeRows = this.db.prepare(`
      SELECT id, role AS subtype, day_key AS ref, content
      FROM episodes
      WHERE kind IN (${RECALL_EPISODE_KIND_SQL2})
        AND LENGTH(content) BETWEEN 10 AND 1500
        AND content NOT LIKE 'You are consolidating%'
        AND content NOT LIKE 'You are improving%'
        AND content NOT LIKE 'Answer using live%'
        AND content NOT LIKE 'Use the ai_search%'
        AND content NOT LIKE 'Say only%'
        ${ageFilter}
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `).all(episodeLimit);
    for (const row of episodeRows) {
      const cls = this.db.prepare("SELECT element FROM classifications WHERE episode_id = ?").get(row.id);
      const prefix = cls?.element ? cls.element + " | " : "";
      items.push({
        key: embeddingItemKey("episode", row.id),
        entityType: "episode",
        entityId: row.id,
        subtype: row.subtype,
        ref: row.ref,
        content: prefix + row.content
      });
    }
    try {
      const chunkRows = this.db.prepare(`
        SELECT id, content, topic FROM memory_chunks WHERE status = 'active'
        ORDER BY created_at DESC LIMIT ?
      `).all(perTypeLimit);
      for (const row of chunkRows) {
        const chunkContent = row.topic ? `${row.topic} | ${row.content}` : row.content;
        items.push({
          key: embeddingItemKey("chunk", row.id),
          entityType: "chunk",
          entityId: row.id,
          subtype: "chunk",
          content: chunkContent
        });
      }
    } catch {
    }
    try {
      const coreLimit = Math.max(8, Math.floor(perTypeLimit / 4));
      const coreRows = this.db.prepare(`
        SELECT id, topic, element, importance FROM core_memory
        WHERE status = 'active'
        ORDER BY final_score DESC, id DESC
        LIMIT ?
      `).all(coreLimit);
      for (const row of coreRows) {
        items.push({
          key: embeddingItemKey("core_memory", row.id),
          entityType: "core_memory",
          entityId: row.id,
          subtype: row.importance || "fact",
          content: [row.element, row.topic, row.importance].filter(Boolean).join(" | ")
        });
      }
    } catch {
    }
    return items;
  }
  async ensureEmbeddings(options = {}) {
    const candidates = this.getEmbeddableItems(options);
    const contextMap = options.contextMap instanceof Map ? options.contextMap : /* @__PURE__ */ new Map();
    let contextualizeLocal = true;
    try {
      const cfg = JSON.parse(readFileSync(join3(this.dataDir, "config.json"), "utf8"));
      if (cfg?.embedding?.contextualize === false) contextualizeLocal = false;
    } catch {
    }
    let updated = 0;
    for (const item of candidates) {
      const lookupModel = getEmbeddingModelId();
      const contextText = contextMap.get(item.key);
      let embedInput;
      if (contextText) {
        embedInput = cleanMemoryText(`${contextText}
${item.content}`);
      } else if (contextualizeLocal) {
        embedInput = contextualizeEmbeddingInput(item);
      } else {
        embedInput = cleanMemoryText(item.content ?? "");
      }
      if (!embedInput) continue;
      const contentHash = hashEmbeddingInput(embedInput);
      const existing = this.getVectorStmt.get(item.entityType, item.entityId, lookupModel);
      if (existing?.content_hash === contentHash) continue;
      const vector = await embedText(embedInput);
      if (!Array.isArray(vector) || vector.length === 0) continue;
      const activeModel = getEmbeddingModelId();
      this.upsertVectorStmt.run(
        item.entityType,
        item.entityId,
        activeModel,
        vector.length,
        JSON.stringify(vector),
        contentHash
      );
      this._syncToVecTable(item.entityType, item.entityId, vector);
      this.noteVectorWrite(activeModel, vector.length);
      updated += 1;
    }
    this._pruneOldEpisodeVectors();
    return updated;
  }
  _syncToVecTable(entityType, entityId, vector) {
    if (!this.vecEnabled) return;
    const rowid = this._vecRowId(entityType, entityId);
    try {
      const hex = vecToHex(vector);
      this.db.exec(`INSERT OR REPLACE INTO vec_memory(rowid, embedding) VALUES (${rowid}, X'${hex}')`);
    } catch {
    }
  }
  _vecRowId(entityType, entityId) {
    const typePrefix = { fact: 1, task: 2, signal: 3, episode: 4, proposition: 5, entity: 6, relation: 7, classification: 8, chunk: 9 };
    return (typePrefix[entityType] ?? 9) * 1e8 + Number(entityId);
  }
  _vecRowToEntity(rowid) {
    const typeMap = { 1: "fact", 2: "task", 3: "signal", 4: "episode", 5: "proposition", 6: "entity", 7: "relation", 8: "classification", 9: "chunk" };
    const typeNum = Math.floor(rowid / 1e8);
    return { entityType: typeMap[typeNum] ?? "unknown", entityId: rowid % 1e8 };
  }
  _pruneOldEpisodeVectors() {
    try {
      const cutoff = this.db.prepare(`
        SELECT id FROM episodes
        WHERE ts < datetime('now', '-30 days')
          AND id IN (SELECT entity_id FROM memory_vectors WHERE entity_type = 'episode')
      `).all();
      for (const { id } of cutoff) {
        this.db.prepare("DELETE FROM memory_vectors WHERE entity_type = ? AND entity_id = ?").run("episode", id);
        if (this.vecEnabled) {
          const rowid = this._vecRowId("episode", id);
          try {
            this.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`);
          } catch {
          }
        }
      }
      if (cutoff.length > 0) {
        process.stderr.write(`[memory] pruned ${cutoff.length} old episode vectors
`);
      }
    } catch {
    }
  }
  async buildRecentFocusVector(options = {}) {
    const maxEpisodes = Math.max(1, Number(options.maxEpisodes ?? 8));
    const sinceDays = Math.max(1, Number(options.sinceDays ?? 3));
    const channelId = String(options.channelId ?? "").trim();
    const userId = String(options.userId ?? "").trim();
    let rows = [];
    if (channelId) {
      rows = this.db.prepare(`
        SELECT id, content
        FROM episodes
        WHERE role = 'user'
          AND kind = 'message'
          AND channel_id = ?
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(channelId, `-${sinceDays} days`, maxEpisodes);
    }
    if (rows.length === 0 && userId) {
      rows = this.db.prepare(`
        SELECT id, content
        FROM episodes
        WHERE role = 'user'
          AND kind = 'message'
          AND user_id = ?
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(userId, `-${sinceDays} days`, maxEpisodes);
    }
    if (rows.length === 0) {
      rows = this.db.prepare(`
        SELECT id, content
        FROM episodes
        WHERE role = 'user'
          AND kind = 'message'
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(`-${sinceDays} days`, maxEpisodes);
    }
    if (rows.length === 0) return [];
    const vectors = await Promise.all(
      rows.map((row) => this.getStoredVector("episode", row.id, cleanMemoryText(row.content)))
    );
    return averageVectors(vectors);
  }
  async rankIntentSeedItems(rows, query = "", queryVector = null, options = {}) {
    if (!rows.length) return [];
    const vector = query ? queryVector ?? await embedText(query) : null;
    const tokens = new Set(tokenizeMemoryText(query));
    const minSimilarity = Number(options.minSimilarity ?? 0);
    const scored = await Promise.all(rows.map(async (row) => {
      const content = cleanMemoryText(row.content ?? "");
      const contentTokens = tokenizeMemoryText(`${row.subtype ?? ""} ${content}`);
      const overlapCount = contentTokens.reduce((count, token) => count + (tokens.has(token) ? 1 : 0), 0);
      const entityType = row.type ?? "fact";
      const entityId = Number(row.entity_id ?? 0);
      const rowVector = vector && entityId > 0 ? await this.getStoredVector(entityType, entityId, `${row.subtype ?? ""} ${content}`) : vector ? await embedText(String(`${row.subtype ?? ""} ${content}`).slice(0, 768)) : [];
      const semanticSimilarity = vector ? cosineSimilarity(vector, rowVector) : 0;
      return {
        ...row,
        semanticSimilarity,
        overlapCount,
        seedRank: semanticSimilarity * 4 + overlapCount * 2 + Number(row.quality_score ?? 0.5)
      };
    }));
    return scored.filter((item) => item.overlapCount > 0 || item.semanticSimilarity >= minSimilarity || minSimilarity <= 0).sort((a, b) => Number(b.seedRank) - Number(a.seedRank));
  }
  async searchRelevantHybrid(query, limit = 8, options = {}) {
    const clean = cleanMemoryText(query);
    if (!clean) return [];
    const temporal = options.temporal ?? (() => {
      const hint = parseTemporalHint(clean);
      if (!hint) return null;
      return { start: hint.start, end: hint.end ?? hint.start, exact: hint.start === (hint.end ?? hint.start) };
    })();
    const queryVector = options.queryVector ?? await embedText(clean);
    const variants = generateQueryVariants ? generateQueryVariants(clean) : [clean];
    const allQueries = [clean, ...variants.filter((v) => v !== clean)].slice(0, 6);
    let sparse = [];
    {
      const seenSparse = /* @__PURE__ */ new Set();
      for (const q of allQueries) {
        const sr = this.searchRelevantSparse(q, limit * 2);
        for (const r of sr) {
          const key = `${r.type}-${r.entity_id}`;
          if (!seenSparse.has(key)) {
            seenSparse.add(key);
            sparse.push(r);
          }
        }
      }
    }
    let dense = await this.searchRelevantDense(clean, limit * 3, queryVector, null, {});
    if (temporal?.start) {
      const inRange = (ts) => {
        if (!ts) return false;
        const d = String(ts).slice(0, 10);
        return d >= temporal.start && d <= temporal.end;
      };
      const boostInRange = (items) => {
        const inside = items.filter((r) => inRange(r.source_ts));
        const outside = items.filter((r) => !inRange(r.source_ts));
        return [...inside, ...outside];
      };
      sparse = boostInRange(sparse);
      dense = boostInRange(dense);
    }
    const K = 60;
    const sparseRanks = /* @__PURE__ */ new Map();
    const denseRanks = /* @__PURE__ */ new Map();
    sparse.forEach((item, i) => {
      const key = `${item.type}:${item.entity_id}`;
      if (!sparseRanks.has(key)) sparseRanks.set(key, i + 1);
    });
    dense.forEach((item, i) => {
      const key = `${item.type}:${item.entity_id}`;
      if (!denseRanks.has(key)) denseRanks.set(key, i + 1);
    });
    const seen = /* @__PURE__ */ new Map();
    for (const item of [...sparse, ...dense]) {
      const key = `${item.type}:${item.entity_id}`;
      if (seen.has(key)) {
        if (item.vector_json && !seen.get(key).vector_json) {
          seen.get(key).vector_json = item.vector_json;
        }
        continue;
      }
      const sparseRank = sparseRanks.get(key);
      const denseRank = denseRanks.get(key);
      const rrfSparse = sparseRank ? 1 / (K + sparseRank) : 0;
      const rrfDense = denseRank ? 1 / (K + denseRank) : 0;
      const baseScore = rrfSparse + rrfDense;
      seen.set(key, { ...item, keyword_score: rrfSparse, embedding_score: rrfDense, base_score: baseScore });
    }
    const { computeFinalScore: computeFinalScore2, getScoringConfig: getScoringConfig2 } = await Promise.resolve().then(() => (init_memory_score_utils(), memory_score_utils_exports));
    const scoringConfig = getScoringConfig2(options.tuning ?? this.getRetrievalTuning());
    const scored = [];
    for (const [, item] of seen) {
      const finalScore = computeFinalScore2(item.base_score, item, clean, { config: scoringConfig, queryVector });
      scored.push({ ...item, weighted_score: finalScore });
    }
    const IMPORTANCE_KEYWORDS = {
      "\uADDC\uCE59": "rule",
      "\uC815\uCC45": "rule",
      "\uBAA9\uD45C": "goal",
      "\uC694\uCCAD": "directive",
      "\uC9C0\uC2DC": "directive",
      "\uC120\uD638": "preference",
      "\uACB0\uC815": "decision",
      "\uD655\uC815": "decision",
      "\uC0AC\uAC74": "incident",
      "\uC0AC\uACE0": "incident"
    };
    const queryImportance = Object.entries(IMPORTANCE_KEYWORDS).find(([k]) => clean.includes(k))?.[1];
    if (queryImportance) {
      for (const item of scored) {
        if (item.type === "classification" && String(item.importance || "").includes(queryImportance)) {
          item.weighted_score *= 2;
        }
      }
    }
    scored.sort((a, b) => b.weighted_score - a.weighted_score);
    const semanticResults = scored.filter((item) => item.type === "chunk" || item.type === "classification");
    const episodeResults = scored.filter((item) => item.type === "episode");
    const fallbackThreshold = Math.ceil(limit / 2);
    let merged;
    if (semanticResults.length >= fallbackThreshold) {
      const remaining = limit - semanticResults.length;
      merged = [...semanticResults, ...episodeResults.slice(0, Math.max(0, remaining))];
    } else {
      const episodeSlots = limit - semanticResults.length;
      merged = [...semanticResults, ...episodeResults.slice(0, episodeSlots)];
    }
    merged.sort((a, b) => b.weighted_score - a.weighted_score);
    const maxClassifications = Math.min(limit, Math.max(2, Math.ceil(merged.length * 0.3)));
    let classCount = 0;
    const capped = [];
    for (const item of merged) {
      if (item.type === "classification") {
        if (classCount < maxClassifications) {
          capped.push(item);
          classCount++;
        }
      } else {
        capped.push(item);
      }
    }
    const tuning = options.tuning ?? this.getRetrievalTuning();
    const overFetchN = tuning?.reranker?.overFetch ?? 15;
    const overFetchLimit = Math.max(limit, Math.min(limit + overFetchN, capped.length));
    let finalResults = applyMMR(capped.slice(0, overFetchLimit));
    if (!options.skipReranker && tuning.reranker?.enabled && finalResults.length >= 3) {
      try {
        const reranked = await rerank(clean, finalResults.slice(0, overFetchLimit), overFetchLimit);
        if (reranked.length > 0) {
          finalResults = reranked.slice(0, limit);
        }
      } catch {
      }
    } else {
      finalResults = finalResults.slice(0, limit);
    }
    if (options.recordRetrieval !== false) this.recordRetrieval(finalResults);
    if (options.debug) {
      return {
        results: finalResults,
        debug: { sparse: sparse.length, dense: dense.length, scored: scored.length }
      };
    }
    return finalResults;
  }
  searchRelevantSparse(query, limit = 8) {
    const ftsQuery = buildFtsQuery(query);
    const shortTokens = getShortTokensForLike(query);
    if (!ftsQuery && shortTokens.length === 0) return [];
    const results = [];
    const runFts = Boolean(ftsQuery);
    if (runFts) {
      try {
        const classificationHits = this.db.prepare(`
        SELECT 'classification' AS type, c.classification AS subtype, CAST(c.id AS TEXT) AS ref,
               trim(c.element || ' | ' || c.topic || CASE WHEN c.importance IS NOT NULL AND c.importance != '' THEN ' | ' || c.importance ELSE '' END || CASE WHEN c.state IS NOT NULL AND c.state != '' THEN ' | ' || c.state ELSE '' END) AS content,
               bm25(classifications_fts) AS score, c.updated_at AS updated_at, c.id AS entity_id,
               c.confidence AS quality_score, c.importance AS importance, c.retrieval_count AS retrieval_count,
               e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend
        FROM classifications_fts
        JOIN classifications c ON c.id = classifications_fts.rowid
        LEFT JOIN episodes e ON e.id = c.episode_id
        WHERE classifications_fts MATCH ?
          AND c.status = 'active'
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit);
        results.push(...classificationHits);
      } catch (error) {
        logIgnoredError("searchRelevantSparse classifications fts", error);
      }
    }
    if (runFts) {
      try {
        const episodeHits = this.db.prepare(`
        SELECT 'episode' AS type, e.role AS subtype, CAST(e.id AS TEXT) AS ref,
               e.content AS content, bm25(episodes_fts) AS score,
               e.created_at AS updated_at, e.id AS entity_id, 0 AS retrieval_count,
               NULL AS quality_score,
               e.source_ref AS source_ref,
               e.ts AS source_ts,
               e.kind AS source_kind,
               e.backend AS source_backend,
               c.topic AS classification_topic,
               c.element AS classification_element,
               c.chunks AS classification_chunks
        FROM episodes_fts
        JOIN episodes e ON e.id = episodes_fts.rowid
        LEFT JOIN classifications c ON c.episode_id = e.id AND c.status = 'active'
        WHERE episodes_fts MATCH ?
          AND e.kind IN (${RECALL_EPISODE_KIND_SQL2})
          AND e.content NOT LIKE 'You are consolidating%'
          AND e.content NOT LIKE 'You are improving%'
          AND e.content NOT LIKE 'You are analyzing%'
          AND e.content NOT LIKE 'Answer using live%'
          AND e.content NOT LIKE 'Use the ai_search%'
          AND e.content NOT LIKE 'Say only%'
          AND e.content NOT LIKE 'Compress these summaries%'
          AND e.content NOT LIKE 'Summarize the conversation%'
          AND LENGTH(e.content) >= 10
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, Math.min(limit, 6));
        results.push(...episodeHits);
      } catch (error) {
        logIgnoredError("searchRelevantSparse episodes fts", error);
      }
    }
    if (runFts) {
      try {
        const chunkHits = this.db.prepare(`
          SELECT 'chunk' AS type, 'chunk' AS subtype, CAST(mc.id AS TEXT) AS ref,
                 mc.content AS content, bm25(memory_chunks_fts) AS score,
                 mc.created_at AS updated_at, mc.id AS entity_id, 0 AS retrieval_count,
                 NULL AS quality_score, mc.importance AS importance,
                 NULL AS source_ref, e.ts AS source_ts, e.kind AS source_kind, NULL AS source_backend,
                 mc.topic AS classification_topic, mc.content AS classification_element,
                 NULL AS classification_chunks, mc.episode_id AS chunk_episode_id
          FROM memory_chunks_fts
          JOIN memory_chunks mc ON mc.id = memory_chunks_fts.rowid
          LEFT JOIN episodes e ON e.id = mc.episode_id
          WHERE memory_chunks_fts MATCH ?
            AND mc.status = 'active'
          ORDER BY score
          LIMIT ?
        `).all(ftsQuery, Math.min(limit, 6));
        results.push(...chunkHits);
      } catch (error) {
        logIgnoredError("searchRelevantSparse chunks fts", error);
      }
    }
    if (shortTokens.length > 0) {
      const seen = new Set(results.map((r) => `${r.type}:${r.entity_id}`));
      try {
        const likeClassifications = this.db.prepare(`
          SELECT 'classification' AS type, c.classification AS subtype, CAST(c.id AS TEXT) AS ref,
                 trim(c.element || ' | ' || c.topic || CASE WHEN c.importance IS NOT NULL AND c.importance != '' THEN ' | ' || c.importance ELSE '' END || CASE WHEN c.state IS NOT NULL AND c.state != '' THEN ' | ' || c.state ELSE '' END) AS content,
                 0 AS score, c.updated_at AS updated_at, c.id AS entity_id,
                 c.confidence AS quality_score, c.importance AS importance, c.retrieval_count AS retrieval_count,
                 e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend
          FROM classifications c
          LEFT JOIN episodes e ON e.id = c.episode_id
          WHERE c.status = 'active'
            AND (${shortTokens.map(() => "(c.classification LIKE ? OR c.topic LIKE ? OR c.element LIKE ? OR c.state LIKE ?)").join(" OR ")})
          LIMIT ?
        `).all(...shortTokens.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`]), Math.min(limit, 4));
        for (const hit of likeClassifications) {
          if (seen.has(`classification:${hit.entity_id}`)) continue;
          hit.score = shortTokenMatchScore(hit.content, shortTokens);
          results.push(hit);
          seen.add(`classification:${hit.entity_id}`);
        }
      } catch (error) {
        logIgnoredError("searchRelevantSparse classifications like", error);
      }
      try {
        const likeEpisodes = this.db.prepare(`
          SELECT 'episode' AS type, e.role AS subtype, CAST(e.id AS TEXT) AS ref,
                 e.content AS content, 0 AS score, e.created_at AS updated_at, e.id AS entity_id,
                 0 AS quality_score, 0 AS retrieval_count,
                 e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend
          FROM episodes e
          WHERE e.kind IN (${RECALL_EPISODE_KIND_SQL2})
            AND (${shortTokens.map(() => "e.content LIKE ?").join(" OR ")})
          LIMIT ?
        `).all(...shortTokens.map((t) => `%${t}%`), Math.min(limit, 4));
        for (const hit of likeEpisodes) {
          if (seen.has(`episode:${hit.entity_id}`)) continue;
          hit.score = shortTokenMatchScore(hit.content, shortTokens);
          results.push(hit);
          seen.add(`episode:${hit.entity_id}`);
        }
      } catch (error) {
        logIgnoredError("searchRelevantSparse episodes like", error);
      }
    }
    return results;
  }
  async searchRelevantDense(query, limit = 8, queryVector = null, focusVector = null, _options = {}) {
    const clean = cleanMemoryText(query);
    if (!clean) return [];
    const vector = queryVector ?? await embedText(clean);
    if (!Array.isArray(vector) || vector.length === 0) return [];
    const model = getEmbeddingModelId();
    const expectedDims = getEmbeddingDims();
    const vectorModel = this.getMetaValue("embedding.vector_model", "");
    const vectorDims = Number(this.getMetaValue("embedding.vector_dims", "0")) || 0;
    const reindexRequired = this.getMetaValue("embedding.reindex_required", "0") === "1";
    const reindexReason = this.getMetaValue("embedding.reindex_reason", "");
    const hasCurrentModelVectors = Boolean(this.hasVectorModelStmt.get(model)?.ok);
    if (reindexRequired) {
      process.stderr.write(`[memory] dense retrieval disabled: embeddings require reindex (${reindexReason || "provider/model switch"})
`);
      return [];
    }
    if (vectorModel && vectorModel !== model && !hasCurrentModelVectors) {
      process.stderr.write(`[memory] dense retrieval disabled: current model=${model} indexed model=${vectorModel}; rebuild embeddings required
`);
      return [];
    }
    if (expectedDims && vector.length !== expectedDims) {
      process.stderr.write(`[memory] dense retrieval disabled: query vector dims=${vector.length} expected=${expectedDims}
`);
      return [];
    }
    if (vectorDims && vector.length !== vectorDims && hasCurrentModelVectors) {
      process.stderr.write(`[memory] dense retrieval disabled: query vector dims=${vector.length} indexed dims=${vectorDims}
`);
      return [];
    }
    if (this.vecEnabled) {
      try {
        const hex = vecToHex(vector);
        const knnRows = this.vecReadDb.prepare(`
          SELECT rowid, distance FROM vec_memory WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT ?
        `).all(limit * 3);
        const results = [];
        for (const knn of knnRows) {
          const { entityType, entityId } = this._vecRowToEntity(knn.rowid);
          if (entityType !== "classification" && entityType !== "episode" && entityType !== "chunk") continue;
          const meta = this._getEntityMeta(entityType, entityId, model, {});
          if (!meta) continue;
          const similarity = 1 - knn.distance;
          const focusSimilarity = Array.isArray(focusVector) ? (() => {
            try {
              const rv = JSON.parse(meta.vector_json);
              return rv.length === focusVector.length ? cosineSimilarity(focusVector, rv) : 0;
            } catch {
              return 0;
            }
          })() : 0;
          results.push({
            ...meta,
            ref: String(entityId),
            score: -similarity,
            focus_similarity: focusSimilarity
          });
        }
        return results.sort((a, b) => Number(a.score) - Number(b.score)).slice(0, limit);
      } catch (e) {
        process.stderr.write(`[memory] vec KNN failed, falling back: ${e.message}
`);
      }
    }
    const rows = [
      ...this.listDenseClassificationRowsStmt.all(model),
      ...this.listDenseEpisodeRowsStmt.all(model)
    ];
    return rows.map((row) => {
      try {
        const rowVector = JSON.parse(row.vector_json);
        const similarity = cosineSimilarity(vector, rowVector);
        const focusSimilarity = Array.isArray(focusVector) && focusVector.length === rowVector.length ? cosineSimilarity(focusVector, rowVector) : 0;
        return {
          ...row,
          ref: String(row.entity_id),
          score: -similarity,
          focus_similarity: focusSimilarity
        };
      } catch {
        return null;
      }
    }).filter(Boolean).sort((a, b) => Number(a.score) - Number(b.score)).slice(0, limit);
  }
  _getEntityMeta(entityType, entityId, model, _options = {}) {
    try {
      if (entityType === "classification") {
        return this.db.prepare(`
          SELECT 'classification' AS type, c.classification AS subtype, c.id AS entity_id,
                 trim(c.element || ' | ' || c.topic || CASE WHEN c.importance IS NOT NULL AND c.importance != '' THEN ' | ' || c.importance ELSE '' END || CASE WHEN c.state IS NOT NULL AND c.state != '' THEN ' | ' || c.state ELSE '' END) AS content,
                 c.updated_at AS updated_at, c.retrieval_count AS retrieval_count,
                 c.confidence AS quality_score, c.importance AS importance,
                 e.source_ref AS source_ref, e.ts AS source_ts,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json
          FROM classifications c
          JOIN memory_vectors mv ON mv.entity_type = 'classification' AND mv.entity_id = c.id AND mv.model = ?
          LEFT JOIN episodes e ON e.id = c.episode_id
          WHERE c.id = ? AND c.status = 'active'
        `).get(model, entityId);
      }
      if (entityType === "episode") {
        return this.db.prepare(`
          SELECT 'episode' AS type, e.role AS subtype, e.id AS entity_id, e.content,
                 e.created_at AS updated_at, 0 AS retrieval_count,
                 e.source_ref AS source_ref, e.ts AS source_ts,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json,
                 c.topic AS classification_topic,
                 c.element AS classification_element,
               c.chunks AS classification_chunks
          FROM episodes e JOIN memory_vectors mv ON mv.entity_type = 'episode' AND mv.entity_id = e.id AND mv.model = ?
          LEFT JOIN classifications c ON c.episode_id = e.id AND c.status = 'active'
          WHERE e.id = ?
            AND e.kind IN (${RECALL_EPISODE_KIND_SQL2})
        `).get(model, entityId);
      }
      if (entityType === "chunk") {
        return this.db.prepare(`
          SELECT 'chunk' AS type, 'chunk' AS subtype, mc.id AS entity_id,
                 mc.content, mc.created_at AS updated_at, 0 AS retrieval_count,
                 mc.importance AS importance,
                 NULL AS source_ref, e.ts AS source_ts,
                 e.kind AS source_kind, NULL AS source_backend,
                 mv.vector_json,
                 mc.topic AS classification_topic, mc.content AS classification_element,
                 NULL AS classification_chunks, mc.episode_id AS chunk_episode_id
          FROM memory_chunks mc
          JOIN memory_vectors mv ON mv.entity_type = 'chunk' AND mv.entity_id = mc.id AND mv.model = ?
          LEFT JOIN episodes e ON e.id = mc.episode_id
          WHERE mc.id = ? AND mc.status = 'active'
        `).get(model, entityId);
      }
    } catch {
    }
    return null;
  }
  recordRetrieval(results = []) {
    const now = localNow();
    const seen = /* @__PURE__ */ new Set();
    for (const item of results) {
      const entityId = Number(item?.entity_id ?? item?.id);
      const dedupeKey = `${String(item?.type ?? "")}:${entityId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      if (item.type === "classification") {
        this.bumpClassificationRetrievalStmt.run(now, entityId);
      } else if (!Number.isFinite(entityId) || entityId <= 0) {
        continue;
      }
    }
  }
  async buildInboundMemoryContext(query, options = {}) {
    return buildInboundMemoryContext(this, query, options);
  }
};
function getMemoryStore(dataDir) {
  const key = resolve(dataDir);
  const existing = stores.get(key);
  if (existing) return existing;
  const store2 = new MemoryStore(key);
  stores.set(key, store2);
  return store2;
}

// lib/llm-worker-host.mjs
var active = false;
function startLlmWorker() {
  active = true;
}
async function stopLlmWorker() {
  active = false;
}

// lib/memory-cycle.mjs
import { existsSync as existsSync2, mkdirSync as mkdirSync4, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { homedir as homedir2, tmpdir } from "os";
import { join as join4 } from "path";

// lib/llm-provider.mjs
import { execFile, spawn } from "child_process";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
async function execWithInput(command, args, stdin, options = {}) {
  return new Promise((resolve2, reject) => {
    const isWin = process.platform === "win32";
    const safeArgs = isWin ? args.map((a) => /\s/.test(a) ? `"${a}"` : a) : args;
    const child = spawn(command, safeArgs, {
      env: { ...process.env, ...options.env ?? {} },
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd ?? process.cwd(),
      shell: isWin
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = options.timeout || 12e4;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
      }
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
        return;
      }
      resolve2({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code
      });
    });
    child.stdin.write(String(stdin ?? ""));
    child.stdin.end();
  });
}
async function callLLM(prompt, provider, options = {}) {
  const maxRetries = Math.max(0, Number(options.retries ?? 1));
  const baseTimeout = options.timeout || 18e4;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptTimeout = baseTimeout + attempt * 6e4;
    const attemptOptions = { ...options, timeout: attemptTimeout };
    try {
      switch (provider.connection) {
        case "codex":
          return await callCodex(prompt, provider, attemptOptions);
        case "cli":
          return await callClaude(prompt, provider, attemptOptions);
        case "ollama":
          return await callOllama(prompt, provider, attemptOptions);
        case "api":
          return await callAPI(prompt, provider, attemptOptions);
        default:
          throw new Error(`Unknown provider connection: ${provider.connection}`);
      }
    } catch (e) {
      const isTimeout = /timed?\s*out|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up/i.test(e.message);
      if (!isTimeout || attempt >= maxRetries) throw e;
      process.stderr.write(`[llm-provider] timeout on attempt ${attempt + 1}, retrying (${attemptTimeout}ms -> ${attemptTimeout + 6e4}ms)...
`);
      await new Promise((r) => setTimeout(r, 2e3 * (attempt + 1)));
    }
  }
}
async function callCodex(prompt, provider, options) {
  const args = ["exec", "--json", "--model", provider.model || "gpt-5.4"];
  if (provider.effort) args.push("-c", `model_reasoning_effort=${provider.effort}`);
  if (provider.fast) args.push("-c", "service_tier=fast");
  args.push("--skip-git-repo-check");
  const { stdout } = await execWithInput("codex", args, prompt, { ...options, provider });
  const lines = stdout.split("\n").filter((l) => l.trim());
  let lastText = "";
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "item.completed" && obj.item?.type === "agent_message") {
        lastText = obj.item.text;
      }
    } catch {
    }
  }
  return lastText;
}
async function callClaude(prompt, provider, options) {
  const args = [
    "-p",
    "--model",
    provider.model || "sonnet",
    "--output-format",
    "json",
    "--system-prompt",
    "You are a memory extraction system.",
    "--no-session-persistence"
  ];
  if (provider.effort) args.push("--effort", provider.effort);
  const runClaudeOnce = async () => {
    const { stdout } = await execWithInput("claude", args, prompt, { ...options, provider });
    try {
      const parsed = JSON.parse(stdout);
      if (parsed?.is_error) {
        throw new Error(String(parsed?.result ?? "claude provider returned an error"));
      }
      return String(parsed?.result ?? "").trim();
    } catch {
      return stdout.trim();
    }
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await runClaudeOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /Not logged in/i.test(message);
      if (!retryable || attempt >= 2) throw error;
      await new Promise((resolve2) => setTimeout(resolve2, 500 * (attempt + 1)));
    }
  }
}
async function callOllama(prompt, provider, options) {
  const baseUrl = provider.baseUrl || "http://localhost:11434";
  const payload = JSON.stringify({
    model: provider.model || "qwen3.5:9b",
    prompt,
    stream: false,
    options: { num_ctx: 4096, temperature: 0 }
  });
  const { stdout } = await execFileAsync("curl", [
    "-s",
    "-X",
    "POST",
    "-H",
    "Content-Type: application/json",
    "-d",
    payload,
    `${baseUrl}/api/generate`
  ], {
    timeout: options.timeout || 12e4,
    maxBuffer: 10 * 1024 * 1024
  });
  const data = JSON.parse(stdout || "{}");
  return data.response || "";
}
async function callAPI(prompt, provider, options) {
  throw new Error("API provider not yet implemented. Use codex, cli, or ollama.");
}

// lib/memory-cycle.mjs
var PLUGIN_DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || (() => {
  const candidates = [
    join4(homedir2(), ".claude", "plugins", "data", "trib-memory-trib-plugin"),
    join4(homedir2(), ".claude", "plugins", "data", "trib-memory-trib-memory")
  ];
  for (const c of candidates) {
    if (existsSync2(join4(c, "memory.sqlite"))) return c;
  }
  return candidates[0];
})();
var HISTORY_DIR = join4(PLUGIN_DATA_DIR, "history");
var CONFIG_PATH = join4(PLUGIN_DATA_DIR, "memory-cycle.json");
var CYCLE_STATE_PATH = join4(PLUGIN_DATA_DIR, "cycle-state.json");
var DEFAULT_CYCLE_STATE = {
  cycle1: { lastRunAt: null, interval: "5m" },
  cycle2: { lastRunAt: null, schedule: "03:00" }
};
var CYCLE_WRITE_PRIORITY = {
  cycle1: 1,
  cycle2: 1
};
var _cycleWriteActive = false;
var _cycleWriteSeq = 0;
var _cycleWriteQueue = [];
function enqueueCycleWrite(kind, work) {
  return new Promise((resolve2, reject) => {
    _cycleWriteQueue.push({
      kind,
      priority: CYCLE_WRITE_PRIORITY[kind] ?? 1,
      seq: _cycleWriteSeq++,
      work,
      resolve: resolve2,
      reject
    });
    _cycleWriteQueue.sort((left, right) => right.priority - left.priority || left.seq - right.seq);
    void pumpCycleWriteQueue();
  });
}
async function pumpCycleWriteQueue() {
  if (_cycleWriteActive) return;
  const next = _cycleWriteQueue.shift();
  if (!next) return;
  _cycleWriteActive = true;
  try {
    const result = await next.work();
    next.resolve(result);
  } catch (error) {
    next.reject(error);
  } finally {
    _cycleWriteActive = false;
    if (_cycleWriteQueue.length > 0) void pumpCycleWriteQueue();
  }
}
function loadCycleState() {
  try {
    const raw = readFileSync2(CYCLE_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CYCLE_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_CYCLE_STATE };
  }
}
function saveCycleState(state) {
  mkdirSync4(PLUGIN_DATA_DIR, { recursive: true });
  writeFileSync2(CYCLE_STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}
var MAX_MEMORY_CONSOLIDATE_DAYS = 2;
var MAX_MEMORY_CANDIDATES_PER_DAY = 40;
var MAX_MEMORY_CONTEXTUALIZE_ITEMS = 24;
var MEMORY_FLUSH_DEFAULT_MAX_DAYS = 1;
var MEMORY_FLUSH_DEFAULT_MAX_CANDIDATES = 20;
var MEMORY_FLUSH_DEFAULT_MAX_BATCHES = 1;
var MEMORY_FLUSH_DEFAULT_MIN_PENDING = 8;
var BATCH_SIZE = 50;
var MAX_CONCURRENT_BATCHES = 5;
var AUTO_FLUSH_INTERVAL_MS = 2 * 60 * 60 * 1e3;
function resolveCycleBackfillLimit(mainConfig2, fallback) {
  return Math.max(1, Number(mainConfig2?.runtime?.startup?.backfill?.limit ?? fallback));
}
function resolveEmbeddingRefreshOptions(mainConfig2 = {}, kind = "cycle2") {
  const cycleConfig = mainConfig2?.[kind] ?? {};
  const refreshConfig = cycleConfig?.embeddingRefresh ?? {};
  const contextualizeItems = Math.max(
    4,
    Number(refreshConfig.contextualizeItems ?? MAX_MEMORY_CONTEXTUALIZE_ITEMS)
  );
  const perTypeLimit = Math.max(
    4,
    Number(refreshConfig.perTypeLimit ?? Math.max(16, Math.floor(contextualizeItems / 2)))
  );
  return { contextualizeItems, perTypeLimit };
}
function getStore() {
  const mainConfig2 = readMainConfig();
  const embeddingConfig2 = mainConfig2?.embedding ?? {};
  if (embeddingConfig2.provider || embeddingConfig2.ollamaModel || embeddingConfig2.dtype) {
    configureEmbedding({
      provider: embeddingConfig2.provider,
      ollamaModel: embeddingConfig2.ollamaModel,
      dtype: embeddingConfig2.dtype
    });
  }
  return getMemoryStore(PLUGIN_DATA_DIR);
}
function readCycleConfig() {
  try {
    return JSON.parse(readFileSync2(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}
function writeCycleConfig(config) {
  writeFileSync2(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}
function resourceDir() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  try {
    const pluginJson = JSON.parse(readFileSync2(join4(PLUGIN_DATA_DIR, "..", "..", "cache", "trib-memory", "trib-memory", "plugin.json"), "utf8"));
    if (pluginJson?.version) return join4(PLUGIN_DATA_DIR, "..", "..", "cache", "trib-memory", "trib-memory", pluginJson.version);
  } catch {
  }
  return join4(PLUGIN_DATA_DIR, "..", "..", "cache", "trib-memory", "trib-memory", "0.0.1");
}
function extractJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
function parseClassificationCsv(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:csv)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const startIdx = lines[0]?.toLowerCase().includes("case_id") ? 1 : 0;
  const items = [];
  for (let i = startIdx; i < lines.length; i++) {
    const parts = [];
    let cur = "", inQuote = false;
    for (const ch of lines[i]) {
      if (ch === '"') {
        inQuote = !inQuote;
        continue;
      }
      if (ch === "," && !inQuote) {
        parts.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    parts.push(cur.trim());
    if (parts.length < 3) continue;
    items.push({
      case_id: parts[0],
      topic: parts[2] || "",
      element: parts[3] || "",
      importance: parts[4] || ""
    });
  }
  return items.length > 0 ? { items } : null;
}
function cosineSimilarity2(a, b) {
  return cosineSimilarity(a, b);
}
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(p / 100 * (sorted.length - 1))))];
}
async function buildSemanticDayPlan(dayEpisodes) {
  const rows = dayEpisodes.map((ep, i) => ({ index: i, id: ep.id, role: ep.role, content: cleanMemoryText(ep.content ?? "") })).filter((r) => r.content);
  if (rows.length <= 1) return { rows, segments: rows.length ? [{ start: 0, end: rows.length - 1 }] : [], threshold: 1 };
  const vectors = [];
  for (const row of rows) {
    vectors.push(await embedText(String(row.content).slice(0, 768)));
  }
  const similarities = [];
  for (let i = 0; i < vectors.length - 1; i++) similarities.push(cosineSimilarity2(vectors[i], vectors[i + 1]));
  const threshold = Math.max(0.42, percentile(similarities, 35));
  const segments = [];
  let start = 0;
  for (let i = 0; i < similarities.length; i++) {
    if (similarities[i] < threshold) {
      segments.push({ start, end: i });
      start = i + 1;
    }
  }
  segments.push({ start, end: rows.length - 1 });
  return { rows, segments, threshold };
}
function buildCandidateSpan(dayEpisodes, episodeId, semanticPlan) {
  const targetIndex = dayEpisodes.findIndex((item) => Number(item.id) === Number(episodeId));
  if (targetIndex < 0) return "";
  let start = Math.max(0, targetIndex - 1), end = Math.min(dayEpisodes.length - 1, targetIndex + 2);
  if (semanticPlan?.rows?.length) {
    const si = semanticPlan.rows.findIndex((item) => Number(item.id) === Number(episodeId));
    if (si >= 0) {
      const seg = semanticPlan.segments.find((s) => si >= s.start && si <= s.end);
      if (seg) {
        const sr = semanticPlan.rows[Math.max(0, seg.start - 1)];
        const er = semanticPlan.rows[Math.min(semanticPlan.rows.length - 1, seg.end + 1)];
        if (sr) {
          const idx = dayEpisodes.findIndex((e) => Number(e.id) === Number(sr.id));
          if (idx >= 0) start = idx;
        }
        if (er) {
          const idx = dayEpisodes.findIndex((e) => Number(e.id) === Number(er.id));
          if (idx >= 0) end = idx;
        }
      }
    }
  }
  const rows = [];
  for (let i = start; i <= end && rows.length < 6; i++) {
    const cleaned = cleanMemoryText(dayEpisodes[i]?.content ?? "");
    if (cleaned) rows.push(`${i === targetIndex ? "*" : "-"} ${dayEpisodes[i].role === "user" ? "user" : "assistant"}: ${cleaned}`);
  }
  return rows.join("\n");
}
async function prepareConsolidationCandidates(candidates, maxPerBatch, dayEpisodes = []) {
  const seen = /* @__PURE__ */ new Set();
  const prepared = [];
  const plan = await buildSemanticDayPlan(dayEpisodes);
  for (const item of candidates) {
    const cleaned = cleanMemoryText(item?.content ?? "");
    if (!cleaned) continue;
    const concept = classifyCandidateConcept(cleaned, item?.role ?? "user");
    if (!concept.admit) continue;
    const fp = cleaned.toLowerCase().replace(/\s+/g, " ").trim();
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    prepared.push({ ...item, content: cleaned, span_content: buildCandidateSpan(dayEpisodes, item?.episode_id, plan) || cleaned });
    if (prepared.length >= maxPerBatch) break;
  }
  return prepared;
}
async function resolveCycleLlmOutput(prompt, ws, options = {}) {
  if (typeof options.llm === "function") {
    return await options.llm({
      prompt,
      ws,
      provider: options.provider ?? null,
      timeout: options.timeout ?? null,
      mode: options.mode ?? "cycle",
      batchIndex: options.batchIndex ?? 0,
      dayKey: options.dayKey ?? null,
      candidates: options.candidates ?? []
    });
  }
  const provider = options.provider || readMainConfig()?.cycle1?.provider || DEFAULT_CYCLE_PROVIDER;
  return await callLLM(prompt, provider, { timeout: options.timeout ?? 18e4, cwd: ws });
}
async function consolidateCandidateDay(dayKey, _ws, options = {}) {
  const store2 = options.store ?? getStore();
  const maxPerBatch = Math.max(1, Number(options.maxCandidatesPerBatch ?? MAX_MEMORY_CANDIDATES_PER_DAY));
  const candidates = await prepareConsolidationCandidates(store2.getCandidatesForDate(dayKey), maxPerBatch, store2.getEpisodesForDate(dayKey));
  if (candidates.length === 0) return;
  let llmSuccess = false;
  try {
    const promptPath = join4(resourceDir(), "defaults", "memory-consolidate-prompt.md");
    if (existsSync2(promptPath)) {
      const template = readFileSync2(promptPath, "utf8");
      const candidatesText = candidates.map((c, i) => {
        const lines = [`Case ${i + 1}:`, `- content: ${c.content}`];
        if (c.span_content && c.span_content !== c.content) lines.push(`- Context:
${c.span_content}`);
        return lines.join("\n");
      }).join("\n\n");
      const prompt = template.replace("{{DATE}}", dayKey).replace("{{CANDIDATES}}", candidatesText);
      const provider = options.provider || readMainConfig()?.cycle2?.provider || DEFAULT_CYCLE_PROVIDER;
      const raw = await resolveCycleLlmOutput(prompt, _ws, {
        ...options,
        mode: "consolidate",
        dayKey,
        candidates,
        provider,
        timeout: options.timeout ?? 18e4
      });
      const parsed = extractJsonObject(raw);
      if (parsed) {
        const ts = (/* @__PURE__ */ new Date()).toISOString();
        const classificationRows = [];
        for (const fact of parsed.facts ?? []) {
          if (!fact?.text) continue;
          const caseMatch = String(fact.text).match(/Case\s+(\d+)/i);
          const caseIdx = caseMatch ? Number(caseMatch[1]) - 1 : -1;
          const episodeId = caseIdx >= 0 && caseIdx < candidates.length ? candidates[caseIdx].episode_id : candidates[0]?.episode_id;
          classificationRows.push({
            episode_id: Number(episodeId ?? 0),
            classification: String(fact.type ?? "fact").trim(),
            topic: String(fact.slot || fact.workstream || "general").trim(),
            element: String(fact.text).trim(),
            importance: String(fact.type ?? "").trim(),
            confidence: Number(fact.confidence ?? 0.6)
          });
        }
        for (const task of parsed.tasks ?? []) {
          if (!task?.title) continue;
          classificationRows.push({
            episode_id: Number(candidates[0]?.episode_id ?? 0),
            classification: "task",
            topic: String(task.workstream || task.title).trim().slice(0, 80),
            element: String(task.title).trim() + (task.details ? ` | ${task.details}` : ""),
            importance: task.priority === "high" ? "goal" : "directive",
            confidence: Number(task.confidence ?? 0.5)
          });
        }
        if (classificationRows.length > 0) {
          store2.upsertClassifications(classificationRows, ts, null);
          llmSuccess = true;
          process.stderr.write(`[memory-cycle] consolidated ${dayKey}: candidates=${candidates.length}, llm_classifications=${classificationRows.length}
`);
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[memory-cycle] consolidation LLM failed for ${dayKey}: ${e.message}, falling back to classification-only
`);
  }
  if (!llmSuccess) {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const fallbackRows = [];
    for (const c of candidates) {
      const concept = classifyCandidateConcept(cleanMemoryText(c.content), c.role ?? "user");
      if (!concept.admit) continue;
      fallbackRows.push({
        episode_id: Number(c.episode_id ?? 0),
        classification: String(concept.category ?? "fact").trim(),
        topic: String(concept.topic || "general").trim(),
        element: String(cleanMemoryText(c.content)).trim().slice(0, 300),
        importance: concept.importance ?? "",
        confidence: 0.4
      });
    }
    if (fallbackRows.length > 0) {
      store2.upsertClassifications(fallbackRows, ts, null);
    }
    process.stderr.write(`[memory-cycle] consolidated ${dayKey}: candidates=${candidates.length}, mode=classification-only, classifications=${fallbackRows.length}
`);
  }
  store2.markCandidateIdsConsolidated(candidates.map((item) => item.id));
}
async function consolidateRecent(dayKeys, ws, options = {}) {
  const targets = [...dayKeys].sort().reverse().slice(0, Math.max(1, Number(options.maxDays ?? MAX_MEMORY_CONSOLIDATE_DAYS))).sort();
  for (const dayKey of targets) await consolidateCandidateDay(dayKey, ws, options);
}
async function refreshEmbeddings(ws, options = {}) {
  const store2 = options.store ?? getStore();
  const mainConfig2 = readMainConfig();
  const contextualizeEnabled = mainConfig2?.embedding?.contextualize !== false;
  const contextualizeProvider = mainConfig2?.cycle2?.provider ?? DEFAULT_CYCLE_PROVIDER;
  const kind = options.kind ?? "cycle2";
  const refreshOptions = resolveEmbeddingRefreshOptions(mainConfig2, kind);
  const perTypeLimit = options.perTypeLimit ?? refreshOptions.perTypeLimit;
  let contextMap = /* @__PURE__ */ new Map();
  if (contextualizeEnabled) {
    const promptPath = join4(resourceDir(), "defaults", "memory-contextualize-prompt.md");
    if (existsSync2(promptPath)) {
      const items = store2.getEmbeddableItems({ perTypeLimit }).slice(0, refreshOptions.contextualizeItems);
      if (items.length > 0) {
        const template = readFileSync2(promptPath, "utf8");
        const itemsText = items.map((item, i) => [`#${i + 1}`, `key=${item.key}`, `type=${item.entityType}`, item.subtype ? `subtype=${item.subtype}` : "", `content=${item.content}`].filter(Boolean).join("\n")).join("\n\n");
        try {
          const raw = await resolveCycleLlmOutput(template.replace("{{ITEMS}}", itemsText), ws, {
            mode: "contextualize",
            provider: contextualizeProvider,
            timeout: 18e4,
            candidates: items
          });
          const parsed = extractJsonObject(raw);
          for (const row of parsed?.items ?? []) {
            if (row?.key && row?.context) contextMap.set(row.key, row.context);
          }
        } catch (e) {
          process.stderr.write(`[memory-cycle] contextualize failed: ${e.message}
`);
        }
      }
    }
  } else {
    process.stderr.write("[memory-cycle] contextualize disabled by config (embedding.contextualize=false), embedding raw content\n");
  }
  const updated = await store2.ensureEmbeddings({ perTypeLimit, contextMap });
  process.stderr.write(`[memory-cycle] embeddings refreshed: ${updated}
`);
}
function readMainConfig() {
  const mainConfigPath = join4(PLUGIN_DATA_DIR, "config.json");
  try {
    return JSON.parse(readFileSync2(mainConfigPath, "utf8"));
  } catch {
    return {};
  }
}
async function sleepCycleImpl(ws) {
  const store2 = getStore();
  const now = Date.now();
  const config = readCycleConfig();
  const mainConfig2 = readMainConfig();
  const cycle2Config = mainConfig2?.cycle2 ?? {};
  const isFirstRun = !config.lastSleepAt;
  const backfillLimit = resolveCycleBackfillLimit(mainConfig2, 120);
  process.stderr.write(`[memory-cycle2] Starting.${isFirstRun ? " (FIRST RUN)" : ""}
`);
  store2.backfillProject(ws, { limit: backfillLimit });
  const MAX_DAYS = Math.max(1, Number(cycle2Config.maxDays ?? 7));
  const pendingDays = store2.getPendingCandidateDays(MAX_DAYS, 1).map((d) => d.day_key).sort().reverse();
  const consolidateOpts = { provider: cycle2Config.provider ?? DEFAULT_CYCLE_PROVIDER };
  await consolidateRecent(pendingDays, ws, consolidateOpts);
  store2.syncHistoryFromFiles();
  const dedupResult = await deduplicateClassifications(store2, { dryRun: false });
  if (dedupResult.merged > 0) {
    process.stderr.write(`[memory-cycle2] dedup: merged=${dedupResult.merged}
`);
  }
  try {
    await coreMemoryPromote(store2, ws, mainConfig2);
  } catch (e) {
    process.stderr.write(`[memory-cycle2] core-promote error: ${e.message}
`);
  }
  try {
    const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const dailyDir = join4(HISTORY_DIR, "daily");
    mkdirSync4(dailyDir, { recursive: true });
    const journalPath = join4(dailyDir, `${today}.md`);
    if (!existsSync2(journalPath)) {
      const dayEpisodes = store2.getEpisodesForDate(today);
      const dayClassifications = store2.db.prepare(`
        SELECT topic, element, importance FROM classifications
        WHERE status = 'active' AND updated_at >= ? AND updated_at < ?
        ORDER BY updated_at
      `).all(`${today}T00:00:00`, `${today}T23:59:59`);
      if (dayEpisodes.length > 0 || dayClassifications.length > 0) {
        const episodeSummary = dayEpisodes.slice(0, 60).map((ep) => {
          const role = ep.role === "user" ? "User" : "Assistant";
          return `- ${role}: ${String(ep.content ?? "").slice(0, 200)}`;
        }).join("\n");
        const classificationSummary = dayClassifications.map(
          (c) => `- [${c.importance}] ${c.topic}: ${c.element}`
        ).join("\n");
        const journalPrompt = [
          `Today's date: ${today}`,
          "",
          "Episodes:",
          episodeSummary || "(none)",
          "",
          "Classifications:",
          classificationSummary || "(none)",
          "",
          "Write a daily journal entry in a natural, readable style. Include key tasks, discussions, decisions, and issues. Write it as a personal daily log, not a formal report. Write in Korean."
        ].join("\n");
        try {
          const provider = cycle2Config.provider ?? DEFAULT_CYCLE_PROVIDER;
          const journalContent = await resolveCycleLlmOutput(journalPrompt, ws, {
            mode: "journal",
            provider,
            timeout: 12e4
          });
          if (journalContent && journalContent.trim().length > 20) {
            writeFileSync2(journalPath, `# ${today} Daily Journal

${journalContent.trim()}
`, "utf8");
            process.stderr.write(`[memory-cycle2] daily journal written: ${journalPath}
`);
          }
        } catch (e) {
          process.stderr.write(`[memory-cycle2] journal generation failed: ${e.message}
`);
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[memory-cycle2] journal error: ${e.message}
`);
  }
  writeCycleConfig({ ...config, lastSleepAt: now });
  const cycleState = loadCycleState();
  cycleState.cycle2.lastRunAt = (/* @__PURE__ */ new Date()).toISOString();
  saveCycleState(cycleState);
  process.stderr.write("[memory-cycle2] Cycle complete.\n");
}
async function sleepCycle(ws) {
  return enqueueCycleWrite("cycle2", () => sleepCycleImpl(ws));
}
var DEDUP_SIMILARITY_THRESHOLD = 0.85;
async function deduplicateClassifications(store2, options = {}) {
  const dryRun = Boolean(options.dryRun ?? false);
  const threshold = Number(options.threshold ?? DEDUP_SIMILARITY_THRESHOLD);
  const rows = store2.db.prepare(`
    SELECT c.id, c.episode_id, c.topic, c.element, c.importance, c.confidence, c.updated_at
    FROM classifications c
    WHERE c.status = 'active'
    ORDER BY c.updated_at DESC
  `).all();
  if (rows.length < 2) return { merged: 0, checked: 0 };
  const vectors = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const vec = store2.db.prepare(`
      SELECT vector_json FROM memory_vectors
      WHERE entity_type = 'classification' AND entity_id = ?
    `).get(row.id);
    if (vec?.vector_json) {
      try {
        const parsed = typeof vec.vector_json === "string" ? JSON.parse(vec.vector_json) : vec.vector_json;
        if (Array.isArray(parsed) && parsed.length > 0) vectors.set(row.id, parsed);
      } catch {
      }
    }
  }
  const merged = [];
  const removed = /* @__PURE__ */ new Set();
  for (let i = 0; i < rows.length; i++) {
    if (removed.has(rows[i].id)) continue;
    const vecA = vectors.get(rows[i].id);
    if (!vecA) continue;
    for (let j = i + 1; j < rows.length; j++) {
      if (removed.has(rows[j].id)) continue;
      const vecB = vectors.get(rows[j].id);
      if (!vecB) continue;
      const sim = cosineSimilarity2(vecA, vecB);
      if (sim >= threshold) {
        removed.add(rows[j].id);
        merged.push({
          kept: rows[i].id,
          removed: rows[j].id,
          similarity: sim,
          keptTopic: rows[i].topic,
          removedTopic: rows[j].topic
        });
      }
    }
  }
  if (!dryRun && removed.size > 0) {
    const ids = [...removed];
    const placeholders = ids.map(() => "?").join(",");
    store2.db.prepare(`UPDATE classifications SET status = 'superseded' WHERE id IN (${placeholders})`).run(...ids);
    store2.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'classification' AND entity_id IN (${placeholders})`).run(...ids);
  }
  return { merged: merged.length, checked: rows.length, removed: [...removed], details: dryRun ? merged : void 0 };
}
async function memoryFlushImpl(ws, options = {}) {
  const store2 = getStore();
  const maxDays = Math.max(1, Number(options.maxDays ?? MEMORY_FLUSH_DEFAULT_MAX_DAYS));
  const maxPerBatch = Math.max(1, Number(options.maxCandidatesPerBatch ?? MEMORY_FLUSH_DEFAULT_MAX_CANDIDATES));
  const maxBatches = Math.max(1, Number(options.maxBatches ?? MEMORY_FLUSH_DEFAULT_MAX_BATCHES));
  const minPending = Math.max(1, Number(options.minPending ?? MEMORY_FLUSH_DEFAULT_MIN_PENDING));
  const pendingDays = store2.getPendingCandidateDays(maxDays * 3, minPending);
  if (!pendingDays.length) {
    process.stderr.write("[memory-cycle] no flushable batches.\n");
    return;
  }
  const targets = pendingDays.map((d) => d.day_key).sort().reverse().slice(0, maxDays);
  const consolidateOpts = { maxCandidatesPerBatch: maxPerBatch, maxBatches };
  consolidateOpts.provider = options.provider ?? readMainConfig()?.cycle2?.provider ?? DEFAULT_CYCLE_PROVIDER;
  for (const dayKey of targets) await consolidateCandidateDay(dayKey, ws, consolidateOpts);
  await refreshEmbeddings(ws);
}
async function memoryFlush(ws, options = {}) {
  return enqueueCycleWrite("cycle2", () => memoryFlushImpl(ws, options));
}
var WINDOW_TO_DAYS = { "1d": 1, "3d": 3, "7d": 7, "30d": 30 };
async function rebuildClassificationsImpl(ws, options = {}) {
  const store2 = options.store ?? getStore();
  const config = readMainConfig();
  const maxAgeDays = options.window ? WINDOW_TO_DAYS[options.window] ?? null : options.maxAgeDays ?? null;
  const maxConcurrent = Math.max(1, Math.min(Number(options.maxConcurrentBatches ?? MAX_CONCURRENT_BATCHES), 10));
  const batchSize = Math.max(1, Number(options.batchSize ?? BATCH_SIZE));
  try {
    store2.backfillProject(ws, { limit: 500 });
  } catch {
  }
  const pendingDaysLimit = maxAgeDays ?? 9999;
  const pendingDays = store2.getPendingCandidateDays(pendingDaysLimit, 1);
  if (pendingDays.length === 0) {
    process.stderr.write("[rebuild] no pending candidates.\n");
    return { total: 0, batches: 0, classifications: 0 };
  }
  const allCandidates = [];
  for (const { day_key } of pendingDays.sort((a, b) => b.day_key.localeCompare(a.day_key))) {
    const dayCandidates = store2.getCandidatesForDate(day_key).map((c) => ({ ...c, content: cleanMemoryText(c.content) })).filter((c) => c.content && !looksLowSignalCycle1(c.content));
    allCandidates.push(...dayCandidates);
  }
  if (allCandidates.length === 0) {
    process.stderr.write("[rebuild] no valid candidates after filtering.\n");
    return { total: 0, batches: 0, classifications: 0 };
  }
  const batches = [];
  for (let i = 0; i < allCandidates.length; i += batchSize) {
    batches.push(allCandidates.slice(i, i + batchSize));
  }
  process.stderr.write(`[rebuild] ${allCandidates.length} candidates in ${batches.length} batches (concurrency=${maxConcurrent})
`);
  let totalExtracted = 0;
  let totalClassifications = 0;
  let batchesCompleted = 0;
  for (let i = 0; i < batches.length; i += maxConcurrent) {
    const wave = batches.slice(i, i + maxConcurrent);
    const waveResults = await Promise.all(
      wave.map((batch, idx) => {
        const batchIdx = i + idx;
        return runCycle1Impl(ws, config, {
          store: store2,
          force: true,
          maxItems: batch.length,
          _preSplitCandidates: batch
        }).catch((e) => {
          process.stderr.write(`[rebuild] batch ${batchIdx} error: ${e.message}
`);
          return { extracted: 0, classifications: 0 };
        });
      })
    );
    for (const result of waveResults) {
      totalExtracted += result.extracted ?? 0;
      totalClassifications += result.classifications ?? 0;
      batchesCompleted++;
    }
    process.stderr.write(`[rebuild] wave ${Math.floor(i / maxConcurrent) + 1}: ${waveResults.length} batches done, total=${totalExtracted}/${allCandidates.length}
`);
  }
  if (totalExtracted > 0) {
    await refreshEmbeddings(ws, { store: store2, kind: "cycle1", perTypeLimit: Math.min(128, Math.max(64, totalClassifications)) });
  }
  store2.writeRecentFile();
  process.stderr.write(`[rebuild] complete: ${totalExtracted} extracted, ${totalClassifications} classifications, ${batchesCompleted} batches
`);
  return { total: totalExtracted, batches: batchesCompleted, classifications: totalClassifications };
}
async function rebuildClassifications(ws, options = {}) {
  return enqueueCycleWrite("cycle1", () => rebuildClassificationsImpl(ws, options));
}
async function rebuildRecentImpl(ws, options = {}) {
  const store2 = getStore();
  const mainConfig2 = readMainConfig();
  store2.backfillProject(ws, { limit: Math.max(resolveCycleBackfillLimit(mainConfig2, 120), 240) });
  store2.syncHistoryFromFiles();
  const maxDays = Math.max(1, Number(options.window ? WINDOW_TO_DAYS[options.window] ?? options.maxDays ?? 2 : options.maxDays ?? 2));
  const dayKeys = store2.getRecentCandidateDays(maxDays).map((d) => d.day_key).sort().reverse();
  if (!dayKeys.length) {
    process.stderr.write("[memory-cycle] no recent days.\n");
    return;
  }
  store2.resetConsolidatedMemoryForDays(dayKeys);
  const mergedOptions = options.provider ? options : { ...options, provider: mainConfig2?.cycle2?.provider ?? DEFAULT_CYCLE_PROVIDER };
  for (const dayKey of dayKeys) await consolidateCandidateDay(dayKey, ws, mergedOptions);
  store2.syncHistoryFromFiles();
  await refreshEmbeddings(ws, { kind: "cycle2" });
  process.stderr.write(`[memory-cycle] rebuilt recent ${dayKeys.length} day(s).
`);
}
async function rebuildRecent(ws, options = {}) {
  return enqueueCycleWrite("cycle2", () => rebuildRecentImpl(ws, options));
}
async function pruneToRecentImpl(ws, options = {}) {
  const store2 = getStore();
  const mainConfig2 = readMainConfig();
  store2.backfillProject(ws, { limit: Math.max(resolveCycleBackfillLimit(mainConfig2, 120), 240) });
  store2.syncHistoryFromFiles();
  const maxDays = Math.max(1, Number(options.maxDays ?? 5));
  const dayKeys = store2.getRecentCandidateDays(maxDays).map((d) => d.day_key).sort().reverse();
  if (!dayKeys.length) {
    process.stderr.write("[memory-cycle] no recent days.\n");
    return;
  }
  store2.pruneConsolidatedMemoryOutsideDays(dayKeys);
  await refreshEmbeddings(ws, { kind: "cycle2" });
  process.stderr.write(`[memory-cycle] pruned to ${dayKeys.join(", ")}.
`);
}
async function pruneToRecent(ws, options = {}) {
  return enqueueCycleWrite("cycle2", () => pruneToRecentImpl(ws, options));
}
function getCycleStatus() {
  const config = readCycleConfig();
  const mainConfig2 = readMainConfig();
  const store2 = getStore();
  const pending = store2.getPendingCandidateDays(100, 1);
  const cycleState = loadCycleState();
  const memoryConfig = mainConfig2 ?? {};
  return {
    lastSleepAt: config.lastSleepAt ? new Date(config.lastSleepAt).toISOString() : null,
    lastCycle1At: config.lastCycle1At ? new Date(config.lastCycle1At).toISOString() : null,
    pendingDays: pending.length,
    pendingCandidates: pending.reduce((sum, d) => sum + d.n, 0),
    cycleState,
    memoryConfig: {
      cycle1: {
        interval: memoryConfig.cycle1?.interval ?? "5m",
        maxPending: memoryConfig.cycle1?.maxPending ?? null,
        provider: memoryConfig.cycle1?.provider?.connection ?? "codex"
      },
      cycle2: { schedule: memoryConfig.cycle2?.schedule ?? "03:00", maxCandidates: memoryConfig.cycle2?.maxCandidates ?? null, provider: memoryConfig.cycle2?.provider?.connection ?? "cli" }
    }
  };
}
function looksLowSignalCycle1(text) {
  const clean = cleanMemoryText(text);
  if (!clean) return true;
  if (clean.includes("[Request interrupted by user]")) return true;
  if (/<event-result[\s>]|<event\s/i.test(String(text ?? ""))) return true;
  if (/^(read|list|show|count|find|tell me|summarize)\b/i.test(clean) && /(\/|\.jsonl\b|\.md\b|\.csv\b|\bfilenames?\b)/i.test(clean)) return true;
  if (/^no response requested\.?$/i.test(clean)) return true;
  if (/^stop hook error:/i.test(clean)) return true;
  if (/return this exact shape:/i.test(clean)) return true;
  const compact = clean.replace(/\s+/g, "");
  const hasKorean = /[\uAC00-\uD7AF]/.test(compact);
  const shortKoreanMeaningful = hasKorean && compact.length >= 2 && (/[?？]$/.test(clean) || /일정|상태|시간|규칙|정책|언어|말투|호칭|기억|검색|중복|설정|오류|버그|왜|뭐|언제|어디|누구|무엇/.test(clean) || classifyCandidateConcept(clean, "user")?.admit);
  if (compact.length < (hasKorean ? 4 : 8) && !shortKoreanMeaningful) return true;
  return false;
}
function loadClassificationPrompt() {
  const promptPath = join4(resourceDir(), "defaults", "memory-classification-prompt.md");
  if (existsSync2(promptPath)) return readFileSync2(promptPath, "utf8");
  return "Fill the missing classification columns for each row. Output JSON only.\n\n{{ROWS}}";
}
function buildCycle1ClassificationRows(candidates = []) {
  return candidates.map((candidate) => {
    const text = candidate.content?.slice(0, 300) || "";
    return `- id:${candidate.episode_id} text:${text}`;
  }).join("\n");
}
var FALLBACK_CYCLE_PROVIDER = { connection: "codex", model: "gpt-5.4-mini", effort: "medium", fast: true };
function resolveDefaultProvider() {
  const config = readMainConfig();
  return config?.defaultProvider ?? FALLBACK_CYCLE_PROVIDER;
}
var DEFAULT_CYCLE_PROVIDER = FALLBACK_CYCLE_PROVIDER;
async function runCycle1Impl(ws, config, options = {}) {
  const store2 = options.store ?? getStore();
  const cycleConfig = readCycleConfig();
  const force = Boolean(options.force);
  const backfillLimit = resolveCycleBackfillLimit(config, 50);
  try {
    store2.backfillProject(ws, { limit: backfillLimit });
  } catch {
  }
  const cycle1Config2 = config?.cycle1 ?? {};
  const batchSize = Math.max(1, Number(options.maxItems ?? cycle1Config2.batchSize ?? BATCH_SIZE));
  const maxDays = force ? 9999 : Math.max(1, Number(options.maxAgeDays ?? cycle1Config2.maxDays ?? 7));
  const provider = config?.cycle1?.provider || DEFAULT_CYCLE_PROVIDER;
  const timeout = config?.cycle1?.timeout || 3e5;
  let allCandidates;
  if (Array.isArray(options._preSplitCandidates) && options._preSplitCandidates.length > 0) {
    allCandidates = options._preSplitCandidates;
  } else {
    const pendingDays = store2.getPendingCandidateDays(maxDays, 1);
    if (pendingDays.length === 0) {
      writeCycleConfig({ ...cycleConfig, lastCycle1At: Date.now() });
      return { extracted: 0, classifications: 0 };
    }
    allCandidates = [];
    for (const { day_key } of pendingDays.sort((a, b) => b.day_key.localeCompare(a.day_key))) {
      const dayCandidates = store2.getCandidatesForDate(day_key).map((c) => ({ ...c, content: cleanMemoryText(c.content) })).filter((c) => c.content && !looksLowSignalCycle1(c.content));
      allCandidates.push(...dayCandidates);
      if (!force && allCandidates.length >= batchSize) break;
    }
    if (allCandidates.length === 0) {
      writeCycleConfig({ ...cycleConfig, lastCycle1At: Date.now() });
      return { extracted: 0, classifications: 0 };
    }
  }
  let totalExtracted = 0, totalClassifications = 0;
  const changedClassificationIds = /* @__PURE__ */ new Set();
  const batches = [];
  for (let i = 0; i < allCandidates.length; i += batchSize) {
    batches.push(allCandidates.slice(i, i + batchSize));
    if (!force) break;
  }
  const concurrency = force ? Number(cycle1Config2.concurrency ?? 2) : 1;
  async function processSingleBatch(candidates, batchIndex) {
    const extractionPrompt = loadClassificationPrompt().replace("{{ROWS}}", buildCycle1ClassificationRows(candidates));
    let raw;
    try {
      raw = await resolveCycleLlmOutput(extractionPrompt, ws, {
        ...options,
        mode: "cycle1",
        batchIndex,
        candidates,
        provider,
        timeout
      });
    } catch (e) {
      process.stderr.write(`[cycle1] batch ${batchIndex} LLM error: ${e.message}
`);
      return null;
    }
    let classificationRows = [];
    try {
      const jsonMatch = String(raw).match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const items = JSON.parse(jsonMatch[0]);
        classificationRows = items.map((item) => ({
          episode_id: Number(item?.id ?? item?.case_id ?? 0),
          classification: "-",
          topic: String(item?.topic ?? "").trim(),
          element: String(item?.element ?? "").trim(),
          importance: String(item?.importance ?? "").trim(),
          confidence: 0.6,
          chunks: Array.isArray(item?.chunks) ? item.chunks.map((c) => String(c).trim()).filter(Boolean).slice(0, 3) : []
        }));
      }
    } catch {
    }
    if (classificationRows.length === 0) {
      const parsed = parseClassificationCsv(raw);
      if (parsed?.items) {
        classificationRows = parsed.items.map((item) => ({
          episode_id: Number(item?.case_id ?? 0),
          classification: "-",
          topic: String(item?.topic ?? "").trim(),
          element: String(item?.element ?? "").trim(),
          importance: String(item?.importance ?? "").trim(),
          confidence: 0.6
        }));
      }
    }
    if (classificationRows.length === 0) {
      process.stderr.write(`[cycle1] batch ${batchIndex}: unparseable response (${String(raw).slice(0, 200)})
`);
      return null;
    }
    const candidateById = new Map(candidates.map((c) => [Number(c.episode_id), c]));
    for (const row of classificationRows) {
      if (row.element.length < 8) {
        const src = candidateById.get(row.episode_id);
        if (src?.content) {
          const fallback = cleanMemoryText(src.content).slice(0, 120);
          row.element = fallback || row.element;
        }
      }
      if (row.topic.length < 4 && row.element.length >= 4) {
        row.topic = row.element.split(/\s+/).slice(0, 3).join(" ");
      }
    }
    return { candidates, classificationRows, batchIndex };
  }
  for (let i = 0; i < batches.length; i += concurrency) {
    const chunk = batches.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map((batch, idx) => processSingleBatch(batch, i + idx)));
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    for (const result2 of results) {
      if (!result2) continue;
      const { candidates, classificationRows, batchIndex } = result2;
      const elementChangedIds = /* @__PURE__ */ new Set();
      for (const row of classificationRows) {
        const epId = Number(row.episode_id);
        if (!epId) continue;
        const existing = store2.db.prepare("SELECT id, element FROM classifications WHERE episode_id = ?").get(epId);
        if (existing && existing.element !== row.element) {
          elementChangedIds.add(existing.id);
        }
      }
      store2.upsertClassifications(classificationRows, ts, null);
      for (const row of classificationRows) {
        const epId = Number(row.episode_id);
        if (!epId || !Array.isArray(row.chunks) || row.chunks.length === 0) continue;
        const clsRow = store2.db.prepare("SELECT id FROM classifications WHERE episode_id = ?").get(epId);
        const clsId = clsRow?.id ?? null;
        try {
          store2.db.prepare("DELETE FROM memory_chunks WHERE episode_id = ?").run(epId);
        } catch {
        }
        for (let seq = 0; seq < row.chunks.length; seq++) {
          const chunkText = String(row.chunks[seq]).trim();
          if (!chunkText) continue;
          store2.db.prepare(`
            INSERT INTO memory_chunks (episode_id, classification_id, content, topic, importance, seq)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(epId, clsId, chunkText, row.topic || null, row.importance || null, seq);
          const chunkId = store2.db.prepare("SELECT last_insert_rowid() as id").get().id;
          try {
            store2.db.prepare("INSERT INTO memory_chunks_fts(rowid, content, topic) VALUES (?, ?, ?)").run(chunkId, chunkText, row.topic || "");
          } catch {
          }
        }
      }
      const processedIds = candidates.map((c) => c.id).filter((id) => id != null);
      if (processedIds.length > 0) {
        const placeholders = processedIds.map(() => "?").join(",");
        store2.db.prepare(`
          DELETE FROM memory_candidates
          WHERE id IN (${placeholders}) AND status = 'pending'
        `).run(...processedIds);
      }
      totalExtracted += candidates.length;
      totalClassifications += classificationRows.length;
      process.stderr.write(`[cycle1] batch ${batchIndex}: ${candidates.length} candidates \u2192 ${classificationRows.length} classifications
`);
      for (const id of elementChangedIds) {
        changedClassificationIds.add(id);
      }
    }
  }
  if (totalExtracted > 0) {
    const EMBED_LIMIT = 64;
    const embeddableItems = store2.getEmbeddableItems({ perTypeLimit: EMBED_LIMIT }).filter((item) => item.entityType === "classification" || item.entityType === "chunk");
    const lookupModel = getEmbeddingModelId();
    let embeddedCount = 0;
    for (const item of embeddableItems) {
      if (embeddedCount >= EMBED_LIMIT) break;
      const embedInput = cleanMemoryText(item.content ?? "");
      if (!embedInput) continue;
      const contentHash = hashEmbeddingInput(embedInput);
      const existing = store2.getVectorStmt.get(item.entityType, item.entityId, lookupModel);
      const forceRefresh = item.entityType === "classification" && changedClassificationIds.has(item.entityId);
      if (!forceRefresh && existing?.content_hash === contentHash) continue;
      const vector = await embedText(embedInput);
      if (!Array.isArray(vector) || vector.length === 0) continue;
      const activeModel = getEmbeddingModelId();
      store2.upsertVectorStmt.run(
        item.entityType,
        item.entityId,
        activeModel,
        vector.length,
        JSON.stringify(vector),
        contentHash
      );
      store2._syncToVecTable(item.entityType, item.entityId, vector);
      store2.noteVectorWrite(activeModel, vector.length);
      embeddedCount += 1;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (changedClassificationIds.size > 0) {
      process.stderr.write(`[cycle1] element-changed classifications refreshed: ${changedClassificationIds.size}
`);
    }
    process.stderr.write(`[cycle1] inline embeddings: ${embeddedCount} items
`);
  }
  store2.writeRecentFile();
  writeCycleConfig({ ...cycleConfig, lastCycle1At: Date.now() });
  const cycleState = loadCycleState();
  cycleState.cycle1.lastRunAt = (/* @__PURE__ */ new Date()).toISOString();
  saveCycleState(cycleState);
  const result = {
    extracted: totalExtracted,
    classifications: totalClassifications
  };
  if (totalExtracted > 0) {
    process.stderr.write(`[memory-cycle1] extracted=${result.extracted} classifications=${result.classifications}
`);
  }
  return result;
}
async function coreMemoryPromote(store2, ws, config) {
  const cycle2Config = config?.cycle2 ?? {};
  const provider = cycle2Config.provider || resolveDefaultProvider();
  const topK = Math.max(1, Math.min(Number(cycle2Config.coreMemoryTopK ?? 30), 50));
  const activeRows = store2.db.prepare(`
    SELECT c.id, c.episode_id, c.topic, c.element, c.importance, c.confidence, c.updated_at,
           COALESCE(c.retrieval_count, 0) AS retrieval_count
    FROM classifications c
    WHERE c.status = 'active'
    ORDER BY c.updated_at DESC
  `).all();
  if (activeRows.length === 0) {
    process.stderr.write(`[memory-cycle2] core-promote: no active classifications
`);
    return;
  }
  for (const row of activeRows) {
    try {
      const stats = store2.db.prepare(
        `SELECT mention_count, last_seen FROM classification_stats WHERE classification_id = ?`
      ).get(row.id);
      if (stats) {
        row.mention_count = stats.mention_count;
        row.last_seen = stats.last_seen;
      }
    } catch {
    }
    const retrievalCount = Number(row.retrieval_count ?? 0);
    const mentionCount = Number(row.mention_count ?? 0);
    const lastSeen = row.last_seen ? new Date(row.last_seen).getTime() : row.updated_at ? new Date(row.updated_at).getTime() : 0;
    const daysSince = lastSeen ? Math.max(0, (Date.now() - lastSeen) / 864e5) : 999;
    row.final_score = Number((Math.log1p(mentionCount) * 0.7 + Math.log1p(retrievalCount) * 0.95 + Math.exp(-daysSince / 21) * 0.55).toFixed(4));
  }
  activeRows.sort((a, b) => b.final_score - a.final_score);
  const topRows = activeRows.slice(0, topK);
  const existingCoreRows = store2.db.prepare(
    `SELECT id, classification_id, topic, element, importance, final_score, status FROM core_memory WHERE status IN ('active', 'staged') ORDER BY status DESC, final_score DESC`
  ).all();
  const corePromptPath = join4(resourceDir(), "defaults", "memory-core-promote-prompt.md");
  if (!existsSync2(corePromptPath)) {
    process.stderr.write(`[memory-cycle2] core-promote prompt not found, skipping
`);
    return;
  }
  const coreTemplate = readFileSync2(corePromptPath, "utf8");
  const coreMemoryText = existingCoreRows.length > 0 ? existingCoreRows.map(
    (cm) => `- id:${cm.id} status:${cm.status} topic:${cm.topic} importance:${cm.importance} element:${cm.element}`
  ).join("\n") : "(empty)";
  const classificationsText = topRows.map(
    (r) => `- id:${r.id} topic:${r.topic} importance:${r.importance} score:${r.final_score} element:${r.element}`
  ).join("\n");
  const prompt = coreTemplate.replace("{{CORE_MEMORY}}", coreMemoryText).replace("{{CLASSIFICATIONS}}", classificationsText);
  let allActions = [];
  try {
    const raw = await resolveCycleLlmOutput(prompt, ws, {
      mode: "core-promote",
      provider,
      timeout: 18e4
    });
    const parsed = extractJsonObject(raw);
    if (parsed?.actions && Array.isArray(parsed.actions)) {
      allActions = parsed.actions;
    }
  } catch (e) {
    process.stderr.write(`[memory-cycle2] core-promote LLM failed: ${e.message}
`);
    return;
  }
  if (allActions.length === 0) {
    process.stderr.write(`[memory-cycle2] core-promote: no actions (LLM judged no changes needed)
`);
    return;
  }
  let addCount = 0, stageCount = 0, promoteCount = 0, updateCount = 0, demoteCount = 0, mergeCount = 0;
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  for (const act of allActions) {
    try {
      if (act.action === "add" && act.element) {
        const matchingCls = topRows.find((r) => r.topic === act.topic || r.element === act.element);
        const clsId = matchingCls?.id ?? 0;
        if (clsId <= 0) continue;
        store2.db.prepare(`
          INSERT INTO core_memory (classification_id, topic, element, importance, final_score, promoted_at, last_seen_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
          ON CONFLICT(classification_id) DO UPDATE SET
            topic = excluded.topic, element = excluded.element, importance = excluded.importance,
            final_score = excluded.final_score, last_seen_at = excluded.last_seen_at, status = 'active'
        `).run(
          clsId,
          act.topic ?? "",
          act.element,
          act.importance ?? "fact",
          matchingCls?.final_score ?? 0,
          ts,
          ts
        );
        addCount++;
      } else if (act.action === "stage" && act.element) {
        const matchingCls = topRows.find((r) => r.topic === act.topic || r.element === act.element);
        const clsId = matchingCls?.id ?? 0;
        if (clsId <= 0) continue;
        store2.db.prepare(`
          INSERT INTO core_memory (classification_id, topic, element, importance, final_score, promoted_at, last_seen_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'staged')
          ON CONFLICT(classification_id) DO UPDATE SET
            topic = excluded.topic, element = excluded.element, importance = excluded.importance,
            final_score = excluded.final_score, last_seen_at = excluded.last_seen_at, status = 'staged'
        `).run(
          clsId,
          act.topic ?? "",
          act.element,
          act.importance ?? "fact",
          matchingCls?.final_score ?? 0,
          ts,
          ts
        );
        stageCount++;
      } else if (act.action === "promote" && act.id) {
        store2.db.prepare(`UPDATE core_memory SET status = 'active', last_seen_at = ? WHERE id = ? AND status = 'staged'`).run(ts, act.id);
        promoteCount++;
      } else if (act.action === "update" && act.id && act.element) {
        store2.db.prepare(`
          UPDATE core_memory SET element = ?, importance = ?, last_seen_at = ? WHERE id = ?
        `).run(act.element, act.importance ?? "fact", ts, act.id);
        updateCount++;
      } else if (act.action === "demote" && act.id) {
        store2.db.prepare(`UPDATE core_memory SET status = 'demoted' WHERE id = ?`).run(act.id);
        demoteCount++;
      } else if (act.action === "merge" && Array.isArray(act.ids) && act.ids.length >= 2 && act.element) {
        const [keepId, ...removeIds] = act.ids;
        store2.db.prepare(`
          UPDATE core_memory SET element = ?, topic = ?, importance = ?, last_seen_at = ? WHERE id = ?
        `).run(act.element, act.topic ?? "", act.importance ?? "fact", ts, keepId);
        for (const rid of removeIds) {
          store2.db.prepare(`UPDATE core_memory SET status = 'demoted' WHERE id = ?`).run(rid);
        }
        mergeCount++;
        demoteCount += removeIds.length;
      }
    } catch (e) {
      process.stderr.write(`[memory-cycle2] core-promote action error: ${e.message}
`);
    }
  }
  process.stderr.write(`[memory-cycle2] core_memory: add=${addCount} stage=${stageCount} promote=${promoteCount} update=${updateCount} demote=${demoteCount} merge=${mergeCount}
`);
}
async function runCycle1(ws, config, options = {}) {
  return enqueueCycleWrite("cycle1", () => runCycle1Impl(ws, config, options));
}
function parseInterval(s) {
  if (String(s).toLowerCase() === "immediate") return 0;
  const match = String(s).match(/^(\d+)(s|m|h)$/);
  if (!match) return 6e5;
  const [, num, unit] = match;
  const multiplier = { s: 1e3, m: 6e4, h: 36e5 };
  return Number(num) * multiplier[unit];
}

// services/memory-service.mjs
process.removeAllListeners("warning");
process.on("warning", () => {
});
try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
}
try {
  const { env } = await import("@huggingface/transformers");
  env.backends.onnx.wasm.numThreads = 2;
} catch {
}
var DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || process.argv[2] || (() => {
  const candidates = [
    path2.join(os.homedir(), ".claude", "plugins", "data", "trib-memory-tribgames")
  ];
  for (const c of candidates) {
    if (fs2.existsSync(path2.join(c, "memory.sqlite"))) return c;
  }
  return null;
})();
if (!DATA_DIR) {
  process.stderr.write("[memory-service] CLAUDE_PLUGIN_DATA not set and no fallback found\n");
  process.exit(1);
}
process.stderr.write(`[memory-service] DATA_DIR=${DATA_DIR}
`);
var RUNTIME_DIR = path2.join(os.tmpdir(), "trib-memory");
try {
  fs2.mkdirSync(RUNTIME_DIR, { recursive: true });
} catch {
}
var PORT_FILE = path2.join(RUNTIME_DIR, "memory-port");
var BASE_PORT = 3350;
var MAX_PORT = 3357;
var mainConfig = readMainConfig();
var opsPolicy = readMemoryOpsPolicy(mainConfig);
var featureFlags = readMemoryFeatureFlags(mainConfig);
var embeddingConfig = mainConfig?.embedding;
if (embeddingConfig?.provider || embeddingConfig?.ollamaModel || embeddingConfig?.dtype) {
  configureEmbedding({
    provider: embeddingConfig.provider,
    ollamaModel: embeddingConfig.ollamaModel,
    dtype: embeddingConfig.dtype
  });
}
var store = getMemoryStore(DATA_DIR);
store.syncHistoryFromFiles();
startLlmWorker();
var WORKSPACE_PATH = process.env.TRIB_MEMORY_WORKSPACE || process.cwd();
function getPendingCandidateCount() {
  try {
    return store.getPendingCandidateDays(100, 1).reduce((sum, item) => sum + Number(item?.n ?? 0), 0);
  } catch {
    return 0;
  }
}
function getPendingEmbedCount() {
  try {
    return Number(store.db.prepare("SELECT COUNT(*) AS n FROM pending_embeds").get()?.n ?? 0);
  } catch {
    return 0;
  }
}
var startupBackfill = buildStartupBackfillOptions(opsPolicy, store);
if (startupBackfill) {
  try {
    const n = startupBackfill.scope === "workspace" ? store.backfillProject(WORKSPACE_PATH, startupBackfill) : store.backfillAllProjects(startupBackfill);
    if (n > 0) {
      process.stderr.write(
        `[memory-service] startup backfill (${startupBackfill.scope}/${startupBackfill.sinceMs ? "windowed" : "all"}): ${n} episodes
`
      );
    }
  } catch (e) {
    process.stderr.write(`[memory-service] startup backfill failed: ${e.message}
`);
  }
}
var _rebuildLock = false;
var cycle1Config = mainConfig?.cycle1 ?? {};
var cycle1IntervalStr = cycle1Config.interval || "5m";
var cycle1Ms = parseInterval(cycle1IntervalStr);
var cycle2IntervalStr = mainConfig?.cycle2?.interval || "1h";
var cycle2Ms = parseInterval(cycle2IntervalStr);
function getCycleLastRun() {
  try {
    const state = JSON.parse(fs2.readFileSync(path2.join(DATA_DIR, "memory-cycle.json"), "utf8"));
    return {
      cycle1: Number(state?.lastCycle1At) || 0,
      cycle2: Number(state?.lastSleepAt) || 0
    };
  } catch {
    return { cycle1: 0, cycle2: 0 };
  }
}
async function checkCycles(options = {}) {
  if (_rebuildLock) return;
  if (mainConfig?.enabled === false) return;
  const startup = options.startup === true;
  const now = Date.now();
  const last = getCycleLastRun();
  const pendingCandidates = getPendingCandidateCount();
  const pendingEmbeds = getPendingEmbedCount();
  const cycle1Due = now - last.cycle1 >= cycle1Ms;
  const cycle2Due = now - last.cycle2 >= cycle2Ms;
  if (startup ? shouldRunCycleCatchUp("cycle1", opsPolicy, {
    due: cycle1Due,
    lastRunAt: last.cycle1 || null,
    pendingCandidates,
    pendingEmbeds
  }) : cycle1Due) {
    try {
      const result = await runCycle1(WORKSPACE_PATH, mainConfig, { maxItems: 50, maxAgeDays: 1 });
      process.stderr.write(
        `[cycle1] completed at ${localNow()}${startup ? " [startup-catchup]" : ""} extracted=${Number(result?.extracted ?? 0)} classifications=${Number(result?.classifications ?? 0)}
`
      );
    } catch (e) {
      process.stderr.write(`[cycle1] error: ${e.message}
`);
    }
  }
  if (startup ? shouldRunCycleCatchUp("cycle2", opsPolicy, {
    due: cycle2Due,
    lastRunAt: last.cycle2 || null,
    pendingCandidates
  }) : cycle2Due) {
    try {
      await sleepCycle(WORKSPACE_PATH);
      process.stderr.write(`[cycle2] completed at ${localNow()}${startup ? " [startup-catchup]" : ""}
`);
    } catch (e) {
      process.stderr.write(`[cycle2] error: ${e.message}
`);
    }
  }
}
setInterval(() => {
  void checkCycles();
}, opsPolicy.scheduler.checkIntervalMs);
var startupDelayMs = Math.max(
  Number(opsPolicy.startup.cycle1CatchUp.delayMs ?? 0),
  Number(opsPolicy.startup.cycle2CatchUp.delayMs ?? 0)
);
setTimeout(() => {
  void checkCycles({ startup: true });
}, startupDelayMs);
var serverStartedAt = localNow();
{
  let isWatchable = function(relOrBase) {
    const base = path2.basename(relOrBase);
    if (!base.endsWith(".jsonl") || base.startsWith("agent-")) return false;
    if (relOrBase.includes("tmp") || relOrBase.includes("cache") || relOrBase.includes("plugins")) return false;
    return true;
  }, ingestOne = function(fp) {
    try {
      if (!fs2.existsSync(fp)) return;
      const mtime = fs2.statSync(fp).mtimeMs;
      const prev = watchedFiles.get(fp);
      if (prev && prev >= mtime) return;
      watchedFiles.set(fp, mtime);
      const n = store.ingestTranscriptFile(fp);
      if (n > 0) {
        process.stderr.write(`[transcript-watch] ingested ${n} episodes from ${path2.basename(fp)}
`);
      }
    } catch (e) {
      process.stderr.write(`[transcript-watch] ingest error: ${e.message}
`);
    }
  }, scheduleIngest = function(fp) {
    const existing = pendingByFile.get(fp);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pendingByFile.delete(fp);
      ingestOne(fp);
    }, DEBOUNCE_MS);
    pendingByFile.set(fp, timer);
  }, discoverActiveTranscripts = function() {
    try {
      if (!fs2.existsSync(projectsRoot)) return [];
      const files = [];
      for (const d of fs2.readdirSync(projectsRoot)) {
        if (d.includes("tmp") || d.includes("cache") || d.includes("plugins")) continue;
        const full = path2.join(projectsRoot, d);
        try {
          for (const f of fs2.readdirSync(full)) {
            if (!f.endsWith(".jsonl") || f.startsWith("agent-")) continue;
            const fp = path2.join(full, f);
            const mtime = fs2.statSync(fp).mtimeMs;
            files.push({ path: fp, mtime });
          }
        } catch {
        }
      }
      const cutoff = Date.now() - 30 * 6e4;
      return files.filter((f) => f.mtime > cutoff);
    } catch {
      return [];
    }
  }, safetySweep = function() {
    try {
      const active2 = discoverActiveTranscripts();
      for (const { path: fp } of active2) ingestOne(fp);
    } catch (e) {
      process.stderr.write(`[transcript-watch] safety sweep error: ${e.message}
`);
    }
  };
  const projectsRoot = path2.join(os.homedir(), ".claude", "projects");
  const SAFETY_POLL_MS = 5 * 6e4;
  const DEBOUNCE_MS = 500;
  const watchedFiles = /* @__PURE__ */ new Map();
  const pendingByFile = /* @__PURE__ */ new Map();
  setTimeout(safetySweep, 3e3);
  setInterval(safetySweep, SAFETY_POLL_MS);
  try {
    const watcher = fs2.watch(projectsRoot, { recursive: true, persistent: true }, (_event, filename) => {
      if (!filename) return;
      if (!isWatchable(filename)) return;
      const fp = path2.join(projectsRoot, filename);
      scheduleIngest(fp);
    });
    watcher.on("error", (err) => {
      process.stderr.write(`[transcript-watch] fs.watch error: ${err.message}
`);
    });
    process.stderr.write(`[transcript-watch] fs.watch active on ${projectsRoot} (safety sweep every ${SAFETY_POLL_MS / 6e4}min)
`);
  } catch (e) {
    process.stderr.write(`[transcript-watch] fs.watch setup failed: ${e.message} \u2014 relying on safety sweep only
`);
  }
}
try {
  const legacyResult = store.db.prepare("DELETE FROM memory_candidates WHERE status='consolidated'").run();
  const deleted = Number(legacyResult.changes ?? 0);
  if (deleted > 0) {
    process.stderr.write(`[migration] purged ${deleted} legacy consolidated candidates
`);
    try {
      store.db.exec("VACUUM");
      process.stderr.write(`[migration] VACUUM complete
`);
    } catch (ve) {
      process.stderr.write(`[migration] VACUUM skipped: ${ve.message}
`);
    }
  }
} catch (e) {
  process.stderr.write(`[migration] error: ${e.message}
`);
}
try {
  const synced = store.syncChunksFromClassifications();
  if (synced > 0) process.stderr.write(`[memory-service] synced ${synced} chunks from classifications
`);
} catch (e) {
  process.stderr.write(`[memory-service] chunk sync error: ${e.message}
`);
}
try {
  fs2.mkdirSync(path2.join(DATA_DIR, "history"), { recursive: true });
  store.writeContextFile();
  store.writeRecentFile({ serverStartedAt });
  process.stderr.write(`[memory-service] context.md refreshed on startup
`);
} catch (e) {
  process.stderr.write(`[memory-service] context.md refresh failed: ${e.message}
`);
}
function parsePeriod(period, hasQuery) {
  if (!period && hasQuery) period = "30d";
  if (!period) return null;
  if (period === "all") return null;
  if (period === "last") return { mode: "last" };
  const relMatch = period.match(/^(\d+)(h|d)$/);
  if (relMatch) {
    const n = parseInt(relMatch[1]);
    const unit = relMatch[2];
    const now = /* @__PURE__ */ new Date();
    if (unit === "h") {
      const start2 = new Date(now.getTime() - n * 36e5);
      return { start: fmt2(start2), end: fmt2(now) };
    }
    const start = new Date(now);
    start.setDate(start.getDate() - n);
    return { start: fmt2(start), end: fmt2(now) };
  }
  const rangeMatch = period.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/);
  if (rangeMatch) return { start: rangeMatch[1], end: rangeMatch[2] };
  const dateMatch = period.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateMatch) return { start: dateMatch[1], end: dateMatch[1], exact: true };
  return null;
}
function fmt2(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
async function handleGrep(query, options) {
  const { sort, offset, limit, temporal: searchTemporal } = options;
  const queryVector = await embedText(query);
  const skipReranker = sort === "date";
  const results = await store.searchRelevantHybrid(query, limit * 2, {
    temporal: searchTemporal,
    recordRetrieval: true,
    queryVector,
    skipReranker
  });
  const PRECISION_FLOOR = 0.65;
  const crossChecked = [];
  for (const r of results) {
    if (r.type === "classification" || r.type === "chunk") {
      crossChecked.push(r);
      continue;
    }
    if (r.type !== "episode" || !queryVector?.length) {
      crossChecked.push(r);
      continue;
    }
    try {
      let epVec = null;
      if (r.vector_json) {
        epVec = JSON.parse(r.vector_json);
      } else {
        epVec = await store.getStoredVector("episode", Number(r.entity_id), String(r.content || "").slice(0, 768));
      }
      if (!Array.isArray(epVec) || epVec.length !== queryVector.length) {
        crossChecked.push(r);
        continue;
      }
      const sim = cosineSimilarity(queryVector, epVec);
      if (sim >= PRECISION_FLOOR) crossChecked.push(r);
    } catch (e) {
      crossChecked.push(r);
    }
  }
  let items = crossChecked;
  if (sort === "importance") {
    const { computeImportanceScore: computeImportanceScore2 } = await Promise.resolve().then(() => (init_memory_score_utils(), memory_score_utils_exports));
    for (const item of items) {
      if (item.type === "chunk" && item.chunk_episode_id && !item.confidence) {
        try {
          const cls = store.db.prepare(
            `SELECT confidence, retrieval_count FROM classifications WHERE episode_id = ? AND status = 'active' ORDER BY confidence DESC LIMIT 1`
          ).get(item.chunk_episode_id);
          if (cls) {
            item.confidence = cls.confidence;
            item.retrieval_count = cls.retrieval_count;
          }
        } catch {
        }
      }
    }
    items.sort((a, b) => computeImportanceScore2(b) - computeImportanceScore2(a));
  } else if (sort === "date") {
    items.sort((a, b) => {
      const tsA = a.source_ts || a.updated_at || "";
      const tsB = b.source_ts || b.updated_at || "";
      return tsB.localeCompare(tsA);
    });
  }
  items = items.slice(offset, offset + limit);
  const SEMANTIC_WINDOW = 5;
  const SEMANTIC_FLOOR = 0.5;
  const NEIGHBORS_PER_HIT = 3;
  const hitIds = new Set(items.filter((i) => i.type === "episode").map((i) => Number(i.entity_id)));
  const lines = [];
  for (const item of items) {
    if (item.type === "chunk") {
      const ts = String(item.source_ts || item.updated_at || "").slice(0, 16);
      const topic = item.classification_topic ? ` [${item.classification_topic}]` : "";
      lines.push(`[${ts}]${topic} ${String(item.content || "").slice(0, 200)}`);
    }
  }
  for (const item of items) {
    if (item.type === "classification") {
      const ts = String(item.source_ts || item.updated_at || "").slice(0, 16);
      lines.push(`[${ts}] ${String(item.content || "").slice(0, 200)}`);
    }
  }
  if (hitIds.size > 0) {
    const hitVectors = /* @__PURE__ */ new Map();
    for (const id of hitIds) {
      try {
        const row = store.db.prepare("SELECT content FROM episodes WHERE id = ?").get(id);
        if (row?.content) {
          const vec = await store.getStoredVector("episode", id, row.content);
          if (vec?.length > 0) hitVectors.set(id, vec);
        }
      } catch {
      }
    }
    const included = /* @__PURE__ */ new Map();
    for (const id of hitIds) {
      included.set(id, { sim: 1, hitId: id });
    }
    for (const [hitId, hitVec] of hitVectors) {
      const window = store.db.prepare(`
        SELECT id, content FROM episodes
        WHERE id BETWEEN ? AND ? AND kind IN ('message', 'turn') AND id != ?
        ORDER BY id ASC
      `).all(hitId - SEMANTIC_WINDOW, hitId + SEMANTIC_WINDOW, hitId);
      const scored = [];
      for (const ep of window) {
        if (hitIds.has(ep.id)) continue;
        try {
          const epVec = await store.getStoredVector("episode", ep.id, ep.content);
          if (!epVec?.length) continue;
          const sim = cosineSimilarity(hitVec, epVec);
          if (sim >= SEMANTIC_FLOOR) scored.push({ id: ep.id, sim });
        } catch {
        }
      }
      scored.sort((a, b) => b.sim - a.sim);
      for (const pick of scored.slice(0, NEIGHBORS_PER_HIT)) {
        const existing = included.get(pick.id);
        if (!existing || pick.sim > existing.sim) {
          included.set(pick.id, { sim: pick.sim, hitId });
        }
      }
    }
    const sortedIds = [...included.keys()].sort((a, b) => a - b);
    const chunks = [];
    let chunk = [sortedIds[0]];
    for (let i = 1; i < sortedIds.length; i++) {
      if (sortedIds[i] - sortedIds[i - 1] <= 1) {
        chunk.push(sortedIds[i]);
      } else {
        chunks.push(chunk);
        chunk = [sortedIds[i]];
      }
    }
    if (chunk.length) chunks.push(chunk);
    for (const chunkIds of chunks) {
      try {
        const rows = store.db.prepare(`
          SELECT id, ts, role, content FROM episodes
          WHERE id BETWEEN ? AND ? AND kind IN ('message', 'turn')
          ORDER BY id ASC
        `).all(chunkIds[0], chunkIds[chunkIds.length - 1]);
        if (rows.length === 0) continue;
        const filtered = rows.filter((r) => included.has(Number(r.id)));
        if (filtered.length === 0) continue;
        const tsStart = String(filtered[0].ts || "").slice(0, 16);
        const tsEnd = String(filtered[filtered.length - 1].ts || "").slice(0, 16);
        const chunkHits = filtered.filter((r) => hitIds.has(Number(r.id))).length;
        lines.push(`
[${tsStart}~${tsEnd}] ${chunkHits} hit(s)`);
        for (const ep of filtered) {
          const prefix = ep.role === "user" ? "u" : "a";
          const marker = hitIds.has(Number(ep.id)) ? "\u2192" : " ";
          lines.push(`${marker} ${prefix}: ${String(ep.content || "").slice(0, 200)}`);
        }
      } catch {
      }
    }
  }
  if (hitIds.size === 0 && lines.length === 0) {
    for (const item of items) {
      const ts = String(item.source_ts || item.updated_at || "").slice(0, 16);
      lines.push(`[${ts}] ${String(item.content || "").slice(0, 200)}`);
    }
  }
  return { text: lines.join("\n") || "(no results)" };
}
async function handleRead(options) {
  const { offset, limit, sort, temporal } = options;
  let whereClause = "kind IN ('message', 'turn')";
  const params = [];
  if (temporal?.mode === "last") {
  } else if (temporal?.start) {
    if (temporal.end && temporal.end !== temporal.start) {
      whereClause += " AND ts >= ? AND ts < date(?, '+1 day')";
      params.push(temporal.start, temporal.end);
    } else {
      whereClause += " AND ts >= ? AND ts < date(?, '+1 day')";
      params.push(temporal.start, temporal.start);
    }
  }
  if (sort === "importance") {
    const halfLimit = Math.ceil(limit / 2);
    let classWhereDate = "";
    const classParams = [];
    if (temporal?.start && temporal.mode !== "last") {
      classWhereDate = " AND day_key >= ? AND day_key <= ?";
      classParams.push(temporal.start, temporal.end ?? temporal.start);
    }
    const classifications = store.db.prepare(`
      SELECT 'classification' AS type, classification AS subtype,
             trim(classification || ' | ' || topic || ' | ' || element || CASE WHEN state IS NOT NULL AND state != '' THEN ' | ' || state ELSE '' END) AS content,
             confidence, retrieval_count, updated_at
      FROM classifications
      WHERE status = 'active'${classWhereDate}
      ORDER BY (CAST(confidence AS REAL) + CAST(COALESCE(retrieval_count, 0) AS REAL) * 0.1) DESC
      LIMIT ? OFFSET ?
    `).all(...classParams, halfLimit, offset);
    const episodeLimit = Math.max(1, limit - classifications.length);
    const episodes2 = store.db.prepare(`
      SELECT ts, role, content FROM episodes
      WHERE ${whereClause}
      ORDER BY ts DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, episodeLimit, offset);
    const lines2 = [];
    for (const c of classifications) {
      const ts = String(c.updated_at || "").slice(0, 10);
      lines2.push(`[${ts}] ${String(c.content || "").slice(0, 200)}`);
    }
    for (const ep of episodes2) {
      const prefix = ep.role === "user" ? "u" : "a";
      lines2.push(`[${String(ep.ts || "").slice(0, 16)}] ${prefix}: ${String(ep.content).slice(0, 200)}`);
    }
    return { text: lines2.join("\n") || "(no results found)" };
  }
  const episodes = store.db.prepare(`
    SELECT ts, role, content FROM episodes
    WHERE ${whereClause}
    ORDER BY ts DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const lines = episodes.map((ep) => {
    const prefix = ep.role === "user" ? "u" : "a";
    return `[${String(ep.ts || "").slice(0, 16)}] ${prefix}: ${String(ep.content).slice(0, 200)}`;
  });
  return { text: lines.join("\n") || "(no episodes found)" };
}
function handleTagQuery(tag, limit = 20) {
  const rows = store.db.prepare(`
    SELECT topic, element, importance, updated_at FROM classifications
    WHERE status = 'active' AND importance LIKE ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(`%${tag}%`, limit);
  if (rows.length === 0) return { text: `(no ${tag} classifications found)` };
  const lines = rows.map((r) => {
    const date = String(r.updated_at || "").slice(0, 10);
    return `[${date}] ${r.topic} \u2014 ${r.element}`;
  });
  return { text: `${tag} (${rows.length}):
${lines.join("\n")}` };
}
function handleStats() {
  const episodes = store.db.prepare("SELECT COUNT(*) as c FROM episodes").get().c;
  const classifications = store.db.prepare("SELECT COUNT(*) as c FROM classifications").get().c;
  const pending = store.db.prepare("SELECT COUNT(*) as c FROM memory_candidates WHERE status='pending'").get().c;
  const tags = store.db.prepare(`
    SELECT importance, COUNT(*) as c FROM classifications
    WHERE importance IS NOT NULL AND importance != ''
    GROUP BY importance ORDER BY c DESC
  `).all();
  const embeds = store.db.prepare("SELECT COUNT(*) as c FROM pending_embeds").get().c;
  const lastCycle = (() => {
    try {
      const state = JSON.parse(fs2.readFileSync(path2.join(DATA_DIR, "memory-cycle.json"), "utf8"));
      const ago = Date.now() - (state.lastCycle1At || 0);
      return `${Math.round(ago / 6e4)}m ago`;
    } catch {
      return "unknown";
    }
  })();
  const lines = [
    `episodes: ${episodes}`,
    `classifications: ${classifications} (${tags.map((t) => `${t.importance}:${t.c}`).join(", ")})`,
    `candidates: pending=${pending}`,
    `pending_embeds: ${embeds}`,
    `last_cycle1: ${lastCycle}`
  ];
  return { text: lines.join("\n") };
}
async function handleRecall(args) {
  const query = String(args.query ?? "").trim();
  const period = String(args.period ?? "").trim() || void 0;
  const explicitSort = args.sort != null ? String(args.sort) : null;
  const offset = Math.max(0, Number(args.offset ?? 0));
  const limit = Math.max(1, Number(args.limit ?? 20));
  if (query === "stats") return handleStats();
  if (query === "rules") return handleTagQuery("rule", limit);
  if (query === "decisions") return handleTagQuery("decision", limit);
  if (query === "goals") return handleTagQuery("goal", limit);
  if (query === "preferences") return handleTagQuery("preference", limit);
  if (query === "incidents") return handleTagQuery("incident", limit);
  if (query === "directives") return handleTagQuery("directive", limit);
  const temporal = parsePeriod(period, Boolean(query));
  const sort = explicitSort ?? (temporal?.mode === "last" ? "date" : "importance");
  if (query) {
    const searchTemporal = temporal ? temporal.mode === "last" ? null : { start: temporal.start, end: temporal.end, exact: temporal.exact } : null;
    return handleGrep(query, { sort, offset, limit, temporal: searchTemporal });
  }
  return handleRead({ offset, limit, sort, temporal: temporal ?? { mode: "last" } });
}
async function handleCycle(args) {
  const action = String(args.action ?? "");
  const ws = WORKSPACE_PATH;
  const config = readMainConfig();
  if (action === "status") {
    return { text: JSON.stringify(getCycleStatus(), null, 2) };
  }
  if (action === "sleep") {
    await sleepCycle(ws);
    return { text: "Memory cycle completed." };
  }
  if (action === "flush") {
    await memoryFlush(ws, { maxDays: Number(args.maxDays ?? 1) });
    return { text: "Memory flush completed." };
  }
  if (action === "rebuild") {
    _rebuildLock = true;
    try {
      const maxDays = Number(args.maxDays ?? 2);
      const window = args.window || void 0;
      await rebuildRecent(ws, { maxDays, window });
      store.syncChunksFromClassifications();
      store.writeRecentFile({ serverStartedAt });
      return { text: `Memory rebuild completed (maxDays=${maxDays}).` };
    } finally {
      _rebuildLock = false;
    }
  }
  if (action === "prune") {
    await pruneToRecent(ws, { maxDays: Number(args.maxDays ?? 5) });
    return { text: "Memory prune completed." };
  }
  if (action === "cycle1") {
    const force = Boolean(args.force);
    const maxItems = args.maxItems ? Number(args.maxItems) : void 0;
    const maxAgeDays = args.maxAgeDays ? Number(args.maxAgeDays) : void 0;
    const c1result = await runCycle1(ws, config, { force, maxItems, maxAgeDays });
    return { text: `Cycle1 completed: extracted=${Number(c1result?.extracted ?? 0)} classifications=${Number(c1result?.classifications ?? 0)}` };
  }
  if (action === "rebuild_classifications") {
    const maxAgeDays = args.maxAgeDays ? Number(args.maxAgeDays) : void 0;
    const window = args.window || void 0;
    const result = await rebuildClassifications(ws, { maxAgeDays, window });
    return { text: `Rebuild classifications completed: total=${result.total} batches=${result.batches} classifications=${result.classifications}` };
  }
  if (action === "backfill") {
    const backfillLimit = Math.max(1, Math.min(Number(args.limit ?? 100), 500));
    const uncovered = store.db.prepare(`
      SELECT e.id, e.ts, e.day_key, e.role, e.content
      FROM episodes e
      LEFT JOIN memory_candidates mc ON mc.episode_id = e.id
      WHERE mc.id IS NULL
        AND e.kind IN ('message', 'turn')
        AND e.role IN ('user', 'assistant')
        AND LENGTH(e.content) >= 10
        AND e.content NOT LIKE 'You are consolidating%'
        AND e.content NOT LIKE 'You are improving%'
      ORDER BY e.ts DESC
      LIMIT ?
    `).all(backfillLimit);
    if (uncovered.length === 0) {
      return { text: "Backfill: no uncovered episodes found." };
    }
    let created = 0;
    for (const ep of uncovered) {
      try {
        store.db.prepare(`
          INSERT OR IGNORE INTO memory_candidates (episode_id, ts, day_key, role, content, score, status)
          VALUES (?, ?, ?, ?, ?, 0, 'pending')
        `).run(ep.id, ep.ts, ep.day_key, ep.role, ep.content);
        created++;
      } catch {
      }
    }
    const c1result = await runCycle1(ws, config, { force: true });
    return { text: `Backfill: ${created} candidates created from ${uncovered.length} episodes. Cycle1: ${JSON.stringify(c1result)}` };
  }
  return { text: `unknown memory action: ${action}`, isError: true };
}
var MEMORY_INSTRUCTIONS = "Recall naturally, like remembering \u2014 use search_memories() to recall.";
var mcp = new Server(
  { name: "trib-memory", version: "0.0.18" },
  { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS }
);
var TOOL_DEFS = [
  {
    name: "memory_cycle",
    title: "Memory Cycle",
    annotations: { title: "Memory Cycle", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Run memory management operations: sleep (merged update), flush (consolidate pending), rebuild (recent), prune (cleanup), cycle1 (fast update), backfill (create candidates for old episodes then run cycle1), status.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["sleep", "flush", "rebuild", "rebuild_classifications", "prune", "cycle1", "backfill", "status"], description: "Memory operation to run" },
        maxDays: { type: "number", description: "Max days to process (default varies by action)" },
        window: { type: "string", description: "Time window for rebuild/rebuild_classifications: 1d, 3d, 7d, 30d, all" },
        limit: { type: "number", description: "Max episodes to backfill (default 100)" }
      },
      required: ["action"]
    }
  },
  {
    name: "search_memories",
    title: "Search Memories",
    annotations: { title: "Search Memories", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Search and retrieve memory. With query: semantic search. Without query: browse recent episodes. Special queries: "stats", "rules", "decisions", "goals", "preferences", "incidents", "directives".',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text. Triggers semantic hybrid search." },
        period: { type: "string", description: 'Time scope: "last" (previous session), "24h"/"3d"/"7d"/"30d" (relative), "all" (no limit), "2026-04-05" (single date), "2026-04-01~2026-04-05" (date range). Default: 30d when query is set, latest entries when no query.' },
        sort: { type: "string", enum: ["date", "importance"], description: 'Sort order: "date" (newest first, reranker skipped) or "importance" (final score, reranker enabled). Default: "date" when period="last", "importance" otherwise.' },
        limit: { type: "number", default: 20, description: "Max results to return." },
        offset: { type: "number", default: 0, description: "Skip N results for pagination." }
      },
      required: []
    }
  }
];
async function handleToolCall(req) {
  const toolName = req.params.name;
  const args = req.params.arguments ?? {};
  try {
    if (toolName === "search_memories") {
      const result = await handleRecall(args);
      return {
        content: [{ type: "text", text: result.text }],
        isError: result.isError || false
      };
    }
    if (toolName === "memory_cycle") {
      const result = await handleCycle(args);
      return {
        content: [{ type: "text", text: result.text }],
        isError: result.isError || false
      };
    }
    return {
      content: [{ type: "text", text: `unknown tool: ${toolName}` }],
      isError: true
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `${toolName} failed: ${msg}` }],
      isError: true
    };
  }
}
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
mcp.setRequestHandler(CallToolRequestSchema, handleToolCall);
function createHttpMcpServer() {
  const s = new Server(
    { name: "trib-memory", version: "0.0.18" },
    { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS }
  );
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
  s.setRequestHandler(CallToolRequestSchema, handleToolCall);
  return s;
}
function readBody(req) {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve2(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve2({});
      }
    });
    req.on("error", reject);
  });
}
function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data, null, 0);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}
function sendError(res, msg, status = 500) {
  sendJson(res, { error: msg }, status);
}
var httpServer = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    try {
      const episodeCount = store.countEpisodes();
      const classificationCount = store.db.prepare("SELECT COUNT(*) AS n FROM classifications WHERE status = ?").get("active")?.n ?? 0;
      sendJson(res, { status: "ok", episodeCount, classificationCount });
    } catch (e) {
      sendError(res, e.message);
    }
    return;
  }
  if (req.url === "/mcp") {
    try {
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
        const body2 = await readBody(req);
        await httpTransport.handleRequest(req, res, body2);
      } else if (req.method === "GET") {
        sendJson(res, { error: "SSE not supported in stateless mode" }, 405);
      } else if (req.method === "DELETE") {
        sendJson(res, { error: "No session management in stateless mode" }, 405);
      } else {
        sendJson(res, { error: "Method not allowed" }, 405);
      }
    } catch (e) {
      process.stderr.write(`[memory-service] /mcp error: ${e.stack || e.message}
`);
      if (!res.headersSent) sendError(res, e.message);
    }
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/hints")) {
    const url = new URL(req.url, "http://localhost");
    const q = url.searchParams.get("q") || "";
    if (!q || q.length < 3) {
      sendJson(res, { hints: "" });
      return;
    }
    try {
      const ctx = await store.buildInboundMemoryContext(q, { skipLowSignal: true, serverStartedAt });
      sendJson(res, { hints: ctx || "" });
    } catch {
      sendJson(res, { hints: "" });
    }
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, { error: "Method not allowed" }, 405);
    return;
  }
  const body = await readBody(req);
  try {
    if (req.url === "/hints") {
      const q = String(body.query ?? "").trim();
      if (!q || q.length < 3) {
        sendJson(res, { hints: "" });
        return;
      }
      const ctx = await store.buildInboundMemoryContext(q, { ...body.options ?? { skipLowSignal: true }, serverStartedAt });
      sendJson(res, { hints: ctx || "" });
      return;
    }
    if (req.url === "/episode") {
      const id = store.appendEpisode({
        ts: body.ts || localNow(),
        backend: body.backend || "trib-memory",
        channelId: body.channelId || null,
        userId: body.userId || null,
        userName: body.userName || null,
        sessionId: body.sessionId || null,
        role: body.role || "user",
        kind: body.kind || "message",
        content: body.content || "",
        sourceRef: body.sourceRef || null
      });
      sendJson(res, { ok: true, id });
      return;
    }
    if (req.url === "/context") {
      store.writeContextFile();
      sendJson(res, { ok: true });
      return;
    }
    if (req.url === "/ingest-transcript") {
      const filePath = body.filePath;
      if (!filePath) {
        sendJson(res, { error: "filePath required" }, 400);
        return;
      }
      try {
        store.ingestTranscriptFile(filePath);
        sendJson(res, { ok: true });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
      return;
    }
    sendJson(res, { error: "Not found" }, 404);
  } catch (e) {
    process.stderr.write(`[memory-service] ${req.url} error: ${e.stack || e.message}
`);
    sendError(res, e.message);
  }
});
function writePortFile(port) {
  const dir = path2.dirname(PORT_FILE);
  try {
    fs2.mkdirSync(dir, { recursive: true });
  } catch {
  }
  fs2.writeFileSync(PORT_FILE, String(port));
}
function removePortFile() {
  try {
    fs2.unlinkSync(PORT_FILE);
  } catch {
  }
}
var activePort = BASE_PORT;
function tryListen() {
  httpServer.listen(activePort, "127.0.0.1", () => {
    writePortFile(activePort);
    process.stderr.write(`[memory-service] HTTP listening on 127.0.0.1:${activePort}
`);
  });
}
httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE" && activePort < MAX_PORT) {
    activePort++;
    tryListen();
  } else {
    process.stderr.write(`[memory-service] HTTP fatal: ${err.message}
`);
    process.exit(1);
  }
});
tryListen();
var transport = new StdioServerTransport();
await mcp.connect(transport);
process.stderr.write("[memory-service] MCP stdio connected\n");
function shutdown() {
  process.stderr.write("[memory-service] shutting down...\n");
  void stopLlmWorker().catch(() => {
  });
  removePortFile();
  void mcp.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3e3);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
