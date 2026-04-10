/**
 * Shared i18n module for custom-commands.
 *
 * Supports 4 languages: en, ko, ja, zh.
 * Fallback chain: requested lang → en → key itself.
 */

export type Lang = 'en' | 'ko' | 'ja' | 'zh'

type I18nEntry = Partial<Record<Lang, string>>

/** Detect language from OS locale */
export function getLang(): Lang {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale // e.g. "ko-KR"
  const lang = locale.split('-')[0]
  if (lang === 'ko') return 'ko'
  if (lang === 'ja') return 'ja'
  if (lang === 'zh') return 'zh'
  return 'en'
}

// ── Dictionary ──────────────────────────────────────────────────────

const dict: Record<string, I18nEntry> = {
  'schedule.empty': {
    ko: 'No schedules registered.',
    en: 'No schedules configured.',
  },
  'schedule.added': {
    ko: 'Schedule "{name}" added ({mode}, {time})',
    en: 'Schedule "{name}" added ({mode}, {time})',
  },
  'schedule.exists': {
    ko: 'Schedule "{name}" already exists.',
    en: 'Schedule "{name}" already exists.',
  },
  'schedule.not_found': {
    ko: 'Schedule "{name}" not found.',
    en: 'Schedule "{name}" not found.',
  },
  'schedule.removed': {
    ko: 'Schedule "{name}" deleted.',
    en: 'Schedule "{name}" removed.',
  },
  'schedule.edited': {
    ko: 'Schedule "{name}" updated.',
    en: 'Schedule "{name}" updated.',
  },
  'schedule.triggered': {
    ko: 'Running schedule "{name}"...',
    en: 'Triggering schedule "{name}"...',
  },
  'schedule.missing_name': {
    ko: 'Schedule name required.',
    en: 'Schedule name is required.',
  },
  'schedule.missing_fields': {
    ko: 'time and channel fields are required.',
    en: 'time and channel fields are required.',
  },
  'profile.empty': {
    ko: 'No profile configured.',
    en: 'No profile configured.',
  },
  'profile.updated': {
    ko: 'Profile updated.',
    en: 'Profile updated.',
  },
  'unknown_action': {
    ko: 'Unknown command: {action}',
    en: 'Unknown action: {action}',
  },
  'unknown_sub': {
    ko: 'Unknown subcommand: {sub}',
    en: 'Unknown subcommand: {sub}',
  },
  'quiet.status': {
    ko: 'Quiet Hours',
    en: 'Quiet Settings',
  },
  'quiet.updated': {
    ko: 'Quiet hours updated.',
    en: 'Quiet settings updated.',
  },
  'activity.empty': {
    ko: 'No activity channels registered.',
    en: 'No activity channels configured.',
  },
  'activity.added': {
    ko: 'Channel "{name}" added.',
    en: 'Channel "{name}" added.',
  },
  'activity.exists': {
    ko: 'Channel "{name}" already exists.',
    en: 'Channel "{name}" already exists.',
  },
  'activity.not_found': {
    ko: 'Channel "{name}" not found.',
    en: 'Channel "{name}" not found.',
  },
  'activity.removed': {
    ko: 'Channel "{name}" deleted.',
    en: 'Channel "{name}" removed.',
  },
  'activity.missing_name': {
    ko: 'Channel name required.',
    en: 'Channel name is required.',
  },
  'activity.missing_id': {
    ko: 'Channel ID required.',
    en: 'Channel ID is required.',
  },
}

/**
 * Translate a key with variable substitution.
 * Variables use `{key}` format.
 */
export function t(key: string, lang: Lang | string, vars?: Record<string, string | number>): string {
  const resolved: Lang = (typeof lang === 'string' && (lang === 'en' || lang === 'ko' || lang === 'ja' || lang === 'zh'))
    ? lang
    : getLang()
  let text = dict[key]?.[resolved] ?? dict[key]?.en ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return text
}
