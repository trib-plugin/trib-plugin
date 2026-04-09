/**
 * Built-in scheduler — handles three schedule categories:
 *
 * - nonInteractive: spawn claude -p at fixed times
 * - interactive: inject prompt into current session at fixed times
 * - proactive: bot-initiated conversation at random intervals based on frequency
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { join, isAbsolute } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { TimedSchedule, ProactiveConfig, ProactiveItem, ChannelsConfig, BotConfig } from '../backends/types.js'
import { DATA_DIR } from './config.js'
import { appendFileSync } from 'fs'
import { spawn } from 'child_process'
import { spawnClaudeP, runScript as execScript, ensureNopluginDir } from './executor.js'

const DELEGATE_CLI = join(DATA_DIR, '..', '..', 'marketplaces', 'trib-plugin', 'scripts', 'delegate-cli.mjs')

const SCHEDULE_LOG = join(DATA_DIR, 'schedule.log')
// SCRIPTS_DIR moved to executor.ts
function logSchedule(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  process.stderr.write(`trib-channels scheduler: ${msg}\n`)
  try { appendFileSync(SCHEDULE_LOG, line) } catch { /* best effort */ }
}
import { isHoliday } from './holidays.js'
import { tryRead } from './settings.js'

const TICK_INTERVAL = 60_000 // 1 minute

/** Callback to inject a prompt into the current session */
type InjectOptions = { instruction?: string; type?: string }
type InjectFn = (channelId: string, name: string, content: string, options?: InjectOptions) => void

/** Callback to send a message via the main session's backend */
type SendFn = (channelId: string, text: string) => Promise<void>

// ── Frequency → daily count / idle guard mapping ─────────────────────

const FREQUENCY_MAP: Record<number, { daily: number; idleMinutes: number }> = {
  1: { daily: 3, idleMinutes: 180 },  // 3/day, 3h guard
  2: { daily: 5, idleMinutes: 120 },  // 5/day, 2h guard
  3: { daily: 7, idleMinutes: 90 },   // 7/day, 1.5h guard
  4: { daily: 10, idleMinutes: 60 },  // 10/day, 1h guard
  5: { daily: 15, idleMinutes: 30 },  // 15/day, 30m guard
}

export class Scheduler {
  private nonInteractive: TimedSchedule[]
  private interactive: TimedSchedule[]
  private proactive: ProactiveConfig | null
  private channelsConfig: ChannelsConfig | null
  private promptsDir: string
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private lastFired = new Map<string, string>()    // name -> "YYYY-MM-DDTHH:MM"
  private running = new Set<string>()
  private injectFn: InjectFn | null = null
  private sendFn: SendFn | null = null

  // Activity tracking
  private lastActivity = 0                          // timestamp of last inbound message

  // Proactive state
  private proactiveSlots: number[] = []             // minute-of-day slots for today
  private proactiveSlotsDate = ''                   // "YYYY-MM-DD" when slots were generated
  private proactiveLastFire = 0                     // timestamp of last proactive fire
  private proactiveFiredToday = 0                   // count of proactive fires today
  private deferred = new Map<string, number>()       // name -> deferred-until timestamp
  private skippedToday = new Set<string>()           // names skipped for today
  private holidayCountry: string | null = null       // ISO country code for holiday check
  private holidayChecked = ''                        // "YYYY-MM-DD" last checked date
  private todayIsHoliday = false                     // cached result for today
  private quietSchedule: string | null = null        // global quiet hours "HH:MM-HH:MM"

  constructor(
    nonInteractive: TimedSchedule[],
    interactive: TimedSchedule[],
    proactive: ProactiveConfig | undefined,
    channelsConfig: ChannelsConfig | undefined,
    promptsDir?: string,
    botConfig?: BotConfig,
  ) {
    this.nonInteractive = nonInteractive.filter(s => s.enabled !== false)
    this.interactive = interactive.filter(s => s.enabled !== false)
    this.proactive = proactive ?? null
    this.channelsConfig = channelsConfig ?? null
    this.promptsDir = promptsDir ?? join(DATA_DIR, 'prompts')
    this.holidayCountry = botConfig?.quiet?.holidays ?? null
    this.quietSchedule = botConfig?.quiet?.schedule ?? null
  }

  setInjectHandler(fn: InjectFn): void {
    this.injectFn = fn
  }

  setSendHandler(fn: SendFn): void {
    this.sendFn = fn
  }

  noteActivity(): void {
    this.lastActivity = Date.now()
  }

  /** Defer a schedule by N minutes from now */
  defer(name: string, minutes: number): void {
    this.deferred.set(name, Date.now() + minutes * 60_000)
  }

  /** Skip a schedule for the rest of today */
  skipToday(name: string): void {
    this.skippedToday.add(name)
  }

  /** Check if a schedule should be skipped (deferred or skipped today) */
  shouldSkip(name: string): boolean {
    if (this.skippedToday.has(name)) return true
    const until = this.deferred.get(name)
    if (until && Date.now() < until) return true
    if (until && Date.now() >= until) this.deferred.delete(name)
    return false
  }

  /** Get current session state based on activity */
  getSessionState(): 'idle' | 'active' | 'recent' {
    if (this.lastActivity === 0) return 'idle'
    const elapsed = Date.now() - this.lastActivity
    if (elapsed < 2 * 60_000) return 'active'       // within 2 minutes
    if (elapsed < 5 * 60_000) return 'recent'        // within 5 minutes
    return 'idle'
  }

  /** Get time context for prompt enrichment */
  getTimeContext(): { hour: number; dayOfWeek: string; isWeekend: boolean } {
    const now = new Date()
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const dow = now.getDay()
    return {
      hour: now.getHours(),
      dayOfWeek: days[dow],
      isWeekend: dow === 0 || dow === 6,
    }
  }

  /** Wrap prompt with session context metadata */
  wrapPrompt(name: string, prompt: string, type: 'interactive' | 'proactive'): string {
    const state = this.getSessionState()
    const time = this.getTimeContext()
    const header = [
      `[schedule: ${name} | type: ${type} | session: ${state}]`,
      `[time: ${time.dayOfWeek} ${String(time.hour).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')} | weekend: ${time.isWeekend}]`,
      `Before starting any work, briefly tell the user what you're about to do in one short sentence.`,
    ].join('\n')
    return `${header}\n\n${prompt}`
  }

  private static SCHEDULER_LOCK = join(tmpdir(), 'trib-channels-scheduler.lock')
  private static INSTANCE_UUID = randomUUID()

  start(): void {
    if (this.tickTimer) return
    const total = this.nonInteractive.length + this.interactive.length
      + (this.proactive?.items.length ?? 0)
    if (total === 0) {
      process.stderr.write('trib-channels scheduler: no schedules configured\n')
      return
    }

    ensureNopluginDir()

    const lockContent = `${process.pid}\n${Date.now()}\n${Scheduler.INSTANCE_UUID}`

    // Scheduler-level lock: only one session runs the scheduler
    try {
      writeFileSync(Scheduler.SCHEDULER_LOCK, lockContent, { flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        try {
          const content = readFileSync(Scheduler.SCHEDULER_LOCK, 'utf8')
          const lines = content.split('\n')
          const pid = parseInt(lines[0])
          const lockTime = parseInt(lines[1]) || 0
          const lockUuid = lines[2] || ''
          const lockAge = Date.now() - lockTime

          // If the PID is alive, check for PID reuse: lock older than 1h with different UUID
          let isAlive = false
          try { process.kill(pid, 0); isAlive = true } catch { /* dead */ }

          if (isAlive) {
            if (lockAge > 60 * 60 * 1000 && lockUuid !== Scheduler.INSTANCE_UUID) {
              // Lock is >1h old and PID is alive but UUID differs — likely PID reuse, reclaim
              process.stderr.write(`trib-channels scheduler: lock PID ${pid} alive but stale (${Math.round(lockAge / 60000)}m), reclaiming (PID reuse)\n`)
            } else {
              process.stderr.write(`trib-channels scheduler: another session (PID ${pid}) owns the scheduler, skipping\n`)
              return
            }
          }
          // Previous owner is dead or stale PID reuse — reclaim the lock
        } catch { /* can't read, take over */ }
        writeFileSync(Scheduler.SCHEDULER_LOCK, lockContent)
      } else {
        throw err
      }
    }
    process.on('exit', () => { try { unlinkSync(Scheduler.SCHEDULER_LOCK) } catch { /* ignore */ } })

    logSchedule(`${this.nonInteractive.length} non-interactive, ${this.interactive.length} interactive, ${this.proactive?.items.length ?? 0} proactive\n`)
    this.tick()
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL)
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  restart(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    try { unlinkSync(Scheduler.SCHEDULER_LOCK) } catch {}
    this.start()
  }

  reloadConfig(
    nonInteractive: TimedSchedule[],
    interactive: TimedSchedule[],
    proactive: ProactiveConfig | undefined,
    channelsConfig: ChannelsConfig | undefined,
    promptsDir?: string,
    botConfig?: BotConfig,
    options: { restart?: boolean } = {},
  ): void {
    this.nonInteractive = nonInteractive.filter(s => s.enabled !== false)
    this.interactive = interactive.filter(s => s.enabled !== false)
    this.proactive = proactive ?? null
    this.channelsConfig = channelsConfig ?? null
    this.promptsDir = promptsDir ?? join(DATA_DIR, 'prompts')
    this.holidayCountry = botConfig?.quiet?.holidays ?? null
    this.quietSchedule = botConfig?.quiet?.schedule ?? null
    this.holidayChecked = ''
    this.todayIsHoliday = false
    this.proactiveSlots = []
    this.proactiveSlotsDate = ''
    this.proactiveFiredToday = 0
    if (this.deferred.size > 0 || this.skippedToday.size > 0) {
      process.stderr.write(`trib-channels scheduler: reload clearing ${this.deferred.size} deferred, ${this.skippedToday.size} skipped\n`)
    }
    this.deferred.clear()
    this.skippedToday.clear()
    if (options.restart === false) return
    this.restart()
  }

  getStatus() {
    const result: Array<{
      name: string; time: string; days: string; type: string
      running: boolean; lastFired: string | null
    }> = []

    for (const s of this.nonInteractive) {
      result.push({
        name: s.name, time: s.time, days: s.days ?? 'daily',
        type: 'non-interactive', running: false,
        lastFired: this.lastFired.get(s.name) ?? null,
      })
    }
    for (const s of this.interactive) {
      result.push({
        name: s.name, time: s.time, days: s.days ?? 'daily',
        type: 'interactive', running: false,
        lastFired: this.lastFired.get(s.name) ?? null,
      })
    }
    if (this.proactive) {
      for (const item of this.proactive.items) {
        result.push({
          name: `proactive:${item.topic}`, time: `freq=${this.proactive.frequency}`,
          days: 'daily', type: 'proactive', running: false,
          lastFired: this.lastFired.get(`proactive:${item.topic}`) ?? null,
        })
      }
    }
    return result
  }

  async triggerManual(name: string): Promise<string> {
    // Check timed schedules
    const timed = [...this.nonInteractive, ...this.interactive].find(e => e.name === name)
    if (timed) {
      if (this.running.has(name)) return `"${name}" is already running`
      const isNonInteractive = this.nonInteractive.includes(timed)
      // Set lastFired to prevent duplicate with automatic tick
      const now = new Date()
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      this.lastFired.set(name, `${dateStr}T${hhmm}`)
      await this.fireTimed(timed, isNonInteractive ? 'non-interactive' : 'interactive')
      return `triggered "${name}"`
    }

    // Check proactive topics
    if (this.proactive) {
      const topic = name.replace(/^proactive:/, '')
      const item = this.proactive.items.find(i => i.topic === topic)
      if (item) {
        // Check active conversation guard even for manual triggers
        if (this.lastActivity > 0 && (Date.now() - this.lastActivity) < 5 * 60_000) {
          return `skipped proactive "${topic}" — conversation active (last activity ${Math.floor((Date.now() - this.lastActivity) / 1000)}s ago)`
        }
        await this.fireProactiveTick(item.topic)
        return `triggered proactive "${topic}"`
      }
    }

    return `schedule "${name}" not found`
  }

  // ── Tick ─────────────────────────────────────────────────────────────

  private tick(): void {
    this.tickAsync().catch(err =>
      process.stderr.write(`trib-channels scheduler: tick error: ${err}\n`),
    )
  }

  private async tickAsync(): Promise<void> {
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const key = `${dateStr}T${hhmm}`
    const dow = now.getDay()
    const isWeekend = dow === 0 || dow === 6

    // Holiday check — once per day, cached
    if (this.holidayCountry && this.holidayChecked !== dateStr) {
      this.holidayChecked = dateStr
      try {
        this.todayIsHoliday = await isHoliday(now, this.holidayCountry)
        if (this.todayIsHoliday) {
          process.stderr.write(`trib-channels scheduler: today (${dateStr}) is a holiday — weekday schedules will be skipped\n`)
        }
      } catch (err) {
        process.stderr.write(`trib-channels scheduler: holiday check failed: ${err}\n`)
        this.todayIsHoliday = false
      }
    }

    // Timed schedules (non-interactive + interactive)
    const allTimed: Array<{ schedule: TimedSchedule; type: 'non-interactive' | 'interactive' }> = [
      ...this.nonInteractive.map(s => ({ schedule: s, type: 'non-interactive' as const })),
      ...this.interactive.map(s => ({ schedule: s, type: 'interactive' as const })),
    ]

    for (const { schedule: s, type } of allTimed) {
      // Day-of-week check (daily, weekday, weekend, or comma-separated like "mon,wed,fri")
      const days = s.days ?? 'daily'
      if (!this.matchesDays(days, dow, isWeekend)) continue

      // Holiday skip: explicit per-schedule (skipHolidays) or weekday backward compat
      if (this.todayIsHoliday && (s.skipHolidays || days === 'weekday')) {
        const skipKey = `holiday:${dateStr}:${s.name}`
        if (!this.lastFired.has(skipKey)) {
          this.lastFired.set(skipKey, dateStr)
          logSchedule(`skipping "${s.name}" — public holiday\n`)
        }
        continue
      }

      // Per-schedule DND: skip during global quiet hours if dnd is true
      if (s.dnd && this.isQuietHours(now)) continue

      // Determine if this schedule should fire
      const intervalMatch = s.time.match(/^every(\d+)m$/)
      let shouldFire = false

      if (intervalMatch) {
        // Interval-based: fire if enough time elapsed since last run
        const intervalMs = parseInt(intervalMatch[1]) * 60_000
        const lastKey = this.lastFired.get(s.name)
        const lastTime = lastKey ? new Date(lastKey).getTime() : 0
        shouldFire = (Date.now() - lastTime) >= intervalMs
      } else if (s.time === 'hourly') {
        shouldFire = now.getMinutes() === 0 && this.lastFired.get(s.name) !== key
      } else {
        // Fixed time "HH:MM"
        shouldFire = s.time === hhmm && this.lastFired.get(s.name) !== key
      }

      if (!shouldFire) continue
      if (this.shouldSkip(s.name)) continue

      this.lastFired.set(s.name, now.toISOString())
      this.fireTimed(s, type).catch(err =>
        process.stderr.write(`trib-channels scheduler: ${s.name} failed: ${err}\n`),
      )
    }

    // Proactive schedules
    this.tickProactive(now, dateStr)
  }

  // ── Proactive tick ──────────────────────────────────────────────────

  private proactiveNextTick = 0  // timestamp of next proactive tick

  private tickProactive(now: Date, _dateStr: string): void {
    if (!this.proactive) return

    // DND check
    if (this.isQuietHours(now)) return

    // Interval with ±20% jitter
    if (this.proactiveNextTick === 0) {
      this.scheduleNextProactiveTick()
    }
    if (Date.now() < this.proactiveNextTick) return

    // Session state guard — only fire when idle
    if (this.getSessionState() !== 'idle') return

    // Fire and schedule next
    this.scheduleNextProactiveTick()
    this.fireProactiveTick()
  }

  private scheduleNextProactiveTick(): void {
    const intervalMs = (this.proactive?.interval ?? 60) * 60_000
    const jitter = intervalMs * 0.2
    this.proactiveNextTick = Date.now() + intervalMs + (Math.random() * jitter * 2 - jitter)
    const next = new Date(this.proactiveNextTick)
    logSchedule(`proactive next tick: ${next.toLocaleTimeString()}\n`)
  }

  /** Day abbreviation → JS day number (0=Sun...6=Sat) */
  private static DAY_ABBRS: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  }

  /** Check if today matches the schedule's days setting */
  private matchesDays(days: string, dow: number, isWeekend: boolean): boolean {
    if (days === 'daily') return true
    if (days === 'weekday') return !isWeekend
    if (days === 'weekend') return isWeekend
    // Comma-separated day abbreviations: "mon,wed,fri"
    const dayList = days.split(',').map(d => d.trim().toLowerCase())
    return dayList.some(d => Scheduler.DAY_ABBRS[d] === dow)
  }

  /** Check if current time is within global quiet hours (quiet.schedule) */
  private isQuietHours(now: Date): boolean {
    if (!this.quietSchedule) return false
    const parts = this.quietSchedule.split('-')
    if (parts.length !== 2) return false
    const [start, end] = parts
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    if (start > end) return hhmm >= start || hhmm < end
    return hhmm >= start && hhmm < end
  }

  private generateDailySlots(dateStr: string): void {
    this.proactiveSlotsDate = dateStr
    this.proactiveFiredToday = 0
    this.skippedToday.clear()
    this.deferred.clear()

    if (!this.proactive) { this.proactiveSlots = []; return }

    const freq = Math.max(1, Math.min(5, this.proactive.frequency))
    const { daily } = FREQUENCY_MAP[freq]

    // Generate random minute-of-day slots within waking hours (7:00-22:00 = 420-1320)
    const start = 420   // 07:00
    const end = 1320    // 22:00
    const slots = new Set<number>()
    for (let i = 0; i < daily; i++) {
      slots.add(start + Math.floor(Math.random() * (end - start)))
    }
    this.proactiveSlots = [...slots].sort((a, b) => a - b)
    process.stderr.write(`trib-channels scheduler: proactive slots for ${dateStr}: ${this.proactiveSlots.map(m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`).join(', ')}\n`)
  }

  // ── Fire timed schedule ─────────────────────────────────────────────

  private async fireTimed(
    schedule: TimedSchedule,
    type: 'non-interactive' | 'interactive',
  ): Promise<void> {
    const execMode = schedule.exec ?? 'prompt'

    // For script/script+prompt modes, run script first
    if (execMode === 'script' || execMode === 'script+prompt') {
      if (!schedule.script) {
        process.stderr.write(`trib-channels scheduler: no script specified for "${schedule.name}"\n`)
        return
      }

      // Skip if already running
      if (this.running.has(schedule.name)) return
      this.running.add(schedule.name)

      const channelId = this.resolveChannel(schedule.channel)
      logSchedule(`firing ${schedule.name} (${type}, exec=${execMode})\n`)

      try {
        const scriptResult = await this.runScript(schedule.script)

        if (execMode === 'script') {
          // Direct send: script stdout → Discord
          this.running.delete(schedule.name)
          if (scriptResult && this.sendFn) {
            await this.sendFn(channelId, scriptResult).catch(err =>
              process.stderr.write(`trib-channels scheduler: ${schedule.name} relay failed: ${err}\n`),
            )
          }
          process.stderr.write(`trib-channels scheduler: ${schedule.name} script done\n`)
          return
        }

        // script+prompt: script result → embed in prompt → Claude
        const prompt = this.loadPrompt(schedule.prompt ?? `${schedule.name}.md`)
        if (!prompt) {
          this.running.delete(schedule.name)
          process.stderr.write(`trib-channels scheduler: prompt not found for "${schedule.name}"\n`)
          return
        }

        const combinedPrompt = `${prompt}\n\n---\n## Script Output\n\`\`\`\n${scriptResult}\n\`\`\``
        this.running.delete(schedule.name)
        // Re-fire as a normal prompt schedule with the combined content
        await this.fireTimedPrompt(schedule, type, combinedPrompt, channelId)
        return
      } catch (err) {
        this.running.delete(schedule.name)
        process.stderr.write(`trib-channels scheduler: ${schedule.name} script error: ${err}\n`)
        return
      }
    }

    // Default: prompt mode
    const prompt = this.resolvePrompt(schedule)
    if (!prompt) {
      process.stderr.write(`trib-channels scheduler: prompt not found for "${schedule.name}"\n`)
      return
    }

    const channelId = this.resolveChannel(schedule.channel)
    await this.fireTimedPrompt(schedule, type, prompt, channelId)
  }

  /** Fire a timed schedule with the given prompt content */
  private async fireTimedPrompt(
    schedule: TimedSchedule,
    type: 'non-interactive' | 'interactive',
    prompt: string,
    channelId: string,
  ): Promise<void> {
    logSchedule(`firing ${schedule.name} (${type})\n`)

    if (type === 'interactive') {
      if (this.injectFn) {
        this.injectFn(channelId, schedule.name, ' ', {
          instruction: prompt,
          type: 'schedule',
        })
      }
      return
    }

    // Skip if already running (prevent duplicate from manual + auto trigger)
    if (this.running.has(schedule.name)) return
    this.running.add(schedule.name)

    // Use delegate-cli if available, fallback to claude -p
    if (existsSync(DELEGATE_CLI)) {
      const args: string[] = [DELEGATE_CLI]
      if (this.proactive?.model) args.push('--preset', this.proactive.model)
      args.push(prompt)

      const child = spawn('node', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 120_000,
        env: { ...process.env },
      })

      let stdout = ''
      child.stdout.on('data', (d: Buffer) => { stdout += d })
      child.on('close', (code: number | null) => {
        this.running.delete(schedule.name)
        let result = ''
        try {
          const parsed = JSON.parse(stdout)
          result = parsed.content || stdout.trim()
        } catch {
          result = stdout.trim()
        }
        if (result && this.sendFn) {
          this.sendFn(channelId, result).catch(err =>
            process.stderr.write(`trib-channels scheduler: ${schedule.name} relay failed: ${err}\n`),
          )
        }
        logSchedule(`${schedule.name} delegate done (${code})\n`)
      })
      child.on('error', () => { this.running.delete(schedule.name) })
    } else {
      spawnClaudeP(schedule.name, prompt, (result, code) => {
        this.running.delete(schedule.name)
        if (result && this.sendFn) {
          this.sendFn(channelId, result).catch(err =>
            process.stderr.write(`trib-channels scheduler: ${schedule.name} relay failed: ${err}\n`),
          )
        }
        logSchedule(`${schedule.name} claude-p done (${code})\n`)
      })
    }
  }

  // ── Script execution (delegates to shared executor) ────────────────

  private runScript(scriptName: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execScript(`schedule:${scriptName}`, scriptName, (result, code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`script exited with code ${code}`))
        } else {
          resolve(result)
        }
      })
    })
  }

  // ── Fire proactive (delegate-cli autonomous) ────────────────────────

  private proactiveDataFetcher: (() => Promise<{ memory: string; sources: any[] }>) | null = null
  private proactiveDbUpdater: ((updates: any) => void) | null = null

  setProactiveHandlers(
    dataFetcher: () => Promise<{ memory: string; sources: any[] }>,
    dbUpdater: (updates: any) => void,
  ): void {
    this.proactiveDataFetcher = dataFetcher
    this.proactiveDbUpdater = dbUpdater
  }

  private async fireProactiveTick(preferredTopic?: string): Promise<void> {
    if (!existsSync(DELEGATE_CLI)) {
      logSchedule('proactive: delegate-cli not found, skipping\n')
      return
    }

    // 1. Gather context
    const data = await this.proactiveDataFetcher?.() ?? { memory: '', sources: [] }
    const now = new Date()
    const timeInfo = `${now.toLocaleDateString('ko-KR')} ${now.toLocaleTimeString('ko-KR')} (${['일','월','화','수','목','금','토'][now.getDay()]}요일)`

    const sourcesText = data.sources.length > 0
      ? data.sources.map((s: any) => `- [${s.category}] ${s.topic} (score: ${s.score}, used: ${s.hit_count}/${s.hit_count + s.skip_count})`).join('\n')
      : '(no sources registered)'

    // 2. Build autonomous task
    const preferredTopicText = preferredTopic
      ? `\n## Manual Trigger Preference\nPrefer the topic "${preferredTopic}" if it is available and suitable. Only choose another source when that topic is unavailable or clearly not a good fit right now.\n`
      : ''

    const task = `You are a proactive conversation agent. You run periodically in the background.

## Current Time
${timeInfo}

## User Recent Context (from memory)
${data.memory || '(no recent context)'}

## Available Conversation Sources
${sourcesText}
${preferredTopicText}

## Your Job (do all of these in order)
1. **Judge availability**: Based on the memory context, is now a good time to talk? If the user seems busy, stressed, or in deep focus → respond with ONLY the JSON below with action:"skip".
2. **Discover new sources**: If you see interesting topics from recent conversations that aren't in the source list, include them in sourceUpdates.add.
3. **Pick a source**: Randomly pick one from the available sources (weighted by score). Research or compose material for it.
4. **Prepare message**: Write a natural, casual conversation starter in Korean (1-2 sentences). Be specific, not generic.
5. **Score adjustments**: Suggest score changes for sources based on what seems relevant now.

## Response Format (JSON only, no markdown)
{
  "action": "talk" | "skip",
  "message": "prepared conversation starter (Korean)",
  "sourcePicked": "topic name",
  "sourceUpdates": {
    "add": [{ "category": "...", "topic": "...", "query": "..." }],
    "remove": ["topic name"],
    "scores": { "topic name": 0.1 }
  },
  "log": "brief internal note about what you decided and why"
}`

    logSchedule('proactive: firing delegate-cli\n')

    const model = this.proactive?.model ?? ''
    const args: string[] = [DELEGATE_CLI]
    if (model) args.push('--preset', model)
    args.push(task)

    const child = spawn('node', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 90_000,
      env: { ...process.env },
    })

    let stdout = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d })
    child.on('close', (_code: number | null) => {
      let result: any
      try {
        // delegate-cli returns JSON with content field
        const outer = JSON.parse(stdout)
        const content = outer.content || stdout
        // Parse the inner JSON from model response
        const jsonMatch = content.match(/\{[\s\S]*\}/)
        result = jsonMatch ? JSON.parse(jsonMatch[0]) : null
      } catch {
        logSchedule(`proactive: failed to parse response\n`)
        return
      }

      if (!result) return

      // Write log
      if (result.log) {
        const logPath = join(DATA_DIR, 'proactive.log')
        try {
          appendFileSync(logPath, `[${new Date().toISOString()}] ${result.log}\n`)
        } catch { /* best effort */ }
      }

      // Apply source updates
      if (result.sourceUpdates) {
        this.proactiveDbUpdater?.(result.sourceUpdates)
      }

      // Skip
      if (result.action !== 'talk' || !result.message) {
        logSchedule(`proactive: skip (${result.log || 'no reason'})\n`)
        return
      }

      // Inject
      logSchedule(`proactive: "${result.sourcePicked}" → inject\n`)
      this.proactiveLastFire = Date.now()
      this.proactiveFiredToday++

      if (this.injectFn) {
        this.injectFn('', `proactive:${result.sourcePicked || 'chat'}`, ' ', {
          instruction: result.message,
        })
      }
    })

    child.on('error', (err: Error) => {
      logSchedule(`proactive: delegate error: ${err.message}\n`)
    })
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /** Resolve a channel label to its platform ID via channelsConfig, fallback to raw value */
  private resolveChannel(label: string): string {
    // Standard nested format: channelsConfig.channels[label].id
    const nested = this.channelsConfig?.channels?.[label]?.id
    if (nested) return nested
    // Flat format from config UI: channelsConfig[label].channelId or .id
    const flat = (this.channelsConfig as any)?.[label]
    if (flat?.channelId) return flat.channelId
    if (flat?.id) return flat.id
    return label
  }

  /** Resolve prompt: try file first, fall back to inline text */
  private resolvePrompt(schedule: TimedSchedule): string | null {
    const ref = schedule.prompt ?? `${schedule.name}.md`
    const fromFile = this.loadPrompt(ref)
    if (fromFile) return fromFile
    // File not found — if prompt was explicitly set, use it as inline content
    if (schedule.prompt) return schedule.prompt
    return null
  }

  private loadPrompt(nameOrPath: string): string | null {
    const full = isAbsolute(nameOrPath) ? nameOrPath : join(this.promptsDir, nameOrPath)
    return tryRead(full)
  }

}
