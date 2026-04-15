/**
 * embedding-provider.mjs — Embedding provider (Qwen3, local JS only).
 */

import { createRequire } from 'module'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { cpus } from 'os'
import { writeProfilePoint } from './model-profile.mjs'

const MODEL_ID = 'Xenova/bge-m3'
const DEFAULT_DIMS = 1024
const DEFAULT_DTYPE = 'q4'
const INTRA_OP_THREADS = 1
const INTER_OP_THREADS = 1
const MODEL_CACHE_DIR = join(process.env.HOME || process.env.USERPROFILE, '.cache', 'trib-memory', 'models')
const IDLE_TIMEOUT_MS = 15 * 60 * 1000

let extractorPromise = null
let cachedDims = null
let configuredDtype = DEFAULT_DTYPE
let _device = 'cpu'
let _idleTimer = null
let ortPatched = false
let _embedCallCount = 0
const EMBED_STEADY_SAMPLE_EVERY = 20
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
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null }
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

function resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer)
  _idleTimer = setTimeout(() => {
    if (extractorPromise) {
      extractorPromise.then(ext => { try { ext.dispose() } catch {} }).catch(() => {})
      extractorPromise = null
      cachedDims = null
      const prevDevice = _device
      _device = 'cpu'
      process.stderr.write('[embed] idle timeout — model disposed\n')
      writeProfilePoint({
        phase: 'post-idle',
        model: MODEL_ID,
        device: prevDevice,
        dtype: configuredDtype,
        note: 'idle dispose',
      })
    }
    _idleTimer = null
  }, IDLE_TIMEOUT_MS)
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
      // Baseline snapshot before any ONNX/transformers import land in RSS.
      writeProfilePoint({
        phase: 'baseline',
        model: MODEL_ID,
        device: _device,
        dtype: configuredDtype,
        note: 'pre-load',
      })
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
      let extractor
      const preferGpu = (process.env.TRIB_MEMORY_EMBED_DEVICE || 'auto') !== 'cpu'
      if (preferGpu) {
        try {
          extractor = await pipeline('feature-extraction', MODEL_ID, { ...opts, device: 'dml' })
          _device = 'dml'
        } catch (gpuErr) {
          process.stderr.write(`[embed] DML failed (${gpuErr.message?.slice(0, 80)}), falling back to CPU\n`)
          extractor = await pipeline('feature-extraction', MODEL_ID, { ...opts, device: 'cpu' })
          _device = 'cpu'
        }
      } else {
        extractor = await pipeline('feature-extraction', MODEL_ID, { ...opts, device: 'cpu' })
        _device = 'cpu'
      }
      const loadMs = Date.now() - startMs
      process.stderr.write(`[embed] loaded ${MODEL_ID} dtype=${configuredDtype} device=${_device} threads=${INTRA_OP_THREADS} in ${loadMs}ms\n`)
      writeProfilePoint({
        phase: 'load',
        model: MODEL_ID,
        device: _device,
        dtype: configuredDtype,
        wallMs: loadMs,
      })
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

export function getEmbeddingDevice() { return _device }

export function consumeProviderSwitchEvent() {
  return null
}

export async function warmupEmbeddingProvider() {
  const extractor = await loadExtractor()
  const t0 = Date.now()
  await extractor('warmup', { pooling: 'mean', normalize: true })
  cachedDims = DEFAULT_DIMS
  writeProfilePoint({
    phase: 'warmup',
    model: MODEL_ID,
    device: _device,
    dtype: configuredDtype,
    wallMs: Date.now() - t0,
  })
  resetIdleTimer()
  return true
}

// Force dispose the embedding extractor without waiting for the idle timer.
// Used by the --profile bench's post-idle step; regular callers continue to
// rely on `resetIdleTimer()` in `embedText()` / `warmupEmbeddingProvider()`.
export async function disposeEmbeddingProvider() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null }
  if (extractorPromise) {
    const prevDevice = _device
    try {
      const ext = await extractorPromise
      try { ext.dispose() } catch {}
    } catch {}
    extractorPromise = null
    cachedDims = null
    _device = 'cpu'
    writeProfilePoint({
      phase: 'post-idle',
      model: MODEL_ID,
      device: prevDevice,
      dtype: configuredDtype,
      note: 'forced dispose',
    })
  }
}

export async function embedText(text) {
  const clean = String(text ?? '').trim()
  if (!clean) return []
  resetIdleTimer()
  const cacheKey = `${MODEL_ID}\n${clean}`
  const cached = getCachedEmbedding(cacheKey)
  if (cached) return [...cached]

  const extractor = await loadExtractor()
  const t0 = Date.now()
  const output = await extractor(clean, { pooling: 'mean', normalize: true })
  const wallMs = Date.now() - t0
  cachedDims = output.data?.length || DEFAULT_DIMS
  const vector = Array.from(output.data ?? [])
  cacheEmbedding(cacheKey, vector)
  _embedCallCount++
  // Sampled steady-state snapshot; cheap enough to always compute but still
  // avoid flooding the JSONL with one entry per call.
  if (_embedCallCount % EMBED_STEADY_SAMPLE_EVERY === 0) {
    writeProfilePoint({
      phase: 'steady',
      model: MODEL_ID,
      device: _device,
      dtype: configuredDtype,
      wallMs,
      note: `sample@${_embedCallCount}`,
    })
  }
  return vector
}
