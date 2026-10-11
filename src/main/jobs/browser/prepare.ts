/// <reference lib="dom" />
import { Notification } from 'electron'
import type { Frame, Page } from 'playwright'
import type { JobItem, JobStatus, PreparedInfo } from '../../../shared/jobs'
import { getNotificationsEnabled } from '../../settings'
import { classifyUrl, type Ats } from '../normalize'
import { getUserState, setPrepared, setResolvedUrl, setStatus } from '../jobsStore'
import { loadCandidate } from './candidate'
import { fillPage, type FillReport } from './fill'
import { BrowserUnavailableError, openPage } from '../../browser/session'

/**
 * "Apply" for a supported ATS: open the posting in briefly's browser, get to the form, fill what
 * the profile knows, draft the rest, paint a banner that says exactly what happened, and then
 * get out of the way. The Submit button is yours. If the page later shows a confirmation, the
 * card flips to Applied on its own.
 */

export type PrepareVia = 'browser'

/**
 * Hosts whose forms the filler understands well enough to be worth opening automatically. Exact
 * ATS domains only: this decides where your details get typed, so a look-alike host or a company
 * page that merely carries a Greenhouse `gh_jid` (its form is an iframe we cannot fill anyway)
 * does not qualify.
 */
export function supportedAts(url: string): Ats | 'jobright' | 'icims' | null {
  const ref = classifyUrl(url)
  if (ref) return ref.ats
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return null
    const host = u.hostname.toLowerCase()
    if (/(^|\.)jobright\.ai$/.test(host)) return 'jobright'
    if (/(^|\.)greenhouse\.io$/.test(host)) return 'greenhouse'
    if (/(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$/.test(host)) return 'workday'
    if (/(^|\.)lever\.co$/.test(host)) return 'lever'
    if (/(^|\.)ashbyhq\.com$/.test(host)) return 'ashby'
    if (/(^|\.)icims\.com$/.test(host)) return 'icims'
  } catch {
    /* ignore */
  }
  return null
}

/** Every system briefly will open in its browser. Known ones get their own path; the rest a generic one. */
export type FillRoute = Ats | 'jobright' | 'icims' | 'other'

/**
 * Where Apply sends a posting. Anything https opens in briefly's browser: known systems are filled
 * with their quirks handled; unknown ones get the generic scanner on whatever form is on the page,
 * and the "Fill this page" bar for every later step. Null only for non-https links.
 */
export function fillRoute(url: string): FillRoute | null {
  const known = supportedAts(url)
  if (known) return known
  try {
    return new URL(url).protocol === 'https:' ? 'other' : null
  } catch {
    return null
  }
}

/**
 * Fill only while the tab is on a system we meant to fill. For a known ATS that is its own domain;
 * for the generic route it is the site the application started on (a redirect elsewhere gets nothing).
 */
function onFillableHost(page: Page, startHost: string): boolean {
  const ats = supportedAts(page.url())
  if (ats) return ats !== 'jobright'
  try {
    const host = new URL(page.url()).hostname
    return new URL(page.url()).protocol === 'https:' && sameSite(host, startHost)
  } catch {
    return false
  }
}

/**
 * The document that actually holds the form. iCIMS renders the whole career site inside a same-origin
 * iframe; Playwright locators do not pierce frames, so pick the frame with the most form controls.
 */
async function formFrame(page: Page): Promise<Frame> {
  let best = page.mainFrame()
  let bestCount = -1
  for (const f of page.frames()) {
    let host = ''
    try {
      const u = new URL(f.url())
      if (u.protocol !== 'https:') continue
      host = u.hostname
    } catch {
      continue
    }
    if (!sameSite(host, new URL(page.url()).hostname)) continue
    // Visible controls only: the iCIMS shell document carries hidden inputs, the real form is in the frame.
    const n = await f
      .evaluate(() =>
        Array.from(document.querySelectorAll('input:not([type=hidden]), select, textarea, [role="combobox"], [role="listbox"]')).filter(
          (e) => (e as HTMLElement).getClientRects().length > 0
        ).length
      )
      .catch(() => -1)
    if (n > bestCount || (n === bestCount && f === page.mainFrame())) {
      best = f
      bestCount = n
    }
  }
  return best
}

let onChange: (() => void) | null = null
export function setPrepareListener(fn: () => void): void {
  onChange = fn
}

/** Tabs briefly opened, by card, so "Open" in the Review queue can bring one forward. */
const tabs = new Map<string, Page>()

export function preparedTabOpen(id: string): boolean {
  const p = tabs.get(id)
  return Boolean(p && !p.isClosed())
}

/** Bring a prepared tab forward. False if the tab is gone (closed by you, or the browser quit). */
export async function focusPrepared(id: string): Promise<boolean> {
  const p = tabs.get(id)
  if (!p || p.isClosed()) {
    tabs.delete(id)
    return false
  }
  await p.bringToFront().catch(() => undefined)
  return true
}

const SUCCESS_RE =
  /application (has been )?(submitted|received|sent)|thank you for (applying|your application|your interest|submitting)|we('ve| have) received your application|successfully (submitted|applied)|your application was (sent|received)|you('ve| have) applied/i

export interface PrepareOptions {
  /** Open this instead of the posting's own link (the employer page a jobright wrapper resolved to). */
  startUrl?: string
  /** Wait for the fill pass to finish before returning (batch mode). Default: return once the tab is open. */
  wait?: boolean
}

export async function prepareApplication(item: JobItem, opts: PrepareOptions = {}): Promise<{ ok: boolean; error?: string }> {
  const startUrl = opts.startUrl ?? item.url
  const ats = fillRoute(startUrl)
  if (!ats) return { ok: false, error: 'Only https links can be opened.' }
  // Already have a live tab for this card: just bring it forward instead of opening a second one.
  if (await focusPrepared(item.id)) return { ok: true }
  let page: Page
  try {
    page = await openPage(startUrl)
  } catch (err) {
    const msg = err instanceof BrowserUnavailableError ? err.message : `The page did not load (${err instanceof Error ? err.message.split('\n')[0].slice(0, 120) : 'error'}).`
    return { ok: false, error: msg }
  }
  tabs.set(item.id, page)
  page.on('close', () => {
    if (tabs.get(item.id) === page) tabs.delete(item.id)
  })
  const previous = getUserState(item.id)?.status ?? 'new'
  setStatus(item.id, 'applying')
  setPrepared(item.id, { at: new Date().toISOString(), finishedAt: null, ats, filled: 0, drafted: [], unfilled: [], resumeUploaded: false, error: null, submittedAt: null, closedAt: null })
  onChange?.()

  const run = runPreparation(page, item, ats, previous, new URL(startUrl).hostname)
  // Default: the user is now looking at the browser; progress lands in the card as it happens.
  if (opts.wait) await run
  else void run
  return { ok: true }
}

/**
 * Prepare several cards one after another so they don't fight over Bedrock and the browser's
 * focus. Returns how many tabs were opened; unsupported systems are skipped, not handed to Aside.
 */
export async function prepareBatch(items: JobItem[], resolved: (id: string) => string | null): Promise<{ started: number; skipped: number; error: string | null }> {
  let started = 0
  let skipped = 0
  for (const item of items) {
    const startUrl = resolved(item.id) ?? item.url
    if (!supportedAts(startUrl)) {
      skipped++
      continue
    }
    const r = await prepareApplication(item, { startUrl, wait: true })
    if (!r.ok) {
      // A missing browser fails every card the same way; stop rather than repeat the error.
      if (started === 0) return { started, skipped, error: r.error ?? 'Could not open the browser.' }
      skipped++
      continue
    }
    started++
  }
  return { started, skipped, error: null }
}

async function runPreparation(page: Page, item: JobItem, ats: FillRoute, previous: JobStatus, startHost: string): Promise<void> {
  try {
    if (ats === 'jobright') {
      const target = await resolveJobrightOnPage(page)
      if (target === 'login') {
        throw new Error('jobright wants you to sign in before it shows the employer link. Sign in once in this window (it stays signed in), then press Apply on the card again.')
      }
      if (!target) throw new Error('Could not find the employer’s application link on jobright. Use its Apply button.')
      setResolvedUrl(item.id, target)
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      const real = fillRoute(target)
      setPrepared(item.id, { ats: real ?? 'unknown' })
      if (!real || real === 'jobright') {
        setPrepared(item.id, { finishedAt: new Date().toISOString(), error: 'The employer’s link is not an https application page.' })
        await banner(page, { note: 'briefly opened the employer’s page but will not fill here.' })
        watchForSubmit(page, item)
        return
      }
      // From here on, the employer's site is where the application lives.
      startHost = new URL(target).hostname
    }
    await reachForm(page)
    const closed = await detectClosedPosting(page)
    if (closed) {
      // Not a fill failure: the posting is gone. Put the card back where it was and say so.
      setStatus(item.id, previous && previous !== 'applying' ? previous : 'new')
      setPrepared(item.id, { finishedAt: new Date().toISOString(), error: closed })
      await banner(page, { note: closed })
      return
    }
    const loginWall = await detectLoginWall(page)
    if (loginWall) {
      setPrepared(item.id, { finishedAt: new Date().toISOString(), error: loginWall })
      await banner(page, { note: `${loginWall} Sign in here — briefly fills each page of the application as it appears.` })
      await installRefill(page, item, startHost)
      followSteps(page, item, startHost, '')
      watchForSubmit(page, item)
      onChange?.()
      return
    }
    if (!onFillableHost(page, startHost)) {
      // The posting link or an Apply button took us somewhere that is not an ATS we fill.
      const note = `Not filling on ${new URL(page.url()).hostname}: this isn’t where the application started. Finish it by hand.`
      setPrepared(item.id, { finishedAt: new Date().toISOString(), error: note })
      await banner(page, { note })
      watchForSubmit(page, item)
      return
    }
    const frame = await formFrame(page)
    const report = await fillPage(frame, item, loadCandidate())
    recordReport(item.id, report)
    if (report.filled.length + report.unfilled.length + report.drafted.length === 0 && !report.resumeUploaded) {
      // Nothing scanned: the form is probably behind a button we did not find, or on another step.
      const note = 'No form fields found on this page yet. Get to the application form — briefly fills it as soon as it appears.'
      setPrepared(item.id, { error: note })
      await banner(page, { note })
    } else {
      const steps = ats === 'greenhouse' || ats === 'lever' || ats === 'ashby' ? undefined : 'This system goes step by step: press Next after reviewing each page and briefly fills the next one.'
      await banner(page, { report, note: steps })
    }
    await installRefill(page, item, startHost)
    followSteps(page, item, startHost, await formSignature(frame).catch(() => ''))
    watchForSubmit(page, item)
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : String(err)
    setPrepared(item.id, { finishedAt: new Date().toISOString(), error: msg })
    if (!page.isClosed()) {
      await banner(page, { note: `briefly could not fill this form: ${msg}` }).catch(() => undefined)
      watchForSubmit(page, item)
    } else {
      setPrepared(item.id, { closedAt: new Date().toISOString() })
    }
  } finally {
    onChange?.()
  }
}

function recordReport(id: string, report: FillReport): void {
  setPrepared(id, {
    finishedAt: new Date().toISOString(),
    filled: report.filled.length,
    drafted: report.drafted.map((d) => ({ label: d.label.slice(0, 160), text: d.value.slice(0, 2000) })),
    unfilled: report.unfilled.slice(0, 40),
    resumeUploaded: report.resumeUploaded,
    error: null
  })
}

/**
 * Some boards show the form only after an Apply button; click it once if no fields are visible yet.
 * Single-page boards (Ashby) render nothing until their script runs, so wait for the page to settle
 * and look for the control a few times rather than once.
 */
async function reachForm(page: Page): Promise<void> {
  const FIELD = 'input[type="email"], input[name*="email" i], input[autocomplete="given-name"], input#first_name, input[name*="first" i], [data-automation-id="legalNameSection_firstName"]'
  // Locators do not pierce iframes; iCIMS keeps the whole career site in one.
  const hasField = async (): Promise<boolean> => {
    for (const f of page.frames()) if ((await f.locator(FIELD).count().catch(() => 0)) > 0) return true
    return false
  }
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined)
  if (await hasField()) return
  // Ashby: the posting lives at /{org}/{id}; the form is the same URL plus /application.
  const ashby = page.url().match(/^(https:\/\/jobs\.ashbyhq\.com\/[^/?#]+\/[0-9a-f-]{20,})\/?(\?.*)?$/i)
  if (ashby) {
    await page.goto(`${ashby[1]}/application`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined)
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined)
  } else {
    const applyIn = (f: Frame) =>
      f
        .getByRole('button', { name: /^apply( now| for this job| for this position| online)?$/i })
        .or(f.getByRole('link', { name: /^apply( now| for this job| for this position| online)?$/i }))
        .or(f.locator('a[href*="/apply"], a[href$="/application"], a[href*="mode=apply"], a.postings-btn, [data-automation-id="adventureButton"]'))
    let clicked = false
    for (let i = 0; i < 8 && !clicked; i++) {
      for (const f of page.frames()) {
        const apply = applyIn(f)
        if ((await apply.count().catch(() => 0)) > 0) {
          await apply.first().click({ timeout: 5000 }).catch(() => undefined)
          await page.waitForLoadState('domcontentloaded').catch(() => undefined)
          clicked = true
          break
        }
      }
      if (!clicked) await page.waitForTimeout(500)
    }
    // Workday answers Apply with a menu; "Autofill with Resume" leads to sign-in, then the resume step.
    const autofill = page.getByRole('button', { name: /autofill with resume/i }).or(page.locator('[data-automation-id="autofillWithResume"]'))
    for (let i = 0; i < 6 && (await autofill.count().catch(() => 0)) === 0; i++) await page.waitForTimeout(500)
    if ((await autofill.count().catch(() => 0)) > 0) {
      await autofill.first().click({ timeout: 5000 }).catch(() => undefined)
      await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    }
  }
  for (let i = 0; i < 16 && !(await hasField()); i++) await page.waitForTimeout(500)
}

/**
 * A posting that has been taken down. Greenhouse bounces to the company's job list with
 * `?error=true`; Lever and Ashby show a "no longer accepting applications" page. Say so instead
 * of reporting the board's search box as "fields for you".
 */
async function detectClosedPosting(page: Page): Promise<string | null> {
  let url: URL
  try {
    url = new URL(page.url())
  } catch {
    return null
  }
  if (/greenhouse\.io$/.test(url.hostname) && url.searchParams.get('error') === 'true') {
    return 'This posting looks closed: Greenhouse sent the browser to the company’s job list instead.'
  }
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 6000) ?? '').catch(() => '')
  if (/(no longer|not currently) accepting applications|this (job|posting|position) (is no longer available|has been (closed|filled))|job (posting )?(not found|has expired)/i.test(text)) {
    return 'This posting looks closed: the page says it is no longer accepting applications.'
  }
  return null
}

/**
 * Workday and some others want an account first. Detect it rather than typing into a login box.
 * Two shapes: a visible password field next to sign-in wording, or a chooser with no form at all
 * ("Sign in with Google / Apple / email", "Create Account") — Workday's current sign-in page.
 * An email-only first step (iCIMS: email + "I agree", password comes after Next) is not a wall —
 * the filler can do that page.
 */
async function detectLoginWall(page: Page): Promise<string | null> {
  const host = (): string => new URL(page.url()).hostname
  for (const f of page.frames()) {
    const pw = await f.locator('input[type="password"]:visible').count().catch(() => 0)
    if (pw === 0) continue
    const signIn = (await f.locator('text=/sign in|log in|create account/i').count().catch(() => 0)) > 0
    if (signIn) return `${host()} wants you to sign in or create an account first.`
  }
  const chooser = await page
    .locator('button:visible, a:visible, [role="button"]:visible')
    .filter({ hasText: /sign in with (google|apple|email|linkedin|microsoft)|create account|(sign|log) in to (apply|continue)/i })
    .count()
    .catch(() => 0)
  if (chooser === 0) return null
  const fields = await page
    .locator('input:not([type="hidden"]):not([type="file"]):visible, select:visible, textarea:visible')
    .count()
    .catch(() => 0)
  return fields <= 1 ? `${host()} wants you to sign in or create an account first.` : null
}

/**
 * A "Fill this page" button in the banner as a manual fallback for `followSteps`. The binding is
 * callable by page scripts, so it refuses to run anywhere but the site the application started on:
 * a redirect to some other site must not be able to pull your details.
 */
async function installRefill(page: Page, item: JobItem, allowedHost: string): Promise<void> {
  const allowed = allowedOn(page, allowedHost)
  try {
    await page.exposeBinding('__brieflyRefill', async (source) => {
      if (source.frame !== page.mainFrame()) return
      if (!allowed()) {
        await banner(page, { note: `Not filling on ${new URL(page.url()).hostname}: this isn’t where the application started.` })
        return
      }
      const report = await fillPage(await formFrame(page), item, loadCandidate())
      recordReport(item.id, report)
      await banner(page, { report })
      onChange?.()
    })
  } catch {
    /* binding already exists on this page */
  }
}

/** True while the tab is still on the site the application started on (or a known ATS). */
function allowedOn(page: Page, allowedHost: string): () => boolean {
  return () => {
    try {
      const host = new URL(page.url()).hostname
      return (host === allowedHost || sameSite(host, allowedHost)) && onFillableHost(page, allowedHost)
    } catch {
      return false
    }
  }
}

const following = new WeakSet<Page>()
const STEP_POLL_MS = 1500

/**
 * Keep filling as the applicant moves through a multi-step application (Workday, iCIMS, most
 * unknown systems): poll the tab, and whenever the sign-in wall is gone and the visible form is
 * one that has not been filled yet, fill it. `filledSig` is the form already filled on this page
 * (empty when nothing was). Never presses Next or Submit — the applicant reviews each step. The
 * banner is repainted after navigations (Workday reloads after sign-in) so the status stays put.
 */
function followSteps(page: Page, item: JobItem, allowedHost: string, filledSig: string): void {
  if (following.has(page)) return
  following.add(page)
  const allowed = allowedOn(page, allowedHost)
  let lastSig = filledSig
  let pending = ''
  let busy = false
  const timer = setInterval(async () => {
    if (page.isClosed()) {
      clearInterval(timer)
      return
    }
    if (busy || !allowed()) return
    busy = true
    try {
      await repaintBanner(page)
      if (await detectLoginWall(page)) return
      const frame = await formFrame(page)
      const sig = await formSignature(frame)
      if (!sig || sig === lastSig) {
        pending = ''
        return
      }
      // A step still rendering changes between ticks; fill once it holds still for one interval.
      if (sig !== pending) {
        pending = sig
        return
      }
      pending = ''
      const report = await fillPage(frame, item, loadCandidate())
      // Conditional fields the fill revealed are part of this step now; don't treat them as a new one.
      lastSig = await formSignature(frame).catch(() => sig)
      if (report.filled.length + report.drafted.length + report.unfilled.length > 0 || report.resumeUploaded) {
        recordReport(item.id, report)
        await banner(page, { report, note: 'Review this page, press Next, and briefly fills the next one.' })
        onChange?.()
      }
    } catch {
      /* mid-navigation; try again next tick */
    } finally {
      busy = false
    }
  }, STEP_POLL_MS)
  page.on('close', () => clearInterval(timer))
}

/**
 * Identity of the form on screen: visible controls by tag, type, name, id, Workday automation id
 * and label. Values are left out so typing never reads as a new step. File inputs count even when
 * hidden — drop zones (Workday's resume step) keep theirs off-screen.
 */
async function formSignature(frame: Frame): Promise<string> {
  return frame.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>('input:not([type=hidden]), select, textarea, [role="combobox"], [role="listbox"], [role="radio"], [role="checkbox"]')
    )
    return els
      .filter((e) => e.getAttribute('type') === 'file' || e.getClientRects().length > 0)
      .map((e) => [e.tagName, e.getAttribute('type'), e.getAttribute('name'), e.id, e.getAttribute('data-automation-id'), e.getAttribute('aria-label')].join('|'))
      .join('\n')
  })
}

function sameSite(a: string, b: string): boolean {
  const root = (h: string): string => h.split('.').slice(-2).join('.')
  return root(a) === root(b)
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

const lastBanner = new WeakMap<Page, string>()

async function banner(page: Page, content: { report?: FillReport; note?: string }): Promise<void> {
  const r = content.report
  const lines: string[] = []
  if (r) {
    lines.push(`<b>${r.filled.length}</b> filled from your profile <span style="color:#10b981">■</span>`)
    if (r.drafted.length) lines.push(`<b>${r.drafted.length}</b> drafted by the model <span style="color:#f59e0b">■</span> — read before you submit`)
    lines.push(r.resumeUploaded ? 'resume.pdf attached' : 'resume not attached')
    if (r.unfilled.length) lines.push(`<b>${r.unfilled.length}</b> for you: ${r.unfilled.slice(0, 6).map((u) => esc(u.label)).join(' · ')}${r.unfilled.length > 6 ? ' …' : ''}`)
  }
  if (content.note) lines.push(esc(content.note))
  const html = lines.join(' &nbsp;·&nbsp; ')
  lastBanner.set(page, html)
  await paintBanner(page, html)
}

/** Navigations (Workday reloads after sign-in) drop the bar; put the last one back if it's gone. */
async function repaintBanner(page: Page): Promise<void> {
  const html = lastBanner.get(page)
  if (!html) return
  const present = await page
    .evaluate(() => Boolean(document.getElementById('briefly-banner')) || Boolean((window as unknown as { __brieflyBannerClosed?: boolean }).__brieflyBannerClosed))
    .catch(() => true)
  if (!present) await paintBanner(page, html)
}

async function paintBanner(page: Page, html: string): Promise<void> {
  await page.evaluate((html) => {
    let el = document.getElementById('briefly-banner')
    if (!el) {
      el = document.createElement('div')
      el.id = 'briefly-banner'
      el.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#111;color:#f4f4f5;font:13px/1.4 -apple-system,Inter,sans-serif;padding:10px 14px;display:flex;gap:12px;align-items:center;box-shadow:0 2px 12px rgba(0,0,0,.35)'
      document.documentElement.style.scrollPaddingTop = '48px'
      document.body.style.marginTop = (parseInt(getComputedStyle(document.body).marginTop) || 0) + 44 + 'px'
      document.body.appendChild(el)
    }
    el.innerHTML =
      '<span style="font-weight:700;letter-spacing:.02em">briefly</span>' +
      `<span style="flex:1;min-width:0">${html}</span>` +
      '<span style="opacity:.7">You press Submit.</span>' +
      '<button id="briefly-refill" style="background:#27272a;color:#fff;border:1px solid #3f3f46;border-radius:6px;padding:4px 10px;font:12px inherit;cursor:pointer">Fill this page</button>' +
      '<button id="briefly-close" style="background:none;color:#a1a1aa;border:0;font-size:16px;cursor:pointer">×</button>'
    document.getElementById('briefly-close')!.onclick = () => {
      el!.remove()
      ;(window as unknown as { __brieflyBannerClosed?: boolean }).__brieflyBannerClosed = true
    }
    document.getElementById('briefly-refill')!.onclick = () => {
      const w = window as unknown as { __brieflyRefill?: () => Promise<void> }
      void w.__brieflyRefill?.()
    }
  }, html)
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string)
}

// ---------------------------------------------------------------------------
// Submit watcher
// ---------------------------------------------------------------------------

const watched = new WeakSet<Page>()

/**
 * Flip the card to Applied only when a confirmation appears that was not already on the page
 * when we started watching. Posting boilerplate ("thank you for your interest", Workday's "you
 * have already applied") trips the regex on tick one otherwise; a baseline of matched phrases
 * at watch start filters those out, and a URL change to a thanks page always counts.
 */
function watchForSubmit(page: Page, item: JobItem): void {
  if (watched.has(page)) return
  watched.add(page)
  let done = false
  let baseline: Set<string> | null = null
  const finish = (submitted: boolean): void => {
    if (done) return
    done = true
    clearInterval(timer)
    if (submitted) {
      setStatus(item.id, 'applied')
      setPrepared(item.id, { submittedAt: new Date().toISOString() })
      if (getNotificationsEnabled() && Notification.isSupported()) {
        new Notification({ title: `${item.company} — marked applied`, body: 'briefly saw the confirmation page.', silent: true }).show()
      }
    } else {
      setPrepared(item.id, { closedAt: new Date().toISOString() })
    }
    onChange?.()
  }
  const phrases = (text: string): Set<string> => {
    const out = new Set<string>()
    const re = new RegExp(SUCCESS_RE.source, 'gi')
    for (const m of text.replace(/briefly.*?You press Submit\./s, '').matchAll(re)) out.add(m[0].toLowerCase())
    return out
  }
  const startUrl = page.url()
  const check = async (): Promise<void> => {
    if (page.isClosed()) return finish(false)
    try {
      const url = page.url()
      if (url !== startUrl && /confirmation|\/thanks\b|thank-you|applied=true|submitted/i.test(url)) return finish(true)
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 20_000) ?? '')
      const found = phrases(text)
      if (!baseline) {
        baseline = found
        return
      }
      for (const p of found) if (!baseline.has(p)) return finish(true)
    } catch {
      /* navigating; try again next tick */
    }
  }
  void check()
  const timer = setInterval(() => void check(), 2500)
  page.on('close', () => finish(false))
}

// ---------------------------------------------------------------------------
// jobright → employer link
// ---------------------------------------------------------------------------

/**
 * jobright pages wrap the employer's posting. Their "Apply" control is a link to the real ATS
 * (sometimes behind an interstitial). Find the first outbound apply link that isn't jobright itself.
 * Returns 'login' when jobright answers the Apply click with its sign-up dialog instead.
 */
async function resolveJobrightOnPage(page: Page): Promise<string | 'login' | null> {
  await page.waitForTimeout(1500)
  const hrefs = await page.evaluate(() => {
    const out: string[] = []
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      const t = (a.innerText || a.getAttribute('aria-label') || '').toLowerCase()
      if (/apply|original|company (site|page)|view job/.test(t) || /apply/i.test(a.className)) out.push(a.href)
    }
    return out
  })
  const external = hrefs.find((h) => /^https:\/\//.test(h) && !/jobright\.ai/.test(new URL(h).hostname))
  if (external) return external
  // Some builds open the employer in a new tab via a button; try clicking and capturing the popup.
  const btn = page.getByRole('button', { name: /^apply( now)?$/i }).first()
  if ((await btn.count()) === 0) return null
  const popup = page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null)
  await btn.click({ timeout: 3000 }).catch(() => undefined)
  const p = await popup
  if (p) {
    await p.waitForLoadState('domcontentloaded').catch(() => undefined)
    const url = p.url()
    await p.close().catch(() => undefined)
    return /jobright\.ai/.test(new URL(url).hostname) ? null : url
  }
  // Logged out, jobright answers the click with a "Sign up to apply" dialog.
  if ((await page.locator('text=/sign (up|in) to apply|already a member/i').count()) > 0) return 'login'
  await page.waitForLoadState('domcontentloaded').catch(() => undefined)
  const url = page.url()
  return /jobright\.ai/.test(new URL(url).hostname) ? null : url
}

export type { PreparedInfo }
