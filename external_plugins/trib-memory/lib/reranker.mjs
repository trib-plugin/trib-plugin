import { AutoTokenizer, AutoModelForSequenceClassification } from '@xenova/transformers'

let _tokenizer = null
let _model = null
let _loading = null
let _loadedModelId = null
const _scoreCache = new Map()
const SCORE_CACHE_LIMIT = 2000

const DEFAULT_MODEL_ID = 'Xenova/bge-reranker-large'

export function getRerankerModelId() {
  return process.env.TRIB_MEMORY_RERANKER_MODEL_ID || DEFAULT_MODEL_ID
}

function scoreCacheKey(query, text) {
  return `${getRerankerModelId()}\n${String(query)}\n${String(text)}`
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

export function clearRerankerCache() {
  _scoreCache.clear()
}

async function ensureModel() {
  const modelId = getRerankerModelId()
  if (_loadedModelId && _loadedModelId !== modelId) {
    _tokenizer = null
    _model = null
    _loading = null
    _loadedModelId = null
    clearRerankerCache()
  }
  if (_model && _tokenizer) return
  if (_loading) return _loading
  _loading = (async () => {
    _tokenizer = await AutoTokenizer.from_pretrained(modelId)
    _model = await AutoModelForSequenceClassification.from_pretrained(modelId)
    _loadedModelId = modelId
    _loading = null
  })()
  return _loading
}

export async function crossEncoderRerank(query, candidates, options = {}) {
  const limit = Math.min(Number(options.limit ?? 5), candidates.length)
  if (limit === 0) return []

  const items = candidates
    .slice(0, limit)
    .map(item => ({ item, text: String(item.content ?? item.text ?? '').slice(0, 300) }))
    .filter(entry => entry.text)
  if (items.length === 0) return []

  const scored = []
  const uncached = []
  for (const entry of items) {
    const cached = getCachedScore(query, entry.text)
    if (cached == null) {
      uncached.push(entry)
    } else {
      scored.push({
        ...entry.item,
        reranker_score: Number(cached),
      })
    }
  }

  if (uncached.length > 0) {
    await ensureModel()
    const inputs = await _tokenizer(
      new Array(uncached.length).fill(query),
      {
        text_pair: uncached.map(entry => entry.text),
        padding: true,
        truncation: true,
        max_length: 512,
      },
    )
    const output = await _model(inputs)
    const logits = Array.from(output.logits?.data ?? [])
    for (let index = 0; index < uncached.length; index += 1) {
      const entry = uncached[index]
      const score = Number(logits[index] ?? logits[0] ?? Number.NEGATIVE_INFINITY)
      setCachedScore(query, entry.text, score)
      scored.push({
        ...entry.item,
        reranker_score: score,
      })
    }
  }

  return scored.sort((a, b) => Number(b.reranker_score) - Number(a.reranker_score))
}

export function isRerankerAvailable() {
  return _model !== null && _tokenizer !== null
}

// Pre-warm on first import (non-blocking)
ensureModel().catch(() => {})
