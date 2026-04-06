import { AutoTokenizer, AutoModelForCausalLM } from '@huggingface/transformers'

let _tokenizer = null
let _model = null
let _loading = null
let _tokenYes = null
let _tokenNo = null
const _scoreCache = new Map()
const SCORE_CACHE_LIMIT = 2000
const MAX_QUERY_CHARS = 192
const MAX_TEXT_CHARS = 240

const DEFAULT_MODEL_ID = 'onnx-community/Qwen3-Reranker-0.6B-ONNX'

export function getRerankerModelId() {
  return process.env.TRIB_MEMORY_RERANKER_MODEL_ID || DEFAULT_MODEL_ID
}

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
    _tokenizer = await AutoTokenizer.from_pretrained(modelId)
    _model = await AutoModelForCausalLM.from_pretrained(modelId, {
      dtype: 'q4',
      device: 'cpu',
    })
    _tokenYes = _tokenizer.convert_tokens_to_ids('yes')
    _tokenNo = _tokenizer.convert_tokens_to_ids('no')
    _loading = null
  })()
  return _loading
}

function buildPrompt(query, document) {
  return `<|im_start|>system\nJudge whether the document is relevant to the search query. Answer only "yes" or "no".<|im_end|>\n<|im_start|>user\n<Query>: ${query}\n<Document>: ${document}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n`
}

async function scoreOne(queryText, docText) {
  const prompt = buildPrompt(queryText, docText)
  const inputs = _tokenizer(prompt, { truncation: true, max_length: 512 })
  const output = await _model(inputs)

  const seqLen = output.logits.dims[1]
  const vocabSize = output.logits.dims[2]
  const lastLogits = output.logits.data.slice(
    (seqLen - 1) * vocabSize,
    seqLen * vocabSize,
  )

  const yesScore = Math.exp(lastLogits[_tokenYes])
  const noScore = Math.exp(lastLogits[_tokenNo])
  return yesScore / (yesScore + noScore)
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
  _tokenYes = null
  _tokenNo = null
  _scoreCache.clear()
}

export function isRerankerAvailable() {
  return _model !== null && _tokenizer !== null
}
