/**
 * embedding-provider.mjs — Embedding provider (Qwen3, local JS only).
 */

const MODEL_ID = 'Xenova/bge-m3'
const DEFAULT_DIMS = 1024
const DEFAULT_DTYPE = 'q8'

let extractorPromise = null
let cachedDims = null
let configuredDtype = DEFAULT_DTYPE
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

async function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      env.allowLocalModels = false
      const opts = {}
      if (configuredDtype && configuredDtype !== 'fp32') {
        opts.dtype = configuredDtype
      }
      const startMs = Date.now()
      const extractor = await pipeline('feature-extraction', MODEL_ID, opts)
      process.stderr.write(`[embed] loaded ${MODEL_ID} dtype=${configuredDtype} in ${Date.now() - startMs}ms\n`)
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
