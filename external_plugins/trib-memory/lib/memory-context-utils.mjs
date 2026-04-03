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
  if (type === 'classification') {
    const topic = item?.topic || ''
    const element = item?.element || ''
    const text = [topic, element].filter(Boolean).join(' — ')
    return text ? `- ${text}` : ''
  }
  const raw = String(overrides.text ?? item?.content ?? item?.text ?? item?.value ?? '')
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, 200)
  return text ? `- ${text}` : ''
}
