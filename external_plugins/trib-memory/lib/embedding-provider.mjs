/**
 * embedding-provider.mjs — Embedding provider (Qwen3, local JS only).
 */

import { createRequire } from 'module'
import { join } from 'path'
import { mkdirSync } from 'fs'

const MODEL_ID = 'Xenova/bge-m3'
const DEFAULT_DIMS = 1024
const DEFAULT_DTYPE = 'q8'
const INTRA_OP_THREADS = 0
const INTER_OP_THREADS = 0
const MODEL_CACHE_DIR = join(process.env.HOME || process.env.USERPROFILE, '.cache', 'trib-memory', 'models')

let extractorPromise = null
let cachedDims = null
let configuredDtype = DEFAULT_DTYPE
let ortPatched = false
const queryEmbeddingCache = new Map()
const QUERY_EMBEDDING_CACHE_LIMIT = 1000

function cacheEmbedding(key, vector) {
  if (queryEmbeddingCache.has(key)) queryEmbeddingCache.delete(key)
  queryEmbeddingCache.set(key, vector)
  if (queryEmbeddingCache.size > QUERY_EMBEDDING_CACHE_LIMIT) {
    const oldestKey = queryEmbeddingCache.keys().next().value
    if (oldestKey) queryEmbeddingCache.delete(oldestKey)
  }
}

function getCachedEmbedding(key) {
  if (!queryEmbeddingCache.has(key)) return null
  const value = queryEmbeddingCache.get(key)
  queryEmbeddingCache.delete(key)
  queryEmbeddingCache.set(key, value)
  return value
}

export function configureEmbedding(config = {}) {
  if (config.dtype != null) {
    const dt = String(config.dtype).trim().toLowerCase()
    configuredDtype = ['fp32', 'fp16', 'q8', 'q4'].includes(dt) ? dt : DEFAULT_DTYPE
  }
  extractorPromise = null
  cachedDims = null
  queryEmbeddingCache.clear()
}

export function clearEmbeddingCache() {
  queryEmbeddingCache.clear()
}

function patchOrtThreads() {
  if (ortPatched) return
  try {
    const require = createRequire(import.meta.url)
    const ort = require('onnxruntime-node')
    if (!ort?.InferenceSession?.create) {
      process.stderr.write('[embed] ORT patch skipped: InferenceSession.create not found\n')
      return
    }
    const origCreate = ort.InferenceSession.create.bind(ort.InferenceSession)
    ort.InferenceSession.create = async function (pathOrBuffer, options = {}) {
      if (!options.intraOpNumThreads) options.intraOpNumThreads = INTRA_OP_THREADS
      if (!options.interOpNumThreads) options.interOpNumThreads = INTER_OP_THREADS
      return origCreate(pathOrBuffer, options)
    }
    ortPatched = true
    process.stderr.write(`[embed] ORT patched OK: intra=${INTRA_OP_THREADS} inter=${INTER_OP_THREADS}\n`)
  } catch (err) {
    process.stderr.write(`[embed] ORT patch failed: ${err?.message || err}\n`)
  }
}

async function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      patchOrtThreads()
      const { pipeline, env } = await import('@huggingface/transformers')
      env.allowLocalModels = false
      try { mkdirSync(MODEL_CACHE_DIR, { recursive: true }) } catch {}
      env.cacheDir = MODEL_CACHE_DIR
      try { env.backends.onnx.wasm.numThreads = INTRA_OP_THREADS } catch {}
      const opts = {}
      if (configuredDtype && configuredDtype !== 'fp32') {
        opts.dtype = configuredDtype
      }
      const startMs = Date.now()
      const extractor = await pipeline('feature-extraction', MODEL_ID, opts)
      process.stderr.write(`[embed] loaded ${MODEL_ID} dtype=${configuredDtype} threads=${INTRA_OP_THREADS} in ${Date.now() - startMs}ms\n`)
      return extractor
    })()
  }
  return extractorPromise
}

export function getEmbeddingModelId() {
  return MODEL_ID
}

export function getEmbeddingDims() {
  return cachedDims || DEFAULT_DIMS
}

export function consumeProviderSwitchEvent() {
  return null
}

export async function warmupEmbeddingProvider() {
  const extractor = await loadExtractor()
  await extractor('warmup', { pooling: 'mean', normalize: true })
  cachedDims = DEFAULT_DIMS
  return true
}

export async function embedText(text) {
  const clean = String(text ?? '').trim()
  if (!clean) return []
  const cacheKey = `${MODEL_ID}\n${clean}`
  const cached = getCachedEmbedding(cacheKey)
  if (cached) return [...cached]

  const extractor = await loadExtractor()
  const output = await extractor(clean, { pooling: 'mean', normalize: true })
  cachedDims = output.data?.length || DEFAULT_DIMS
  const vector = Array.from(output.data ?? [])
  cacheEmbedding(cacheKey, vector)
  return vector
}
