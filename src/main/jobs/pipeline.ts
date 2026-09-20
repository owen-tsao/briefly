import { Notification, powerMonitor, type BrowserWindow } from 'electron'
import type { JobItem } from '../../shared/jobs'
import { getApiKey, getJobsScanMinutes, getNotificationsEnabled } from '../settings'
import { updateTrayCount } from '../tray'
import { extract } from './extract'
import {
  getSourceCursor,
  getView,
  itemsNeedingScore,
  load,
  markScan,
  setSourceCursor,
  setVerdict,
  upsertItems
} from './jobsStore'
import { scoreBatch } from './match'
import { ensureProfile, profileVersion, readWatchlist } from './profile'
import { fetchApplyGuy } from './sources/applyguy'
import { fetchWatchlistBoards } from './sources/ats'
import { withinDays } from './sources/common'
import { fetchInstagram } from './sources/instagram'
import { fetchJobright } from './sources/jobright'
import { fetchSimplify } from './sources/simplify'
import { fetchSpeedyApply } from './sources/speedyapply'

export interface ScanResult {
  ok: boolean
  added: number
  scored: number
  errors: string[]
}

interface Source {
  name: string
  /** Minutes between runs. */
  every: number
  fetch: (maxAgeDays: number) => Promise<{ items: JobItem[]; errors?: string[] }>
}

/** Postings older than this are ignored when first seen, so a fresh install isn't flooded. */
const FIRST_RUN_DAYS = 14
/** Sources return everything; the age gate is applied here only to unknown ids. */
const ALL_DAYS = 3650
/** Postings per LLM call — cuts request count 4x against free-tier caps. */
const POSTINGS_PER_CALL = 4
/** Gap between LLM calls; keeps a 4-posting call (~4k tokens) under an 8k tokens/min cap. */
const CALL_GAP_MS = 30_000
/** One drain runs at most this many calls (~30 min); the next tick or Scan starts another. */
const MAX_CALLS_PER_DRAIN = 60
const DAY = 24 * 60

const SOURCES: Source[] = [
  { name: 'ats', every: 15, fetch: fetchWatchlistBoards },
  { name: 'applyguy', every: 15, fetch: async (d) => ({ items: await fetchApplyGuy(d) }) },
  {
    name: 'instagram',
    every: 15,
    fetch: async () => {
      const r = await fetchInstagram()
      return { items: r.items, errors: r.stale ? ['instagram.json is stale — is the sidecar running?'] : [] }
    }
  },
  { name: 'simplify', every: DAY, fetch: async (d) => ({ items: await fetchSimplify(d) }) },
  { name: 'speedyapply', every: DAY, fetch: async (d) => ({ items: await fetchSpeedyApply(d) }) },
  { name: 'jobright', every: DAY, fetch: async (d) => ({ items: await fetchJobright(d) }) }
]

let running = false
let getWindow: () => BrowserWindow | null = () => null
let timer: NodeJS.Timeout | null = null
let openPopover: (() => void) | null = null

function due(source: Source, force: boolean): boolean {
  if (force) return true
  const last = getSourceCursor(source.name).lastRun
  return !last || Date.now() - new Date(last).getTime() >= source.every * 60_000
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Aggregators with indirect links can't share an id with the ATS row — drop them when the pair exists. */
function dropSoftDuplicates(items: JobItem[], existing: JobItem[]): JobItem[] {
  const seen = new Set(existing.map((it) => `${norm(it.company)}|${norm(it.title)}`))
  return items.filter((it) => {
    if (it.source !== 'jobright') return true
    return !seen.has(`${norm(it.company)}|${norm(it.title)}`)
  })
}

/** One tick: due sources → upsert → kick the paced scorer → notify. Never throws. */
export async function runJobsScan(opts: { force?: boolean } = {}): Promise<ScanResult> {
  if (running) return { ok: false, added: 0, scored: 0, errors: ['scan already running'] }
  running = true
  const errors: string[] = []
  let added = 0
  try {
    for (const source of SOURCES) {
      if (!due(source, Boolean(opts.force))) continue
      try {
        const { items, errors: srcErrors } = await source.fetch(ALL_DAYS)
        // Re-read so rows added earlier in this same tick count for cross-source dedupe, and so
        // postings we already track are always refreshed (otherwise they'd look "no longer
        // listed" once they age past the first-run window while still open on the feed).
        const known = load().items
        const knownIds = new Set(known.map((it) => it.id))
        const fresh = items.filter((it) => knownIds.has(it.id) || withinDays(it.postedAt, FIRST_RUN_DAYS))
        const deduped = dropSoftDuplicates(fresh, known)
        const r = upsertItems(deduped)
        added += r.added.length
        for (const e of srcErrors ?? []) errors.push(`${source.name}: ${e}`)
        setSourceCursor(source.name, { lastRun: new Date().toISOString(), lastError: srcErrors?.[0] ?? null })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${source.name}: ${msg}`)
        setSourceCursor(source.name, { ...getSourceCursor(source.name), lastError: msg })
      }
    }

    const version = profileVersion()
    if (!getApiKey() && added > 0) errors.push('No API key — new postings were saved but not scored')
    if (scoreError) errors.push(scoreError)

    markScan(version, errors)
    updateTrayCount()
    pushView()
    // Scoring is rate-limited by the LLM provider, so it drains in the background at its own pace.
    void drainScoreQueue()
    return { ok: true, added, scored: scoredThisSession, errors }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
    return { ok: false, added, scored: scoredThisSession, errors }
  } finally {
    running = false
  }
}

function pushView(): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('jobs:changed', getView())
}

let draining = false
let scoreError: string | null = null
let scoredThisSession = 0
/** Wall-clock the provider told us to wait until (after a 429). */
let backoffUntil = 0

/**
 * Score queued postings a few at a time with a fixed gap between LLM calls. Groq's free tier
 * is ~8k tokens/min for the default model; one 4-posting call is ~4k, so 30s spacing stays under.
 * A 429 parks the drain until the server's "retry in" hint (or a minute) has passed.
 */
async function drainScoreQueue(): Promise<void> {
  if (draining || !getApiKey()) return
  draining = true
  try {
    const version = profileVersion()
    const watched = readWatchlist().map((w) => w.company)
    const newlyApply: JobItem[] = []
    for (let calls = 0; calls < MAX_CALLS_PER_DRAIN; calls++) {
      if (Date.now() < backoffUntil) break
      const chunk = itemsNeedingScore(version, POSTINGS_PER_CALL, watched)
      if (chunk.length === 0) break
      const extracted = await Promise.all(
        chunk.map(async (item) => ({ item, ex: await extract(item.url, item.company) }))
      )
      try {
        const verdicts = await scoreBatch(
          extracted.map(({ item, ex }) => ({ item, text: ex.descriptionAvailable ? ex.text : '' }))
        )
        extracted.forEach(({ item, ex }, j) => {
          setVerdict(item.id, verdicts[j], version, {
            descriptionAvailable: ex.descriptionAvailable,
            location: ex.location,
            postedAt: ex.postedAt
          })
          scoredThisSession++
          if (verdicts[j].decision === 'apply' && !item.verdict) newlyApply.push({ ...item, verdict: verdicts[j] })
        })
        scoreError = null
        updateTrayCount()
        pushView()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        scoreError = `score: ${msg.slice(0, 200)}`
        if (/429|rate limit/i.test(msg)) {
          const hint = msg.match(/try again in ([\d.]+)\s*(m|s)/i)
          const wait = hint ? Number(hint[1]) * (hint[2].toLowerCase() === 'm' ? 60_000 : 1_000) : 60_000
          backoffUntil = Date.now() + Math.max(wait + 2_000, 15_000)
          break
        }
        if (/401|403|API key/i.test(msg)) break
      }
      await new Promise((r) => setTimeout(r, CALL_GAP_MS))
    }
    notifyNewApply(newlyApply)
  } finally {
    draining = false
  }
}

function notifyNewApply(items: JobItem[]): void {
  if (items.length === 0 || !getNotificationsEnabled() || !Notification.isSupported()) return
  const n = new Notification({
    title: `briefly — ${items.length} new posting${items.length === 1 ? '' : 's'} worth applying to`,
    body: items.slice(0, 4).map((it) => `${it.company}: ${it.title}`).join('\n'),
    silent: false
  })
  n.on('click', () => openPopover?.())
  n.show()
}

/** Arm the recurring scan. Same defer-while-visible + wake-catch-up pattern as auto-rescan. */
export function initJobsScheduler(windowGetter: () => BrowserWindow | null, popoverOpener: () => void): void {
  getWindow = windowGetter
  openPopover = popoverOpener
  // Seed ~/.briefly/profile on launch so the templates exist before the first scan scores anything.
  try {
    ensureProfile()
  } catch (err) {
    console.warn('[jobs] could not create profile folder', err)
  }
  powerMonitor.on('resume', () => setTimeout(() => void tick(), 30_000))
  scheduleJobsScan()
}

export function scheduleJobsScan(): void {
  if (timer) clearInterval(timer)
  timer = null
  const minutes = getJobsScanMinutes()
  if (!minutes) return
  timer = setInterval(() => void tick(), minutes * 60_000)
  setTimeout(() => void tick(), 45_000)
}

async function tick(): Promise<void> {
  if (!getJobsScanMinutes()) return
  const win = getWindow()
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.once('hide', () => setTimeout(() => void tick(), 3_000))
    return
  }
  const r = await runJobsScan()
  if (r.errors.length) console.warn('[jobs] scan:', r.errors.join(' | '))
}
