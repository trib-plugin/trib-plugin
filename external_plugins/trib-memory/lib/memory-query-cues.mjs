import { cleanMemoryText } from './memory-extraction.mjs'

export function detectOperationalIssueQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  if (!clean) return false
  return (
    /\b(channel|discord|session|resume|restore|reconnect|binding|sync|delay|lag|inbound|access config|channel id|mapping|message)\b/.test(clean) ||
    /채널|디스코드|세션|리쥼|복원|연결|바인딩|동기|지연|인바운드|채널 id|채널아이디|매핑|메세지|메시지/.test(query)
  )
}

export function detectStandaloneMemoryQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  if (!clean) return false
  return (
    (/\b(memory|trib-memory|mcp)\b/.test(clean) || /메모리|트리비메모리|trib-memory|mcp/.test(query)) &&
    (/\b(standalone|independent|separate|split|detach|alone|supported|operate|run)\b/.test(clean) || /단독|독립|분리|따로|동작가능|작동가능|가능하/.test(query))
  )
}

export function detectArchitectureQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  if (!clean) return false
  return (
    /\b(rag|memory|retrieval|injection|architecture|structure|storage|mcp|search)\b/.test(clean) ||
    /rag|메모리|검색|리트리벌|주입|아키텍처|구조|저장|mcp|서치/.test(query)
  )
}
