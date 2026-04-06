import { cleanMemoryText } from './memory-extraction.mjs'

export function buildHintKey(item, overrides = {}) {
  const type = overrides.type ?? item?.type ?? 'episode'
  const rawText = String(overrides.text ?? item?.content ?? item?.text ?? item?.value ?? '').trim()
  if (!rawText) return ''
  const normalized = cleanMemoryText(rawText).toLowerCase().replace(/\s+/g, ' ').slice(0, 160)
  return `${type}:${normalized}`
}

export function formatHintTag(item, overrides = {}, _options = {}) {
  const type = overrides.type ?? item?.type ?? 'episode'
  if (type === 'chunk') {
    const topic = item?.classification_topic || item?.topic || ''
    const text = String(item?.content || '').trim()
    return text ? `- ${topic ? topic + ': ' : ''}${text}` : ''
  }
  if (type === 'classification') {
    const topic = item?.topic || ''
    const element = item?.element || ''
    const text = [topic, element].filter(Boolean).join(' — ')
    return text ? `- ${text}` : ''
  }
  // For episodes: prefer linked classification data if available (cleaner summary)
  if (item?.classification_element) {
    // Use semantic chunks if available, otherwise fall back to element
    let chunks = []
    try { chunks = JSON.parse(item.classification_chunks || '[]') } catch {}
    if (chunks.length > 0) {
      const prefix = item.classification_topic ? `${item.classification_topic}: ` : ''
      return `- ${prefix}${chunks.join(' / ')}`
    }
    const prefix = item.classification_topic ? `${item.classification_topic} — ` : ''
    return `- ${prefix}${item.classification_element}`
  }
  const raw = String(overrides.text ?? item?.content ?? item?.text ?? item?.value ?? '')
  // Strip common noise prefixes from assistant messages
  let text = raw.replace(/\s+/g, ' ').trim()
  if (item?.subtype === 'assistant') {
    text = text.replace(/^(죄송합니다[.,]?\s*|알겠습니다[.,]?\s*|네[.,]\s*|바로\s+하겠습니다[.,]?\s*)+/u, '')
  }
  return text ? `- ${text.slice(0, 200)}` : ''
}
