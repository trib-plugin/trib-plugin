const DEFAULT_OPS_POLICY = {
  features: {
    reranker: true,
    temporalParser: false,
  },
  startup: {
    backfill: {
      mode: 'off',
      window: '1d',
      scope: 'all',
      limit: 80,
    },
    // Startup catch-up disabled by default: was running inline embeddings
    // ~5s after server start, causing perceptible lag right after user typed.
    // Pending work is still handled by the regular 5-min cycle1 interval.
    cycle1CatchUp: {
      mode: 'off',
      delayMs: 5000,
      minPendingCandidates: 8,
      requireDue: false,
    },
    cycle2CatchUp: {
      mode: 'off',
      delayMs: 5000,
      requireDue: true,
    },
  },
  scheduler: {
    checkIntervalMs: 60_000,
  },
}

function coercePositiveInt(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

function normalizeBackfillWindow(value) {
  const normalized = String(value ?? 'all').trim().toLowerCase()
  if (['none', 'off', 'disabled', '0'].includes(normalized)) return 'none'
  if (['1d', '1day', '1-day', '1 day', 'day', 'today'].includes(normalized)) return '1d'
  if (['3d', '3days', '3-day', '3 day'].includes(normalized)) return '3d'
  if (['7d', '7days', '7-day', '7 day', 'week'].includes(normalized)) return '7d'
  if (['30d', '30days', '30-day', '30 day', 'month'].includes(normalized)) return '30d'
  return 'all'
}

function normalizeCatchUpMode(value, fallback = 'light') {
  const normalized = String(value ?? fallback).trim().toLowerCase()
  if (['off', 'none', 'disabled'].includes(normalized)) return 'off'
  if (['full', 'all', 'aggressive'].includes(normalized)) return 'full'
  return 'light'
}

function normalizeBackfillMode(value) {
  const normalized = String(value ?? 'if-empty').trim().toLowerCase()
  if (['off', 'none', 'disabled'].includes(normalized)) return 'off'
  if (['always', 'force'].includes(normalized)) return 'always'
  return 'if-empty'
}

function normalizeBackfillScope(value) {
  const normalized = String(value ?? 'all').trim().toLowerCase()
  if (['workspace', 'project', 'current'].includes(normalized)) return 'workspace'
  return 'all'
}

function envFlag(value, fallback = false) {
  if (value == null || value === '') return fallback
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export function readMemoryOpsPolicy(mainConfig = {}) {
  const runtimeConfig = mainConfig?.runtime ?? {}
  const featuresConfig = runtimeConfig?.features ?? {}
  const startupConfig = runtimeConfig?.startup ?? {}
  const backfillConfig = mainConfig?.backfill ?? startupConfig?.backfill ?? {}
  const cycle1CatchUpConfig = startupConfig?.cycle1CatchUp ?? {}
  const cycle2CatchUpConfig = startupConfig?.cycle2CatchUp ?? {}
  const schedulerConfig = runtimeConfig?.scheduler ?? {}

  return {
    features: {
      // Opt-out: reranker defaults to true. Set `features.reranker: false`
      // explicitly to disable. Matches DEFAULT_OPS_POLICY.features.reranker=true.
      reranker: featuresConfig.reranker !== false,
      temporalParser: featuresConfig.temporalParser === true,
    },
    startup: {
      backfill: {
        mode: normalizeBackfillMode(backfillConfig.mode ?? DEFAULT_OPS_POLICY.startup.backfill.mode),
        window: normalizeBackfillWindow(backfillConfig.window ?? DEFAULT_OPS_POLICY.startup.backfill.window),
        scope: normalizeBackfillScope(backfillConfig.scope ?? DEFAULT_OPS_POLICY.startup.backfill.scope),
        limit: coercePositiveInt(backfillConfig.limit, DEFAULT_OPS_POLICY.startup.backfill.limit),
      },
      cycle1CatchUp: {
        mode: normalizeCatchUpMode(cycle1CatchUpConfig.mode, DEFAULT_OPS_POLICY.startup.cycle1CatchUp.mode),
        delayMs: coercePositiveInt(cycle1CatchUpConfig.delayMs, DEFAULT_OPS_POLICY.startup.cycle1CatchUp.delayMs),
        minPendingCandidates: coercePositiveInt(
          cycle1CatchUpConfig.minPendingCandidates,
          DEFAULT_OPS_POLICY.startup.cycle1CatchUp.minPendingCandidates,
        ),
        requireDue: cycle1CatchUpConfig.requireDue === true,
      },
      cycle2CatchUp: {
        mode: normalizeCatchUpMode(cycle2CatchUpConfig.mode, DEFAULT_OPS_POLICY.startup.cycle2CatchUp.mode),
        delayMs: coercePositiveInt(cycle2CatchUpConfig.delayMs, DEFAULT_OPS_POLICY.startup.cycle2CatchUp.delayMs),
        requireDue: cycle2CatchUpConfig.requireDue !== false,
      },
    },
    scheduler: {
      checkIntervalMs: coercePositiveInt(schedulerConfig.checkIntervalMs, DEFAULT_OPS_POLICY.scheduler.checkIntervalMs),
    },
  }
}

export function readMemoryFeatureFlags(mainConfig = {}) {
  const policy = readMemoryOpsPolicy(mainConfig)
  return {
    reranker: envFlag(process.env.TRIB_MEMORY_ENABLE_RERANKER, policy.features.reranker),
    temporalParser: envFlag(process.env.TRIB_MEMORY_ENABLE_TEMPORAL_PARSER, policy.features.temporalParser),
  }
}

export function resolveBackfillSinceMs(windowValue, now = Date.now()) {
  const normalized = normalizeBackfillWindow(windowValue)
  if (normalized === '1d') return now - (1 * 24 * 60 * 60 * 1000)
  if (normalized === '3d') return now - (3 * 24 * 60 * 60 * 1000)
  if (normalized === '7d') return now - (7 * 24 * 60 * 60 * 1000)
  if (normalized === '30d') return now - (30 * 24 * 60 * 60 * 1000)
  return null
}

export function buildStartupBackfillOptions(policy, store, now = Date.now()) {
  const backfill = policy?.startup?.backfill
  if (!backfill || backfill.mode === 'off') return null
  if (backfill.mode === 'if-empty' && Number(store?.countEpisodes?.() ?? 0) > 0) return null
  return {
    scope: backfill.scope,
    limit: backfill.limit,
    sinceMs: resolveBackfillSinceMs(backfill.window, now),
  }
}

export function shouldRunCycleCatchUp(kind, policy, state = {}) {
  const config = kind === 'cycle2'
    ? policy?.startup?.cycle2CatchUp
    : policy?.startup?.cycle1CatchUp
  const mode = config?.mode ?? 'off'
  if (mode === 'off') return false

  const due = Boolean(state.due)
  const unclassified = Number(state.unclassifiedEpisodes ?? state.pendingCandidates ?? 0)
  const pendingEmbeds = Number(state.pendingEmbeds ?? 0)
  const missingLastRun = !state.lastRunAt

  if (kind === 'cycle2') {
    if (mode === 'full') return due || unclassified > 0 || missingLastRun
    return config?.requireDue !== false ? due : (due || unclassified > 0 || missingLastRun)
  }

  if (mode === 'full') return due || unclassified > 0 || pendingEmbeds > 0 || missingLastRun
  if (config?.requireDue === true) return due
  return due || unclassified >= Number(config?.minPendingCandidates ?? 0) || (missingLastRun && (unclassified > 0 || pendingEmbeds > 0))
}
