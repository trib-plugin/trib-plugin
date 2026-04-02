import { cleanMemoryText } from './memory-extraction.mjs'

export function parseTemporalHint(query) {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const localDate = (value) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  const today = localDate(now)
  const daysAgo = (n) => {
    const value = new Date(now)
    value.setDate(value.getDate() - n)
    return localDate(value)
  }
  const weekdayOffset = (now.getDay() + 6) % 7
  const nDaysAgoMatch = query.match(/\b(\d+)\s+days?\s+ago\b/i)
  if (nDaysAgoMatch) {
    const days = Number(nDaysAgoMatch[1])
    if (days > 0) return { start: daysAgo(days), end: daysAgo(days), exact: true }
  }
  const koreanNDaysAgoMatch = query.match(/(\d+)\s*일\s*전/)
  if (koreanNDaysAgoMatch) {
    const days = Number(koreanNDaysAgoMatch[1])
    if (days > 0) return { start: daysAgo(days), end: daysAgo(days), exact: true }
  }
  if (/yesterday/i.test(query)) return { start: daysAgo(1), end: daysAgo(1), exact: true }
  if (/two days ago|day before yesterday/i.test(query)) return { start: daysAgo(2), end: daysAgo(2), exact: true }
  if (/last\s*week/i.test(query)) return { start: daysAgo(7), end: daysAgo(1) }
  if (/this[-_\s]*week/i.test(query)) return { start: daysAgo(weekdayOffset), end: today }
  if (/today/i.test(query)) return { start: today, end: today }
  if (/recently/i.test(query)) return { start: daysAgo(3), end: today, exact: false }
  if (/어제/.test(query)) return { start: daysAgo(1), end: daysAgo(1), exact: true }
  if (/그저께|이틀 전/.test(query)) return { start: daysAgo(2), end: daysAgo(2), exact: true }
  if (/오늘/.test(query)) return { start: today, end: today, exact: true }
  if (/이번 ?주/.test(query)) return { start: daysAgo(weekdayOffset), end: today, exact: false }
  if (/지난 ?주/.test(query)) return { start: daysAgo(7), end: daysAgo(1), exact: false }
  if (/최근|요즘/.test(query)) return { start: daysAgo(3), end: today, exact: false }
  if (/방금|아까|조금 ?전/.test(query)) return { start: today, end: today, exact: false }
  if (/엊그제|엊그저께/.test(query)) return { start: daysAgo(3), end: daysAgo(2), exact: false }

  // 한국어 요일: "지난 수요일", "이번 금요일"
  const weekdayMap = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 }
  const korWeekdayMatch = query.match(/지난\s*([일월화수목금토])요일/)
  if (korWeekdayMatch) {
    const target = weekdayMap[korWeekdayMatch[1]]
    if (target != null) {
      const diff = ((now.getDay() - target) + 7) % 7 || 7
      return { start: daysAgo(diff), end: daysAgo(diff), exact: true }
    }
  }

  // N주 전
  const weeksAgoMatch = query.match(/(\d+)\s*주\s*전/)
  if (weeksAgoMatch) {
    const weeks = Number(weeksAgoMatch[1])
    if (weeks > 0) return { start: daysAgo(weeks * 7 + 6), end: daysAgo((weeks - 1) * 7), exact: false }
  }

  // ISO: 2026-04-01
  const isoDateMatch = query.match(/(\d{4})[-.](\d{2})[-.](\d{2})/)
  if (isoDateMatch) {
    const date = `${isoDateMatch[1]}-${isoDateMatch[2]}-${isoDateMatch[3]}`
    return { start: date, end: date, exact: true }
  }

  // 2026-04 (월)
  const monthMatch = query.match(/(\d{4})[-.](\d{2})(?![-.]\d{2})/)
  if (monthMatch) {
    const year = Number(monthMatch[1])
    const month = Number(monthMatch[2])
    if (month >= 1 && month <= 12) {
      const start = `${monthMatch[1]}-${monthMatch[2]}-01`
      const nextMonth = month === 12 ? new Date(year + 1, 0, 1) : new Date(year, month, 1)
      nextMonth.setDate(nextMonth.getDate() - 1)
      return { start, end: localDate(nextMonth), exact: false }
    }
  }

  // 한국어: 2026년 4월 1일
  const korFullDateMatch = query.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/)
  if (korFullDateMatch) {
    const date = `${korFullDateMatch[1]}-${pad(korFullDateMatch[2])}-${pad(korFullDateMatch[3])}`
    return { start: date, end: date, exact: true }
  }

  // 한국어: 4월 1일, 3월 30일 (연도 생략 → 올해)
  const korMonthDayMatch = query.match(/(\d{1,2})월\s*(\d{1,2})일/)
  if (korMonthDayMatch) {
    const date = `${now.getFullYear()}-${pad(korMonthDayMatch[1])}-${pad(korMonthDayMatch[2])}`
    return { start: date, end: date, exact: true }
  }

  // 슬래시: 3/30, 4/1
  const slashDateMatch = query.match(/(\d{1,2})\/(\d{1,2})/)
  if (slashDateMatch) {
    const date = `${now.getFullYear()}-${pad(slashDateMatch[1])}-${pad(slashDateMatch[2])}`
    return { start: date, end: date, exact: true }
  }

  return null
}

export function isDoneTaskQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  const explicitDone = /\b(done|completed|finished|resolved)\b/.test(clean) || /완료|끝났|끝난|끝난거/.test(query)
  const statusCue = /\bstatus\b/.test(clean) || /상태/.test(query)
  const taskCue = /\b(task|tasks|work|issue|todo|ticket|bug|fix|compatibility)\b/.test(clean) || /작업|할 일|할일|이슈|버그|수정|호환성/.test(query)
  return explicitDone || (statusCue && taskCue)
}

export function isOngoingTaskQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  const taskCue = /\b(task|tasks|work|working|project|todo|ticket|issue)\b/.test(clean) || /작업|할 일|할일|일|프로젝트/.test(query)
  const ongoingCue =
    /\b(current|currently|ongoing|still|active|in progress|right now|these days|lately|keep doing)\b/.test(clean) ||
    /현재|지금|진행 중|진행중|요즘|계속|아직|지속/.test(query)
  return taskCue && ongoingCue
}

export function isRuleQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  return /\b(rule|policy|forbidden|allowed|constraint|prompt|transcript|durable memory)\b/.test(clean) || /규칙|정책|제약|금지|허용|prompt|transcript|durable memory/.test(query)
}

export function isRelationQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  return /\b(relation|related|relationship|between|connect|connected|uses|use|depends|dependency|integrates|integrated|part of|where.*used|what.*used|role|pair|pairing|frontend|backend|client|server|boundary|ownership|integration point)\b/.test(clean)
    || /관계|연결|역할|용도|어디에 쓰|어디 쓰|의존|통합|연동|사용|짝|쌍|클라|서버|프론트|백엔드|경계|소유권|연결점/.test(query)
}

export function isHistoryQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  return /\b(history|timeline|discuss|discussion|discussed|happened|what did we discuss|summarize the discussion)\b/.test(clean)
    || /기억|타임라인|논의|대화|얘기|뭐라고 했|요약/.test(query)
}

export function getResultDayKey(item) {
  const sourceTs = String(item?.source_ts ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(sourceTs)) return sourceTs.slice(0, 10)
  const updatedAt = String(item?.updated_at ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(updatedAt)) return updatedAt.slice(0, 10)
  return ''
}

export function getExactHistoryTypePriority(item) {
  if (item?.type === 'episode') return 0
  if (item?.type === 'classification') return 1
  return 4
}

export function buildMemoryQueryPlan(query, intent, options = {}) {
  const clean = cleanMemoryText(query)
  const temporal = options.temporal ?? parseTemporalHint(clean)
  const includeDoneTasks = Boolean(options.includeDoneTasks) || isDoneTaskQuery(clean)
  const preferActiveTasks = Boolean(options.preferActiveTasks) || isOngoingTaskQuery(clean)
  const isHistoryExact = Boolean(temporal?.exact) && (intent?.primary === 'history' || intent?.primary === 'event')
  const filters = options.filters ?? {}
  const retriever = (intent?.primary === 'history' || intent?.primary === 'event') ? 'history' : 'decision'

  return {
    query: clean,
    intent,
    temporal,
    includeDoneTasks,
    preferActiveTasks,
    explicitRelationQuery: false,
    preferRelations: false,
    isHistoryExact,
    retriever,
    graphFirst: false,
    filters,
    limit: Math.max(1, Number(options.limit ?? 8)),
  }
}
