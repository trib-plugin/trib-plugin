/**
 * Event queue — file-based queue with priority processing.
 * All events go through this queue before execution.
 */

import { readdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import type { EventQueueConfig, ChannelsConfig } from '../backends/types.js'
import { DATA_DIR } from './config.js'
import { ensureDir } from './state-file.js'
import {
  logEvent,
  spawnClaudeP,
  runScript,
  type InjectFn,
  type InjectOptions,
  type SendFn,
  type SessionStateGetter,
} from './executor.js'

const QUEUE_DIR = join(DATA_DIR, 'events', 'queue')
const PROCESSED_DIR = join(DATA_DIR, 'events', 'processed')

export interface QueueItem {
  name: string
  source: string
  priority: 'high' | 'normal' | 'low'
  prompt: string
  exec: 'interactive' | 'non-interactive' | 'script'
  channel: string
  script?: string
  timestamp: number
}

export class EventQueue {
  private config: EventQueueConfig
  private channelsConfig: ChannelsConfig | null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private batchTimer: ReturnType<typeof setInterval> | null = null
  private runningCount = 0

  private injectFn: InjectFn | null = null
  private sendFn: SendFn | null = null
  private sessionStateGetter: SessionStateGetter | null = null
  private notifiedFiles = new Set<string>()  // track files already notified during active state

  constructor(config?: EventQueueConfig, channelsConfig?: ChannelsConfig) {
    this.config = config ?? {}
    this.channelsConfig = channelsConfig ?? null
  }

  setInjectHandler(fn: InjectFn): void { this.injectFn = fn }
  setSendHandler(fn: SendFn): void { this.sendFn = fn }
  setSessionStateGetter(fn: SessionStateGetter): void { this.sessionStateGetter = fn }

  // ── Lifecycle ─────────────────────────────────────────────────────

  start(): void {
    if (this.tickTimer) return
    ensureDir(QUEUE_DIR)
    ensureDir(PROCESSED_DIR)

    const tickMs = (this.config.tickInterval ?? 10) * 1000
    this.tickTimer = setInterval(() => this.processQueue(), tickMs)
    setTimeout(() => this.processQueue(), 3000) // initial tick after 3s

    const batchMs = (this.config.batchInterval ?? 30) * 60_000
    this.batchTimer = setInterval(() => this.processBatch(), batchMs)

    logEvent('queue started')
  }

  stop(): void {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null }
    if (this.batchTimer) { clearInterval(this.batchTimer); this.batchTimer = null }
  }

  reloadConfig(config?: EventQueueConfig, channelsConfig?: ChannelsConfig): void {
    this.stop()
    this.config = config ?? {}
    this.channelsConfig = channelsConfig ?? null
    this.start()
  }

  // ── Enqueue ───────────────────────────────────────────────────────

  enqueue(item: QueueItem): void {
    ensureDir(QUEUE_DIR)
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const filename = `${item.priority === 'high' ? '0' : item.priority === 'normal' ? '1' : '2'}-${id}.json`
    writeFileSync(join(QUEUE_DIR, filename), JSON.stringify(item, null, 2))
    logEvent(`${item.name}: enqueued (${item.priority}, ${item.exec})`)

    // High priority: process immediately
    if (item.priority === 'high') {
      this.processQueue()
    }
  }

  // ── Process queue ─────────────────────────────────────────────────

  private processQueue(): void {
    const maxConcurrent = this.config.maxConcurrent ?? 2
    const files = this.readQueueFiles()
    if (files.length === 0) return

    const sessionState = this.sessionStateGetter?.() ?? 'idle'

    // Collect interactive items for state-aware handling
    const interactiveFiles: { file: string; item: QueueItem }[] = []

    for (const file of files) {
      const item = this.readItem(file)
      if (!item) continue
      if (item.priority === 'low') continue

      if (item.exec === 'interactive') {
        interactiveFiles.push({ file, item })
        continue
      }

      if (this.runningCount >= maxConcurrent) return
      this.executeItem(item, file)
    }

    // Handle interactive items based on session state
    if (interactiveFiles.length === 0) return

    if (sessionState === 'idle') {
      // Idle → inject items for processing
      this.notifiedFiles.clear()
      for (const { file, item } of interactiveFiles) {
        this.executeItem(item, file)
      }
    } else {
      // Active/recent → notify count only (once per item)
      const unnotified = interactiveFiles.filter(f => !this.notifiedFiles.has(f.file))
      if (unnotified.length > 0 && this.injectFn) {
        const count = interactiveFiles.length
        this.injectFn('', 'queue', ' ', {
          instruction: `There are ${count} pending webhook/event items in the queue. The user is currently busy. Do not process them now — just be aware they exist. When the user seems available, briefly mention "${count} pending items" naturally.`,
          type: 'queue',
        })
        for (const { file } of unnotified) {
          this.notifiedFiles.add(file)
        }
        logEvent(`queue: notified ${count} pending interactive items (session=${sessionState})`)
      }
    }
  }

  private processBatch(): void {
    const files = this.readQueueFiles()
    const lowFiles = files.filter(f => f.startsWith('2-'))
    if (lowFiles.length === 0) return

    // Group by rule name
    const groups = new Map<string, { items: QueueItem[]; files: string[] }>()
    for (const file of lowFiles) {
      const item = this.readItem(file)
      if (!item) continue
      const group = groups.get(item.name) ?? { items: [], files: [] }
      group.items.push(item)
      group.files.push(file)
      groups.set(item.name, group)
    }

    for (const [name, group] of groups) {
      const combined = group.items.length === 1
        ? group.items[0].prompt
        : `Batch of ${group.items.length} events:\n\n${group.items.map((it, i) => `--- Event ${i + 1} ---\n${it.prompt}`).join('\n\n')}`

      const batchItem: QueueItem = {
        ...group.items[0],
        prompt: combined,
      }

      logEvent(`${name}: processing batch of ${group.items.length}`)
      this.executeItem(batchItem, null)

      // Move all to processed
      for (const file of group.files) {
        this.moveToProcessed(file, 'batched')
      }
    }
  }

  // ── Execute ───────────────────────────────────────────────────────

  private executeItem(item: QueueItem, file: string | null): void {
    if (item.exec === 'interactive') {
      if (this.injectFn) {
        // Use instruction meta: content visible, instruction hidden
        const opts: InjectOptions = { type: item.source === 'webhook' ? 'webhook' : 'event' }
        this.injectFn('', `event:${item.name}`, item.prompt, opts)
      }
      // Interactive stays in queue — user must confirm processing
      return
    }

    const channelId = this.resolveChannel(item.channel)

    if (item.exec === 'non-interactive') {
      this.runningCount++
      spawnClaudeP(item.name, item.prompt, (result, _code) => {
        this.runningCount--
        if (result && this.sendFn) {
          this.sendFn(channelId, result).catch(err =>
            logEvent(`${item.name}: send failed: ${err}`),
          )
        }
        logEvent(`${item.name}: result=${result.substring(0, 200)}`)
        if (file) this.moveToProcessed(file, 'done')
      })
      return
    }

    if (item.exec === 'script' && item.script) {
      this.runningCount++
      runScript(item.name, item.script, (result, _code) => {
        this.runningCount--
        if (result && this.sendFn) {
          this.sendFn(channelId, result).catch(err =>
            logEvent(`${item.name}: send failed: ${err}`),
          )
        }
        logEvent(`${item.name}: result=${result.substring(0, 200)}`)
        if (file) this.moveToProcessed(file, 'done')
      })
      return
    }

    logEvent(`${item.name}: unknown exec type: ${item.exec}`)
    if (file) this.moveToProcessed(file, 'error')
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private readQueueFiles(): string[] {
    try {
      return readdirSync(QUEUE_DIR)
        .filter(f => f.endsWith('.json'))
        .sort() // priority prefix ensures order: 0-high, 1-normal, 2-low
    } catch { return [] }
  }

  private readItem(file: string): QueueItem | null {
    try {
      return JSON.parse(readFileSync(join(QUEUE_DIR, file), 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logEvent(`queue: corrupt file ${file}`)
      }
      return null
    }
  }

  private moveToProcessed(file: string, status: string): void {
    try {
      ensureDir(PROCESSED_DIR)
      renameSync(join(QUEUE_DIR, file), join(PROCESSED_DIR, `${status}-${file}`))
    } catch { /* best effort */ }
  }

  private resolveChannel(label: string): string {
    if (!label || !this.channelsConfig) return ''
    const entry = (this.channelsConfig as any)[label] ?? (this.channelsConfig as any)?.channels?.[label]
    if (!entry) return label
    return typeof entry === 'string' ? entry : entry.id ?? label
  }

  /** Remove items from queue — after processing, dismissal, or any resolution */
  resolveItems(name: string, status: 'done' | 'dismissed' = 'done'): number {
    const files = this.readQueueFiles()
    let count = 0
    for (const file of files) {
      const item = this.readItem(file)
      if (!item) continue
      if (item.name === name || name === '*') {
        this.moveToProcessed(file, status)
        this.notifiedFiles.delete(file)
        count++
      }
    }
    if (count > 0) logEvent(`queue: resolved ${count} items (name=${name}, status=${status})`)
    return count
  }

  /** Get queue status */
  getStatus(): { pending: number; running: number } {
    const pending = this.readQueueFiles().length
    return { pending, running: this.runningCount }
  }

  /** List pending interactive items */
  getPendingInteractive(): QueueItem[] {
    return this.readQueueFiles()
      .map(f => this.readItem(f))
      .filter((item): item is QueueItem => item !== null && item.exec === 'interactive')
  }
}
