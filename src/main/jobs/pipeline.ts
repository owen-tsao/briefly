import { Notification, powerMonitor, type BrowserWindow } from 'electron'
import type { JobItem, JobVerdict } from '../../shared/jobs'
import { isPasted } from '../../shared/jobs'
import { applyNowReason } from '../../shared/applyNow'
import { llmConfigured, getJobsScanMinutes, getLlmProvider, getNotificationsEnabled } from '../settings'
import { isLlmConfigError } from '../llmErrors'
import { updateTrayCount } from '../tray'
import { setPrepareListener } from './browser/prepare'
import { autoWatchFromApplications } from './autowatch'
import { extract } from './extract'
import {
  appliedCountByCompany,
  applySignals,
  demoteApplyByTitleRules,
  getSourceCursor,
  getView,
  itemsNeedingPay,
  itemsNeedingTextAudit,
  itemsNeedingScore,
  load,
  markScan,
  resetRuleVerdictsIfRulesChanged,
  retireNonUS,
  samePosting,
  setPayFacts,
  setTextAudit,
  setRuleVerdicts,
  setSourceCursor,
  setVerdict,
  upsertItems
} from './jobsStore'
import { scoreBatch } from './match'
import { locationLooksNonUS } from './normalize'
import { ensureProfile, profileVersion, readRules, readWatchlist, rulesVersion } from './profile'
import { applicationCountHint, ruleVerdict, TEXT_RULES_REV, textRules, titleRules } from './rules'
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
  /** `null` items means "unchanged since last fetch" (a 304): nothing to merge, nothing wrong. */
  fetch: (maxAgeDays: number, force: boolean) => Promise<{ items: JobItem[] | null; errors?: string[] }>
}

/** Postings older than this are ignored when first seen, so a fresh install isn't flooded. */
const FIRST_RUN_DAYS = 14
/** Sources return everything; the age gate is applied here only to unknown ids. */
const ALL_DAYS = 3650
/** Postings per LLM call — cuts request count 4x against free-tier caps. */
const POSTINGS_PER_CALL = 4
/** Candidates pulled per drain step; title/company rules settle most of these without any network. */
const RULE_BATCH = 40
/**
 * Gap between LLM calls. Free OpenAI-compatible tiers cap tokens per minute (a 4-posting call is
 * ~4k tokens against an ~8k/min cap), so they get 30 s. Bedrock bills per token with no such
 * ceiling, so it runs a drain in a couple of minutes instead of half an hour.
 */
const CALL_GAP_MS = 30_000
const BEDROCK_CALL_GAP_MS = 2_000
function callGapMs(): number {
  return getLlmProvider() === 'bedrock' ? BEDROCK_CALL_GAP_MS : CALL_GAP_MS
}
/** One drain runs at most this many calls (~30 min); the next tick or Scan starts another. */
const MAX_CALLS_PER_DRAIN = 60

/**
 * Cadence per source. Company boards and ApplyGuy are where new postings show up first, so they
 * run every tick. The three big READMEs change a few times a day; they poll conditionally (ETag),
 * so a 15-minute check that comes back 304 costs neither side anything.
 */
const SOURCES: Source[] = [
  { name: 'ats', every: 5, fetch: (d) => fetchWatchlistBoards(d) },
  { name: 'applyguy', every: 5, fetch: async (d, f) => ({ items: await fetchApplyGuy(d, f) }) },
  {
    name: 'instagram',
    every: 5,
    fetch: async () => {
      const r = await fetchInstagram()
      return { items: r.items, errors: r.problem ? [r.problem] : [] }
    }
  },
  { name: 'simplify', every: 15, fetch: async (d, f) => ({ items: await fetchSimplify(d, f) }) },
  { name: 'speedyapply', every: 15, fetch: async (d, f) => ({ items: await fetchSpeedyApply(d, f) }) },
  { name: 'jobright', every: 15, fetch: async (d, f) => ({ items: await fetchJobright(d, f) }) }
]

let running = false
let getWindow: () => BrowserWindow | null = () => null
let timer: NodeJS.Timeout | null = null
let openPopover: (() => void) | null = null

/**
 * A source is due when its cadence has (nearly) elapsed. The slack matters: `lastRun` is stamped
 * after the fetch finishes, while the timer fires exactly `every` minutes after the tick began, so
 * without it a source whose cadence equals the tick interval would miss every other tick.
 */
const DUE_SLACK_MS = 60_000

function due(source: Source, force: boolean): boolean {
  if (force) return true
  const last = getSourceCursor(source.name).lastRun
  return !last || Date.now() - new Date(last).getTime() >= source.every * 60_000 - DUE_SLACK_MS
}

/**
 * Aggregators with indirect links can't share an id with the ATS row — drop them when the pair exists.
 * A Jobright row is dropped if the store already has the same posting (company+title, compatible
 * city) under a *different* active id: a direct-link row, or Jobright's own earlier copy (Jobright
 * sometimes lists one posting twice). Its own stored copy (same id) passes so it keeps being
 * refreshed. Only active rows count, so a role re-listed after its direct row closed comes back.
 * Within one batch, the first Jobright row for a posting wins.
 */
export function dropSoftDuplicates(items: JobItem[], existing: JobItem[]): JobItem[] {
  const live = existing.filter((it) => it.active)
  const inBatch: JobItem[] = []
  return items.filter((it) => {
    if (it.source !== 'jobright') return true
    if (live.some((o) => o.id !== it.id && samePosting(o, it))) return false
    if (inBatch.some((o) => samePosting(o, it))) return false
    inBatch.push(it)
    return true
  })
}

/** One tick: due sources → upsert → kick the paced scorer → notify. Never throws. */
export async function runJobsScan(opts: { force?: boolean } = {}): Promise<ScanResult> {
  if (running) return { ok: false, added: 0, scored: 0, errors: ['scan already running'] }
  running = true
  const errors: string[] = []
  let added = 0
  try {
    // Boards you've applied on get pinned before the ATS source runs, so they're polled this tick.
    try {
      const n = autoWatchFromApplications()
      if (n) console.info(`[jobs] auto-watch pinned ${n} board(s) from your applications`)
    } catch (err) {
      console.warn('[jobs] auto-watch:', err instanceof Error ? err.message : String(err))
    }
    for (const source of SOURCES) {
      if (!due(source, Boolean(opts.force))) continue
      try {
        const { items, errors: srcErrors } = await source.fetch(ALL_DAYS, Boolean(opts.force))
        if (items === null) {
          // 304: the feed hasn't changed since we last read it. Nothing to merge.
          setSourceCursor(source.name, { ...getSourceCursor(source.name), lastRun: new Date().toISOString(), lastError: null })
          continue
        }
        // Re-read so rows added earlier in this same tick count for cross-source dedupe, and so
        // postings we already track are always refreshed (otherwise they'd look "no longer
        // listed" once they age past the first-run window while still open on the feed).
        const known = load().items
        const knownIds = new Set(known.map((it) => it.id))
        const fresh = items.filter(
          (it) => knownIds.has(it.id) || (withinDays(it.postedAt, FIRST_RUN_DAYS) && !locationLooksNonUS(it.location))
        )
        const deduped = dropSoftDuplicates(fresh, known)
        const r = upsertItems(deduped)
        added += r.added.length
        for (const e of srcErrors ?? []) errors.push(`${source.name}: ${e}`)
        setSourceCursor(source.name, {
          ...getSourceCursor(source.name),
          lastRun: new Date().toISOString(),
          lastError: srcErrors?.[0] ?? null
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${source.name}: ${msg}`)
        // The ETag was recorded when the body arrived; if parsing then failed, forget it so the
        // next tick re-downloads instead of getting a 304 for content we never ingested.
        setSourceCursor(source.name, { ...getSourceCursor(source.name), lastError: msg, etag: null })
      }
    }

    const version = profileVersion()
    retireNonUS(locationLooksNonUS)
    const reset = resetRuleVerdictsIfRulesChanged(rulesVersion())
    if (reset > 0) console.log(`[jobs] rules.md changed; re-evaluating ${reset} rule verdicts`)
    const rulesNow = readRules()
    const demoted = demoteApplyByTitleRules((it) => {
      const hit = titleRules(it, rulesNow)
      return hit ? ruleVerdict(hit) : null
    }, version)
    if (demoted.length) {
      console.log(`[jobs] title rules now reject ${demoted.length} previously passed: ${demoted.map((d) => `${d.company} — ${d.title}`).join('; ')}`)
    }
    if (!llmConfigured() && added > 0) errors.push('No LLM configured — new postings were saved but not scored')
    if (scoreError) errors.push(scoreError)

    markScan(version, errors)
    updateTrayCount()
    pushView()
    // Scoring is rate-limited by the LLM provider, so it drains in the background at its own pace.
    void drainScoreQueue()
    void backfillPay()
    void auditTextRules()
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

/** Descriptions read per tick just for pay; ATS JSON calls, no LLM. ~1 request/second, capped in wall time. */
const PAY_BATCH = 40
const PAY_BUDGET_MS = 90_000
let backfilling = false

/**
 * Postings scored before pay parsing existed never had their text read for a figure. Read a
 * few per tick so the Apply-now ranking fills in over the first half hour, then stays current.
 */
async function backfillPay(): Promise<void> {
  if (backfilling) return
  backfilling = true
  try {
    const todo = itemsNeedingPay(PAY_BATCH)
    if (todo.length === 0) return
    const started = Date.now()
    const out: { id: string; pay: string | null; read: boolean }[] = []
    for (const it of todo) {
      if (Date.now() - started > PAY_BUDGET_MS) break
      const ex = await extract(it.url, it.company)
      out.push({ id: it.id, pay: ex.pay ?? null, read: ex.descriptionAvailable })
      await sleep(1_000)
    }
    setPayFacts(out)
    pushView()
  } catch (err) {
    console.warn('[jobs] pay backfill:', err instanceof Error ? err.message : String(err))
  } finally {
    backfilling = false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Apply rows re-read per tick against tightened built-in text rules. Page fetches only, no LLM. */
const AUDIT_BATCH = 40
const AUDIT_BUDGET_MS = 90_000
let auditing = false

/**
 * A stricter text rule (e.g. R2 now reading "enrolled in a M.S./Ph.D.") should also reach postings
 * the LLM already passed. Re-read each apply row once per TEXT_RULES_REV; a hit demotes it to the
 * rule's skip with the quote, exactly as if it had been caught the first time.
 */
async function auditTextRules(): Promise<void> {
  if (auditing) return
  auditing = true
  try {
    const todo = itemsNeedingTextAudit(TEXT_RULES_REV, AUDIT_BATCH)
    if (todo.length === 0) return
    const started = Date.now()
    const out: { id: string; verdict: JobVerdict | null; read: boolean }[] = []
    for (const it of todo) {
      if (Date.now() - started > AUDIT_BUDGET_MS) break
      const ex = await extract(it.url, it.company)
      const hit = ex.descriptionAvailable ? textRules(ex.text).reject : null
      out.push({ id: it.id, verdict: hit ? ruleVerdict(hit) : null, read: ex.descriptionAvailable })
      await sleep(1_000)
    }
    const demoted = setTextAudit(TEXT_RULES_REV, out)
    if (demoted > 0) {
      console.log(`[jobs] text-rule audit rev ${TEXT_RULES_REV}: demoted ${demoted} of ${out.length} re-read`)
      updateTrayCount()
    }
    pushView()
  } catch (err) {
    console.warn('[jobs] text-rule audit:', err instanceof Error ? err.message : String(err))
  } finally {
    auditing = false
  }
}

/** Start a drain if one isn't running (used after "Score anyway"). */
export function kickScoring(): Promise<void> {
  return drainScoreQueue()
}

let draining = false
let scoreError: string | null = null
let scoredThisSession = 0
let ruledOutThisSession = 0
/** Wall-clock the provider told us to wait until (after a 429). */
let backoffUntil = 0
/** Postings whose chunk failed for a non-rate-limit reason; parked for this session so they can't head the queue forever. */
const failedIds = new Map<string, number>()
const MAX_FAILURES = 2

/**
 * Title rules are meaningless for events and for pasted links (their title is guessed from the
 * URL slug, if it exists at all); both go straight to the posting text and the LLM.
 */
function skipTitleRules(item: JobItem): boolean {
  return Boolean(item.skipRules) || item.kind === 'event' || isPasted(item)
}

/**
 * Score queued postings a few at a time with a fixed gap between LLM calls. Groq's free tier
 * is ~8k tokens/min for the default model; one 4-posting call is ~4k, so 30s spacing stays under.
 * A 429 parks the drain until the server's "retry in" hint (or a minute) has passed.
 */
async function drainScoreQueue(): Promise<void> {
  if (draining || !llmConfigured()) return
  draining = true
  // Parking is per drain: a chunk that failed twice sits out the rest of this run and gets one
  // more try next tick, so a flaky network can't sideline postings for the whole session.
  failedIds.clear()
  try {
    const version = profileVersion()
    const rules = readRules()
    const signals = applySignals()
    // Score the companies that could land in Apply now first; the rest can wait a few minutes.
    const watched = [...signals.tier1, ...signals.tier2, ...signals.watchlist, ...signals.appliedCompanies]
    const appliedBy = appliedCountByCompany()
    const newlyApply: JobItem[] = []

    // Title/company rules need no network, so settle the entire queue up front: the "queued"
    // count drops immediately and Hidden explains itself before the first LLM call.
    const sweep: { id: string; verdict: JobVerdict }[] = []
    for (const item of itemsNeedingScore(version, Number.MAX_SAFE_INTEGER, watched)) {
      const hit = skipTitleRules(item) ? null : titleRules(item, rules)
      if (hit) sweep.push({ id: item.id, verdict: ruleVerdict(hit) })
    }
    if (sweep.length) {
      ruledOutThisSession += setRuleVerdicts(sweep, version)
      pushView()
    }

    for (let calls = 0; calls < MAX_CALLS_PER_DRAIN; calls++) {
      if (Date.now() < backoffUntil) break
      const parked = new Set([...failedIds].filter(([, n]) => n >= MAX_FAILURES).map(([id]) => id))

      // Settle everything a title/company rule can decide without touching the network.
      const candidates = itemsNeedingScore(version, RULE_BATCH, watched, parked)
      if (candidates.length === 0) break
      const ruled: { id: string; verdict: JobVerdict }[] = []
      const pending: JobItem[] = []
      for (const item of candidates) {
        const hit = skipTitleRules(item) ? null : titleRules(item, rules)
        if (hit) ruled.push({ id: item.id, verdict: ruleVerdict(hit) })
        else pending.push(item)
      }
      ruledOutThisSession += setRuleVerdicts(ruled, version)
      if (pending.length === 0) {
        pushView()
        continue
      }

      // Fetch text for the next LLM-sized chunk; unambiguous text rules settle a few more for free.
      const chunk = pending.slice(0, POSTINGS_PER_CALL)
      const extracted = await Promise.all(
        chunk.map(async (item) => ({ item, ex: await extract(item.url, item.company) }))
      )
      const toScore: { item: JobItem; text: string; hints: string[] }[] = []
      const textRuled: { id: string; verdict: JobVerdict; title?: string | null; company?: string | null }[] = []
      for (const { item, ex } of extracted) {
        const text = ex.descriptionAvailable ? ex.text : ''
        // A pasted link's company/title were guessed from the URL; what the ATS states is authoritative
        // and should be what the LLM (and the text rules' title checks) see.
        if (item.source === 'manual') {
          if (ex.title) item.title = ex.title
          if (ex.company) item.company = ex.company
        }
        // Posting-text rules (grad window, clearance, years of experience) don't apply to events.
        const tr = text && !item.skipRules && item.kind !== 'event' ? textRules(text) : { reject: null, hints: [] }
        if (tr.reject) {
          const pasted = item.source === 'manual'
          textRuled.push({
            id: item.id,
            verdict: ruleVerdict(tr.reject),
            title: pasted ? ex.title ?? null : null,
            company: pasted ? ex.company ?? null : null
          })
          continue
        }
        const f7 = item.kind === 'event' ? null : applicationCountHint(item.company, appliedBy)
        toScore.push({ item, text, hints: f7 ? [...tr.hints, f7] : tr.hints })
      }
      ruledOutThisSession += setRuleVerdicts(textRuled, version)
      if (toScore.length === 0) {
        pushView()
        continue
      }

      try {
        const scored = await scoreBatch(toScore, [...signals.tier1, ...signals.tier2])
        toScore.forEach(({ item }, j) => {
          const ex = extracted.find((e) => e.item.id === item.id)!.ex
          const { verdict, page } = scored[j]
          const pasted = item.source === 'manual'
          // Structured ATS fields beat the LLM's reading of the page; the LLM only fills gaps.
          const pageCompany = pasted ? ex.company ?? page?.company ?? null : page?.company ?? null
          const pageTitle = pasted ? ex.title ?? page?.title ?? null : null
          setVerdict(item.id, verdict, version, {
            descriptionAvailable: ex.descriptionAvailable,
            location: ex.location,
            postedAt: ex.postedAt,
            pay: ex.pay,
            pageCompany,
            pageTitle,
            eventDate: page?.eventDate ?? null
          })
          scoredThisSession++
          if (verdict.decision === 'apply' && !item.verdict) {
            const withFacts: JobItem = {
              ...item,
              verdict,
              pay: item.pay ?? ex.pay ?? null,
              company: pageCompany && (item.company === 'Event' || pasted) ? pageCompany : item.company,
              title: pageTitle && pasted ? pageTitle : item.title,
              deadline: item.deadline ?? page?.eventDate ?? null
            }
            // Apply-now postings (tier, pay, a company you've applied to…): tell the user now, not
            // when the drain finishes half an hour later. Only for postings that are actually fresh;
            // a newly pinned board backfills weeks of listings and those belong in the batched summary.
            const reason = applyNowReason(withFacts, signals)
            if (reason && isFresh(item)) notifyPriorityApply(withFacts, reason)
            else newlyApply.push(withFacts)
          }
        })
        scoreError = null
        for (const { item } of toScore) failedIds.delete(item.id)
        updateTrayCount()
        pushView()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        scoreError = `score: ${msg.slice(0, 200)}`
        if (/429|rate limit|throttl/i.test(msg)) {
          const hint = msg.match(/try again in ([\d.]+)\s*(m|s)/i)
          const wait = hint ? Number(hint[1]) * (hint[2].toLowerCase() === 'm' ? 60_000 : 1_000) : 60_000
          backoffUntil = Date.now() + Math.max(wait + 2_000, 15_000)
          break
        }
        // Setup problems (credentials, permissions, model, region) won't fix themselves mid-drain:
        // stop now so the queue isn't burned retrying every chunk against the same broken config.
        // The regex covers the OpenAI SDK, whose errors are plain messages rather than typed.
        if (isLlmConfigError(err) || /401|403|API key|access key|credentials|permission|model access/i.test(msg)) break
        // Anything else (bad JSON, timeout) is likely this chunk's content: count it so the same
        // four postings stop heading the queue and starving everything behind them.
        for (const { item } of toScore) failedIds.set(item.id, (failedIds.get(item.id) ?? 0) + 1)
        pushView()
      }
      await sleep(callGapMs())
    }
    notifyNewApply(newlyApply)
  } finally {
    draining = false
  }
}

/** Published (or first seen) within the last day: worth interrupting for. An unparsable date is not. */
const FRESH_MS = 24 * 3_600_000
function isFresh(item: JobItem): boolean {
  const t = new Date(item.postedAt ?? item.seenAt).getTime()
  return !Number.isNaN(t) && Date.now() - t <= FRESH_MS
}

/** One notification per Apply-now posting, the moment its verdict lands. */
function notifyPriorityApply(item: JobItem, reason: string): void {
  if (!getNotificationsEnabled() || !Notification.isSupported()) return
  const event = item.kind === 'event'
  const n = new Notification({
    title: event ? `${item.company} — event worth attending (${reason})` : `${item.company} — apply now (${reason})`,
    body: `${item.title}${event && item.deadline ? ` · ${item.deadline}` : ''}${item.location ? ` · ${item.location}` : ''}${item.pay && item.pay !== reason ? ` · ${item.pay}` : ''}`,
    silent: false
  })
  n.on('click', () => openPopover?.())
  n.show()
}

/** Batched summary for everything else, sent when the drain finishes. */
function notifyNewApply(items: JobItem[]): void {
  if (items.length === 0 || !getNotificationsEnabled() || !Notification.isSupported()) return
  const events = items.filter((it) => it.kind === 'event').length
  const postings = items.length - events
  const parts = [
    postings ? `${postings} new posting${postings === 1 ? '' : 's'} worth applying to` : '',
    events ? `${events} event${events === 1 ? '' : 's'} worth attending` : ''
  ].filter(Boolean)
  const n = new Notification({
    title: `briefly — ${parts.join(', ')}`,
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
  // Prepared-application progress (filled, drafted, submitted) lands in the card as it happens.
  setPrepareListener(() => {
    pushView()
    updateTrayCount()
  })
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
