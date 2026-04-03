import { cleanMemoryText } from './memory-extraction.mjs'

export function normalizeProfileKey(key) {
  const value = String(key ?? '').trim().toLowerCase()
  return ['language', 'tone', 'address', 'response_style', 'timezone'].includes(value) ? value : ''
}

export function shouldKeepProfileValue(key, value) {
  const clean = cleanMemoryText(value)
  if (!key || !clean) return false
  if (key === 'timezone') return clean.length <= 64
  if (clean.length > 160) return false
  if (clean.length > 48 && /\b(?:on|as of)\s+\d{4}-\d{2}-\d{2}\b/i.test(clean)) return false
  if (clean.length > 48 && /\b(requested|asked|stated|reported|mentioned|clarified)\b/i.test(clean)) return false
  if (clean.length > 48 && /(요청|지시|말씀|언급|보고|설명)/.test(clean)) return false
  return true
}

export function profileKeyForFact(factType, text = '', slot = '') {
  const combined = `${slot} ${text}`.toLowerCase()
  if (factType === 'preference' && (/\b(address|call|name|nickname)\b/.test(combined) || /호칭|이름|닉네임/.test(combined))) return 'address'
  if (factType === 'preference' && (/\b(response style|response-style|style|tone)\b/.test(combined) || /말투|어투|응답 스타일|답변 스타일/.test(combined))) return 'response_style'
  if (factType === 'constraint' && (/\btimezone|time zone|local time\b/.test(combined) || /시간대|현지 시간/.test(combined))) return 'timezone'
  return ''
}

export function profileKeyForSignal(kind, value = '') {
  const combined = `${kind} ${value}`.toLowerCase()
  if (kind === 'language' || /\bkorean|english|japanese|chinese|language\b/.test(combined) || /한국어|영어|일본어|중국어|언어/.test(combined)) return 'language'
  if (kind === 'tone' || /\btone|style|formal|respectful|casual\b/.test(combined) || /존댓말|반말|격식|말투|어투/.test(combined)) return 'tone'
  return ''
}

