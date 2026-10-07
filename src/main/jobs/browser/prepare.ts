/// <reference lib="dom" />
import { Notification } from 'electron'
import type { Page } from 'playwright'
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
export function supportedAts(url: string): Ats | 'jobright' | null {
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
  } catch {
    /* ignore */
  }
  return null
}

/** Fill only while the tab is on a system we meant to fill; a redirect elsewhere gets nothing. */
function onFillableHost(page: Page): boolean {
  const ats = supportedAts(page.url())
  return ats !== null && ats !== 'jobright'
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
  const ats = supportedAts(startUrl)
  if (!ats) return { ok: false, error: 'This application system is not supported for auto-fill yet.' }
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

  const run = runPreparation(page, item, ats, previous)
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

async function runPreparation(page: Page, item: JobItem, ats: Ats | 'jobright', previous: JobStatus): Promise<void> {
  try {
    if (ats === 'jobright') {
      const target = await resolveJobrightOnPage(page)
      if (target === 'login') {
        throw new Error('jobright wants you to sign in before it shows the employer link. Sign in once in this window (it stays signed in), then press Apply on the card again.')
      }
      if (!target) throw new Error('Could not find the employer’s application link on jobright. Use its Apply button.')
      setResolvedUrl(item.id, target)
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      const real = supportedAts(target)
      setPrepared(item.id, { ats: real ?? 'unknown' })
      if (!real || real === 'jobright') {
        setPrepared(item.id, { finishedAt: new Date().toISOString(), error: 'The employer uses an application system briefly cannot fill yet.' })
        await banner(page, { note: 'briefly opened the employer’s page. This system isn’t auto-filled; fill it by hand.' })
        watchForSubmit(page, item)
        return
      }
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
      await banner(page, { note: `${loginWall} briefly will fill the form once you are past it — click “Fill this page” in this bar.` })
      await installRefill(page, item)
      watchForSubmit(page, item)
      onChange?.()
      return
    }
    if (!onFillableHost(page)) {
      // The posting link or an Apply button took us somewhere that is not an ATS we fill.
      const note = `Not filling on ${new URL(page.url()).hostname}: this isn’t an application system briefly fills. Finish it by hand.`
      setPrepared(item.id, { finishedAt: new Date().toISOString(), error: note })
      await banner(page, { note })
      watchForSubmit(page, item)
      return
    }
    const report = await fillPage(page, item, loadCandidate())
    recordReport(item.id, report)
    if (report.filled.length + report.unfilled.length + report.drafted.length === 0 && !report.resumeUploaded) {
      // Nothing scanned: the form is probably behind a button we did not find, or on another step.
      const note = 'No form fields found on this page. Get to the application form on the site, then click “Fill this page”.'
      setPrepared(item.id, { error: note })
      await banner(page, { note })
    } else {
      await banner(page, { report })
    }
    await installRefill(page, item)
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
  const hasField = async (): Promise<boolean> =>
    (await page.locator('input[type="email"], input[name*="email" i], input[autocomplete="given-name"], input#first_name, input[name*="first" i], [data-automation-id="legalNameSection_firstName"]').count()) > 0
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined)
  if (await hasField()) return
  // Ashby: the posting lives at /{org}/{id}; the form is the same URL plus /application.
  const ashby = page.url().match(/^(https:\/\/jobs\.ashbyhq\.com\/[^/?#]+\/[0-9a-f-]{20,})\/?(\?.*)?$/i)
  if (ashby) {
    await page.goto(`${ashby[1]}/application`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined)
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined)
  } else {
    const apply = page
      .getByRole('button', { name: /^apply( now| for this job| for this position)?$/i })
      .or(page.getByRole('link', { name: /^apply( now| for this job| for this position)?$/i }))
      .or(page.locator('a[href*="/apply"], a[href$="/application"], a.postings-btn, [data-automation-id="adventureButton"]'))
    let clicked = false
    for (let i = 0; i < 8 && !clicked; i++) {
      if ((await apply.count()) > 0) {
        await apply.first().click({ timeout: 5000 }).catch(() => undefined)
        await page.waitForLoadState('domcontentloaded').catch(() => undefined)
        clicked = true
      } else {
        await page.waitForTimeout(500)
      }
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

/** Workday and some others want an account first. Detect it rather than typing into a login box. */
async function detectLoginWall(page: Page): Promise<string | null> {
  const pw = page.locator('input[type="password"]:visible')
  if ((await pw.count()) === 0) return null
  const host = new URL(page.url()).hostname
  const signIn = (await page.locator('text=/sign in|log in|create account/i').count()) > 0
  return signIn ? `${host} wants you to sign in or create an account first.` : null
}

/**
 * A "Fill this page" button in the banner so multi-step forms (Workday) can be filled step by
 * step. The binding is callable by page scripts, so it refuses to run anywhere but the host the
 * application started on: a redirect to some other site must not be able to pull your details.
 */
async function installRefill(page: Page, item: JobItem): Promise<void> {
  const allowedHost = new URL(page.url()).hostname
  try {
    await page.exposeBinding('__brieflyRefill', async (source) => {
      if (source.frame !== page.mainFrame()) return
      const host = new URL(page.url()).hostname
      if ((host !== allowedHost && !sameSite(host, allowedHost)) || !onFillableHost(page)) {
        await banner(page, { note: `Not filling on ${host}: this isn’t where the application started.` })
        return
      }
      const report = await fillPage(page, item, loadCandidate())
      recordReport(item.id, report)
      await banner(page, { report })
      onChange?.()
    })
  } catch {
    /* binding already exists on this page */
  }
}

function sameSite(a: string, b: string): boolean {
  const root = (h: string): string => h.split('.').slice(-2).join('.')
  return root(a) === root(b)
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

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
    document.getElementById('briefly-close')!.onclick = () => el!.remove()
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
