import { createRequire } from 'module'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { AutoTokenizer, AutoModelForSequenceClassification, env as hfEnv } from '@huggingface/transformers'

const MODEL_CACHE_DIR = join(process.env.HOME || process.env.USERPROFILE, '.cache', 'trib-memory', 'models')
const INTRA_OP_THREADS = 0
const INTER_OP_THREADS = 0
let _ortPatched = false

function patchOrtThreads() {
  if (_ortPatched) return
  try {
    const require = createRequire(import.meta.url)
    const ort = require('onnxruntime-node')
    if (!ort?.InferenceSession?.create) {
      process.stderr.write('[reranker] ORT patch skipped: InferenceSession.create not found\n')
      return
    }
    const origCreate = ort.InferenceSession.create.bind(ort.InferenceSession)
    ort.InferenceSession.create = async function (pathOrBuffer, options = {}) {
      if (!options.intraOpNumThreads) options.intraOpNumThreads = INTRA_OP_THREADS
      if (!options.interOpNumThreads) options.interOpNumThreads = INTER_OP_THREADS
      return origCreate(pathOrBuffer, options)
    }
    _ortPatched = true
    process.stderr.write(`[reranker] ORT patched OK: intra=${INTRA_OP_THREADS} inter=${INTER_OP_THREADS}\n`)
  } catch (err) {
    process.stderr.write(`[reranker] ORT patch failed: ${err?.message || err}\n`)
  }
}

let _tokenizer = null
let _model = null
let _loading = null
let _device = 'cpu'
const _scoreCache = new Map()
const SCORE_CACHE_LIMIT = 2000
const MAX_QUERY_CHARS = 192
const MAX_TEXT_CHARS = 240

const DEFAULT_MODEL_ID = 'Xenova/bge-reranker-large'

export function getRerankerModelId() {
  return process.env.TRIB_MEMORY_RERANKER_MODEL_ID || DEFAULT_MODEL_ID
}

export function getRerankerDevice() { return _device }

function normalizeRerankText(value, maxChars) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
}

function scoreCacheKey(query, text) {
  return `${getRerankerModelId()}\n${normalizeRerankText(query, MAX_QUERY_CHARS)}\n${normalizeRerankText(text, MAX_TEXT_CHARS)}`
}

function getCachedScore(query, text) {
  const key = scoreCacheKey(query, text)
  if (!_scoreCache.has(key)) return null
  const value = _scoreCache.get(key)
  _scoreCache.delete(key)
  _scoreCache.set(key, value)
  return value
}

function setCachedScore(query, text, score) {
  const key = scoreCacheKey(query, text)
  if (_scoreCache.has(key)) _scoreCache.delete(key)
  _scoreCache.set(key, score)
  if (_scoreCache.size > SCORE_CACHE_LIMIT) {
    const oldestKey = _scoreCache.keys().next().value
    if (oldestKey) _scoreCache.delete(oldestKey)
  }
}

async function ensureModel() {
  const modelId = getRerankerModelId()
  if (_model && _tokenizer) return
  if (_loading) return _loading
  _loading = (async () => {
    patchOrtThreads()
    try { mkdirSync(MODEL_CACHE_DIR, { recursive: true }) } catch {}
    hfEnv.cacheDir = MODEL_CACHE_DIR
    _tokenizer = await AutoTokenizer.from_pretrained(modelId)

    // Try GPU (DirectML on Windows, CUDA if available), fall back to CPU
    const preferGpu = (process.env.TRIB_MEMORY_RERANKER_DEVICE || 'auto') !== 'cpu'
    if (preferGpu) {
      try {
        hfEnv.backends.onnx = hfEnv.backends.onnx || {}
        hfEnv.backends.onnx.executionProviders = [{ name: 'dml' }, { name: 'cpu' }]
        _model = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: 'q4' })
        _device = 'dml'
        process.stderr.write(`[reranker] loaded ${modelId} on DirectML (GPU)\n`)
      } catch (gpuErr) {
        process.stderr.write(`[reranker] DML failed (${gpuErr.message?.slice(0, 80)}), falling back to CPU\n`)
        hfEnv.backends.onnx.executionProviders = [{ name: 'cpu' }]
        _model = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: 'q4' })
        _device = 'cpu'
        process.stderr.write(`[reranker] loaded ${modelId} on CPU\n`)
      }
    } else {
      _model = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype: 'q4' })
      _device = 'cpu'
      process.stderr.write(`[reranker] loaded ${modelId} on CPU (forced)\n`)
    }

    _loading = null
  })()
  return _loading
}

async function scoreOne(queryText, docText) {
  const inputs = _tokenizer(queryText, { text_pair: docText, truncation: true, max_length: 512 })
  const output = await _model(inputs)
  return output.logits.data[0]
}

export async function rerank(query, items, topK) {
  const limit = Math.min(Number(topK ?? 5), items.length)
  if (limit === 0) return []
  const queryText = normalizeRerankText(query, MAX_QUERY_CHARS)

  const entries = items
    .slice(0, Math.max(limit * 3, items.length))
    .map(item => ({ item, text: normalizeRerankText(item.content ?? item.text ?? '', MAX_TEXT_CHARS) }))
    .filter(entry => entry.text)
  if (entries.length === 0) return []

  await ensureModel()

  const scored = []
  for (const entry of entries) {
    const cached = getCachedScore(queryText, entry.text)
    if (cached != null) {
      scored.push({ ...entry.item, reranker_score: Number(cached) })
      continue
    }
    const score = await scoreOne(queryText, entry.text)
    setCachedScore(queryText, entry.text, score)
    scored.push({ ...entry.item, reranker_score: score })
    // yield CPU after each inference to prevent sustained 100% burst (skip on GPU)
    if (_device === 'cpu') await new Promise(r => setTimeout(r, 10))
  }

  return scored.sort((a, b) => Number(b.reranker_score) - Number(a.reranker_score)).slice(0, limit)
}

export async function disposeReranker() {
  if (_model) {
    try { await _model.dispose() } catch {}
  }
  _tokenizer = null
  _model = null
  _loading = null
  _scoreCache.clear()
}

export function isRerankerAvailable() {
  return _model !== null && _tokenizer !== null
}
