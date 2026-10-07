import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { addDays, localDay } from '../../shared/dates'
import {
  courseKey,
  FEED_KINDS,
  type AnnouncementSuggestion,
  type LmsKind,
  type LmsStatus,
  type SchoolItem,
  type SchoolKind
} from '../../shared/school'
import { getSchoolConfig, llmConfigured } from '../settings'
import { completeJson } from '../llm'
import { stripHtml } from '../jobs/normalize'
import { availableBrowser, getContext, openPage } from '../browser/session'
import { classifyTitle } from './ics'
import { localParts as gsLocalParts, parseGradescopeAssignments, parseGradescopeCourses } from './gradescopeHtml'
import { ensureCourse, load as loadSchool, save as saveSchool } from './store'
import { afterExternalChange, expandRules, syncTasks } from './school'

/**
 * Logged-in LMS sessions. You sign in once in briefly's browser; briefly keeps the cookies
 * (encrypted with the OS keychain, like the feed URL) and from then on reads your own Gradescope
 * dashboard and Canvas API with plain HTTPS requests — no browser window for the periodic sync.
 *
 * Gradescope: course list → each course's assignment table (name, due, submitted or not).
 * Canvas: every assignment incl. submission state (the calendar feed cannot say "submitted"), and
 * recent announcements, which the model reads for dates ("HW4 is posted, due Friday") and turns
 * into suggestions you confirm.
 *
 * All HTML selectors here are the ones maintained community scrapers use (nyuoss/gradescope-api);
 * a Gradescope redesign breaks the parser until it is patched, and the sync says so rather than
 * silently returning nothing.
 */

const GS = 'https://www.gradescope.com'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 briefly'
const LOGIN_WAIT_MS = 5 * 60_000
const SYNC_EVERY_MS = 6 * 3600_000
const MAX_BODY = 3_000_000
const ANNOUNCEMENT_DAYS = 14
const PAST_DAYS = 45
const FUTURE_DAYS = 150

// ---------------------------------------------------------------------------
// Session store (lms.json)
// ---------------------------------------------------------------------------

interface Session {
  /** base64 of safeStorage-encrypted JSON `{ name: value }`. */
  cookiesEnc: string | null
  connectedAt: string | null
  lastSyncAt: string | null
  lastError: string | null
  needsLogin: boolean
  /** Canvas only: the host the cookies belong to. */
  host: string
}

interface LmsStore {
  version: 1
  gradescope: Session
  canvas: Session
  /** Announcement ids already read, so each one costs one model call ever. */
  announcementsSeen: string[]
  suggestions: AnnouncementSuggestion[]
  /** Suggestion ids you dropped; the same announcement never proposes them again. */
  dismissed: string[]
}

function emptySession(): Session {
  return { cookiesEnc: null, connectedAt: null, lastSyncAt: null, lastError: null, needsLogin: false, host: '' }
}

function storePath(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'lms.json')
}

function load(): LmsStore {
  const base: LmsStore = { version: 1, gradescope: emptySession(), canvas: emptySession(), announcementsSeen: [], suggestions: [], dismissed: [] }
  const path = storePath()
  if (!existsSync(path)) return base
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LmsStore>
    return {
      ...base,
      gradescope: { ...emptySession(), ...(raw.gradescope ?? {}) },
      canvas: { ...emptySession(), ...(raw.canvas ?? {}) },
      announcementsSeen: Array.isArray(raw.announcementsSeen) ? raw.announcementsSeen.filter((x): x is string => typeof x === 'string') : [],
      suggestions: Array.isArray(raw.suggestions) ? raw.suggestions : [],
      dismissed: Array.isArray(raw.dismissed) ? raw.dismissed.filter((x): x is string => typeof x === 'string') : []
    }
  } catch (err) {
    console.warn('[lms] store unreadable; starting empty', err)
    return base
  }
}

function save(store: LmsStore): void {
  const path = storePath()
  writeFileSync(path + '.tmp', JSON.stringify(store, null, 2))
  renameSync(path + '.tmp', path)
}

function readCookies(s: Session): Record<string, string> | null {
  if (!s.cookiesEnc) return null
  try {
    const obj = JSON.parse(safeStorage.decryptString(Buffer.from(s.cookiesEnc, 'base64'))) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v
    return Object.keys(out).length ? out : null
  } catch {
    return null
  }
}

function writeCookies(s: Session, cookies: Record<string, string>): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('This Mac cannot encrypt secrets (keychain unavailable), so briefly will not store a login session.')
  s.cookiesEnc = safeStorage.encryptString(JSON.stringify(cookies)).toString('base64')
}

function cookieHeader(c: Record<string, string>): string {
  return Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/** Rails rotates the session cookie; keep whatever the server sends back so the login stays fresh. */
function absorbSetCookies(c: Record<string, string>, headers: Headers): boolean {
  let changed = false
  const raw = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  for (const line of raw) {
    const m = line.match(/^([^=;\s]+)=([^;]*)/)
    if (!m) continue
    const [, name, value] = m
    if (/max-age=0|expires=thu, 01 jan 1970/i.test(line)) {
      if (name in c) {
        delete c[name]
        changed = true
      }
    } else if (c[name] !== value) {
      c[name] = value
      changed = true
    }
  }
  return changed
}

export function getLmsStatus(): LmsStatus[] {
  const s = load()
  const one = (kind: LmsKind, x: Session): LmsStatus => ({
    kind,
    connected: Boolean(x.cookiesEnc),
    connectedAt: x.connectedAt,
    lastSyncAt: x.lastSyncAt,
    lastError: x.lastError,
    needsLogin: x.needsLogin,
    host: kind === 'canvas' ? x.host : ''
  })
  return [one('gradescope', s.gradescope), one('canvas', s.canvas)]
}

export function getAnnouncementSuggestions(): AnnouncementSuggestion[] {
  return load().suggestions
}

export function browserAvailable(): boolean {
  return availableBrowser() !== null
}

export function disconnectLms(kind: LmsKind): void {
  const store = load()
  store[kind] = emptySession()
  save(store)
}

// ---------------------------------------------------------------------------
// Authenticated fetch
// ---------------------------------------------------------------------------

class NeedsLoginError extends Error {
  constructor() {
    super('Signed out. Reconnect to keep syncing.')
    this.name = 'NeedsLoginError'
  }
}

async function authedFetch(url: string, cookies: Record<string, string>, accept: string): Promise<{ status: number; text: string; location: string | null; cookiesChanged: boolean }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 25_000)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'manual',
      headers: { 'user-agent': UA, accept, cookie: cookieHeader(cookies) }
    })
    const cookiesChanged = absorbSetCookies(cookies, r.headers)
    const location = r.headers.get('location')
    if (r.status >= 300 && r.status < 400) return { status: r.status, text: '', location, cookiesChanged }
    const declared = Number(r.headers.get('content-length') ?? 0)
    if (declared > MAX_BODY) throw new Error('response too large')
    const text = await r.text()
    if (text.length > MAX_BODY) throw new Error('response too large')
    return { status: r.status, text, location, cookiesChanged }
  } finally {
    clearTimeout(t)
  }
}

// ---------------------------------------------------------------------------
// Connect: sign in once in briefly's browser, keep the cookies
// ---------------------------------------------------------------------------

let connecting: LmsKind | null = null

export function lmsConnecting(): LmsKind | null {
  return connecting
}

/**
 * Opens the LMS login page in briefly's browser and waits (up to five minutes) for you to sign
 * in. The moment the page is authenticated the cookies are copied out, the tab is closed, and a
 * first sync runs. Your password never passes through briefly.
 */
export async function connectLms(kind: LmsKind): Promise<{ ok: boolean; error?: string }> {
  if (connecting) return { ok: false, error: `Already waiting for a ${connecting} sign-in.` }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'This Mac cannot encrypt secrets, so briefly will not store a login session.' }
  const host = kind === 'canvas' ? getSchoolConfig().feedHost : 'www.gradescope.com'
  if (!host) return { ok: false, error: 'Add your Canvas calendar feed in Settings first — it tells briefly which Canvas to sign in to.' }
  const origin = `https://${host}`
  connecting = kind
  let page: Page | null = null
  try {
    page = await openPage(kind === 'canvas' ? `${origin}/login` : `${GS}/login`)
    const deadline = Date.now() + LOGIN_WAIT_MS
    let authed = false
    while (Date.now() < deadline) {
      if (page.isClosed()) return { ok: false, error: 'The sign-in tab was closed before you finished.' }
      try {
        if (kind === 'gradescope' ? await gradescopeLoggedIn(page) : await canvasLoggedIn(page, host)) {
          authed = true
          break
        }
      } catch {
        /* navigating */
      }
      await page.waitForTimeout(1500)
    }
    if (!authed) return { ok: false, error: 'No sign-in seen within five minutes. Try Connect again when you are ready.' }
    const ctx = await getContext()
    const jar = await ctx.cookies(origin)
    const cookies: Record<string, string> = {}
    for (const c of jar) cookies[c.name] = c.value
    if (!Object.keys(cookies).length) return { ok: false, error: 'Signed in, but no session cookies were found to keep.' }
    const store = load()
    const s = store[kind]
    writeCookies(s, cookies)
    s.connectedAt = new Date().toISOString()
    s.needsLogin = false
    s.lastError = null
    s.host = kind === 'canvas' ? host : ''
    save(store)
    await page.close().catch(() => undefined)
    page = null
    const r = await syncLms(kind, true)
    return r.ok ? { ok: true } : { ok: true, error: r.error }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.split('\n')[0] : String(err) }
  } finally {
    connecting = null
    if (page && !page.isClosed()) await page.close().catch(() => undefined)
  }
}

async function gradescopeLoggedIn(page: Page): Promise<boolean> {
  const url = page.url()
  if (!/gradescope\.com/.test(url) || /\/login|\/saml|\/auth/.test(url)) return false
  return (await page.locator('#account-show, .courseList, a[href="/logout"], form[action="/logout"]').count()) > 0
}

async function canvasLoggedIn(page: Page, host: string): Promise<boolean> {
  const url = page.url()
  if (!url.includes(host) || /\/login/.test(url)) return false
  // The web UI calls the API with the session cookie; if that works for us, it works for the sync.
  const ok = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/v1/users/self', { headers: { accept: 'application/json' } })
      return r.ok
    } catch {
      return false
    }
  })
  return Boolean(ok)
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

let syncing = false

export interface LmsSyncResult {
  ok: boolean
  error?: string
  added: number
  updated: number
  /** New announcement suggestions this pass produced. */
  suggested: number
}

/** Periodic entry point: runs each connected LMS whose last sync is older than six hours. */
export async function syncLmsIfDue(): Promise<void> {
  const store = load()
  for (const kind of ['gradescope', 'canvas'] as LmsKind[]) {
    const s = store[kind]
    if (!s.cookiesEnc || s.needsLogin) continue
    if (s.lastSyncAt && Date.now() - Date.parse(s.lastSyncAt) < SYNC_EVERY_MS) continue
    await syncLms(kind)
  }
}

export async function syncLms(kind: LmsKind, force = false): Promise<LmsSyncResult> {
  const none = (error: string): LmsSyncResult => ({ ok: false, error, added: 0, updated: 0, suggested: 0 })
  if (syncing) return none('A sync is already running.')
  const store = load()
  const s = store[kind]
  const cookies = readCookies(s)
  if (!cookies) return none(`${kind === 'canvas' ? 'Canvas' : 'Gradescope'} is not connected.`)
  if (s.needsLogin && !force) return none('Signed out. Reconnect to keep syncing.')
  const startedWith = s.connectedAt
  const pending: PendingAnnouncements = { seen: [], suggestions: [] }
  syncing = true
  // A sync can run for minutes; Disconnect, Reconnect, or accepting a suggestion may land in the
  // meantime. Every write goes onto a freshly loaded store and only touches what this sync owns,
  // and the session fields are left alone if the session was replaced or removed while we ran.
  const commit = (fn: (fresh: Session) => void): void => {
    const fresh = load()
    const f = fresh[kind]
    if (f.cookiesEnc && f.connectedAt === startedWith) fn(f)
    mergeAnnouncements(fresh, pending)
    save(fresh)
  }
  try {
    const r = kind === 'gradescope' ? await syncGradescope(cookies) : await syncCanvas(cookies, s.host, store, pending)
    commit((f) => {
      f.lastSyncAt = new Date().toISOString()
      f.lastError = null
      f.needsLogin = false
      writeCookies(f, cookies)
    })
    expandRules()
    syncTasks()
    afterExternalChange()
    return { ok: true, ...r }
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : String(err)
    commit((f) => {
      f.lastSyncAt = new Date().toISOString()
      f.lastError = msg
      if (err instanceof NeedsLoginError) f.needsLogin = true
    })
    afterExternalChange()
    return none(msg)
  } finally {
    syncing = false
  }
}

/** What one announcement pass learned, merged into the store only when the sync commits. */
interface PendingAnnouncements {
  seen: string[]
  suggestions: AnnouncementSuggestion[]
}

function mergeAnnouncements(store: LmsStore, p: PendingAnnouncements): void {
  if (!p.seen.length && !p.suggestions.length) return
  for (const k of p.seen) if (!store.announcementsSeen.includes(k)) store.announcementsSeen.push(k)
  if (store.announcementsSeen.length > 1000) store.announcementsSeen = store.announcementsSeen.slice(-1000)
  for (const sug of p.suggestions) {
    if (store.dismissed.includes(sug.id) || store.suggestions.some((x) => x.id === sug.id)) continue
    store.suggestions.push(sug)
  }
  // Drop suggestions whose day has passed; they would only be noise.
  store.suggestions = store.suggestions.filter((x) => (x.due ?? '') >= localDay())
}

interface Incoming {
  id: string
  source: 'gradescope' | 'canvas'
  course: string
  canvasId: string | null
  title: string
  kind: SchoolKind
  due: string
  dueTime: string | null
  url: string | null
  /** Known submitted on the LMS side. */
  submitted: boolean
}

/**
 * Merge LMS rows into the School store. Matches the feed poller's rules: existing items follow
 * the source's title/date; your done/hidden state is never undone; "submitted" marks done.
 */
function upsert(rows: Incoming[]): { added: number; updated: number } {
  const store = loadSchool()
  const now = new Date().toISOString()
  let added = 0
  let updated = 0
  const floor = addDays(localDay(), -PAST_DAYS)
  const ceiling = addDays(localDay(), FUTURE_DAYS)
  for (const r of rows) {
    if (store.deletedIds.includes(r.id)) continue
    if (r.due < floor || r.due > ceiling) continue
    const c = ensureCourse(store, r.course, r.canvasId)
    const existing = store.items.find((i) => i.id === r.id)
    if (existing) {
      let changed = false
      if (existing.due !== r.due || existing.dueTime !== r.dueTime || existing.title !== r.title) changed = true
      existing.due = r.due
      existing.dueTime = r.dueTime
      existing.title = r.title
      existing.url = existing.url ?? r.url
      if (existing.kind === 'other') existing.kind = r.kind
      if (r.submitted && !existing.done) {
        existing.done = true
        existing.doneAt = now
        changed = true
      }
      existing.lastSeenAt = now
      if (changed) updated++
      continue
    }
    const item: SchoolItem = {
      id: r.id,
      source: r.source,
      course: r.course,
      title: r.title,
      kind: r.kind,
      due: r.due,
      dueTime: r.dueTime,
      url: r.url,
      seenAt: now,
      lastSeenAt: now,
      done: r.submitted,
      doneAt: r.submitted ? now : null,
      hidden: false,
      taskId: null,
      satisfiedBy: null
    }
    store.items.push(item)
    if (!r.submitted) c.lastNewItemAt = now
    added++
  }
  saveSchool(store)
  return { added, updated }
}

function localParts(d: Date): { day: string; time: string } {
  return gsLocalParts(d)
}

// ---------------------------------------------------------------------------
// Gradescope
// ---------------------------------------------------------------------------

async function syncGradescope(cookies: Record<string, string>): Promise<{ added: number; updated: number; suggested: number }> {
  const home = await authedFetch(`${GS}/account`, cookies, 'text/html')
  if (home.status >= 300 && home.status < 400) throw new NeedsLoginError()
  if (home.status === 401 || home.status === 403 || /<form[^>]+action="\/login"/i.test(home.text)) throw new NeedsLoginError()
  if (home.status !== 200) throw new Error(`Gradescope returned HTTP ${home.status}.`)
  const courses = parseGradescopeCourses(home.text)
  if (courses.length === 0) {
    if (!/courseList|account-show/.test(home.text)) throw new Error('Gradescope page layout changed; the course list could not be read.')
    return { added: 0, updated: 0, suggested: 0 }
  }
  const rows: Incoming[] = []
  for (const c of courses) {
    const page = await authedFetch(`${GS}/courses/${c.id}`, cookies, 'text/html')
    if (page.status >= 300 && page.status < 400) throw new NeedsLoginError()
    if (page.status !== 200) continue
    for (const a of parseGradescopeAssignments(page.text, c.id)) {
      rows.push({
        id: `gradescope:${a.id}`,
        source: 'gradescope',
        course: c.course,
        canvasId: null,
        title: a.name,
        kind: classifyTitle(a.name, true),
        due: a.due.day,
        dueTime: a.due.time,
        url: `${GS}/courses/${c.id}/assignments/${a.id}`,
        submitted: a.submitted
      })
    }
  }
  return { ...upsert(rows), suggested: 0 }
}

// ---------------------------------------------------------------------------
// Canvas (session-cookie API)
// ---------------------------------------------------------------------------

interface CanvasCourse {
  id: number
  name: string
  course_code: string
}

interface CanvasAssignment {
  id: number
  name: string
  due_at: string | null
  html_url: string
  published?: boolean
  submission?: { workflow_state?: string; submitted_at?: string | null } | null
}

interface CanvasAnnouncement {
  id: number
  title: string
  message: string | null
  posted_at: string | null
  html_url: string
  context_code: string
}

async function canvasJson<T>(host: string, path: string, cookies: Record<string, string>): Promise<T> {
  const r = await authedFetch(`https://${host}${path}`, cookies, 'application/json')
  if (r.status === 401 || (r.status >= 300 && r.status < 400 && /login/.test(r.location ?? ''))) throw new NeedsLoginError()
  if (r.status !== 200) throw new Error(`Canvas returned HTTP ${r.status} for ${path.split('?')[0]}.`)
  // Session-authenticated API responses carry an anti-hijack prefix the browser client strips.
  const body = r.text.replace(/^while\(1\);/, '')
  return JSON.parse(body) as T
}

async function syncCanvas(cookies: Record<string, string>, host: string, lms: LmsStore, pending: PendingAnnouncements): Promise<{ added: number; updated: number; suggested: number }> {
  if (!host) throw new Error('No Canvas host recorded; reconnect.')
  const courses = await canvasJson<CanvasCourse[]>(host, '/api/v1/courses?enrollment_state=active&enrollment_type=student&per_page=50', cookies)
  const rows: Incoming[] = []
  const contexts: string[] = []
  const byContext = new Map<string, string>()
  let failed = 0
  for (const c of Array.isArray(courses) ? courses : []) {
    if (!c || typeof c.id !== 'number') continue
    const key = courseKey(c.course_code || c.name || '')
    if (!/^[A-Z]/.test(key)) continue
    contexts.push(`course_${c.id}`)
    byContext.set(`course_${c.id}`, key)
    // One course with Assignments disabled (403) or a server hiccup must not cost the others.
    let assignments: CanvasAssignment[]
    try {
      assignments = await canvasJson<CanvasAssignment[]>(host, `/api/v1/courses/${c.id}/assignments?per_page=100&include[]=submission&order_by=due_at`, cookies)
    } catch (err) {
      if (err instanceof NeedsLoginError) throw err
      console.warn(`[lms] canvas course ${c.id} skipped`, err instanceof Error ? err.message : err)
      failed++
      continue
    }
    for (const a of Array.isArray(assignments) ? assignments : []) {
      if (!a || typeof a.id !== 'number' || !a.due_at || a.published === false) continue
      const d = new Date(a.due_at)
      if (Number.isNaN(d.getTime())) continue
      const p = localParts(d)
      const state = a.submission?.workflow_state ?? ''
      rows.push({
        // Same id the calendar feed uses, so the two sources describe one item.
        id: `canvas:event-assignment-${a.id}`,
        source: 'canvas',
        course: key,
        canvasId: String(c.id),
        title: String(a.name ?? '').slice(0, 200),
        kind: classifyTitle(String(a.name ?? ''), true),
        due: p.day,
        // Canvas "end of day" deadlines (23:59) read as all-day, matching the feed.
        dueTime: p.time === '23:59' ? null : p.time,
        url: typeof a.html_url === 'string' ? a.html_url : null,
        submitted: state === 'submitted' || state === 'graded' || state === 'pending_review' || Boolean(a.submission?.submitted_at)
      })
    }
  }
  if (failed && failed === byContext.size) throw new Error('Canvas refused every course’s assignment list.')
  const merged = upsert(rows)
  let suggested = 0
  if (contexts.length && llmConfigured()) {
    try {
      suggested = await readAnnouncements(host, cookies, contexts, byContext, lms, pending)
    } catch (err) {
      if (err instanceof NeedsLoginError) throw err
      console.warn('[lms] announcements skipped', err)
    }
  }
  return { ...merged, suggested }
}

// ---------------------------------------------------------------------------
// Announcements → dated suggestions
// ---------------------------------------------------------------------------

const ANNOUNCE_SYSTEM = `You read a university course announcement and pull out any concrete deadline or scheduled obligation for a student.
Return JSON only: {"items":[{"title":string,"kind":"assignment"|"quiz"|"exam"|"project"|"event"|"other","due":"YYYY-MM-DD","time":"HH:MM"|null,"evidence":string,"confidence":"high"|"medium"|"low"}]}
Rules: resolve weekday words ("due Friday") relative to the POSTED date given; never invent a date; if the announcement states no actionable date return {"items":[]}. "evidence" is a verbatim quote (<= 140 chars). Office hours and lecture reminders are not obligations.`

interface AnnounceRaw {
  items?: unknown
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

async function readAnnouncements(host: string, cookies: Record<string, string>, contexts: string[], byContext: Map<string, string>, lms: LmsStore, pending: PendingAnnouncements): Promise<number> {
  const since = addDays(localDay(), -ANNOUNCEMENT_DAYS)
  const qs = contexts.map((c) => `context_codes[]=${encodeURIComponent(c)}`).join('&')
  const list = await canvasJson<CanvasAnnouncement[]>(host, `/api/v1/announcements?${qs}&start_date=${since}&per_page=50`, cookies)
  const school = loadSchool()
  let n = 0
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a.id !== 'number') continue
    const key = `${a.context_code}:${a.id}`
    if (lms.announcementsSeen.includes(key) || pending.seen.includes(key)) continue
    pending.seen.push(key)
    const course = byContext.get(a.context_code)
    if (!course) continue
    const body = stripHtml(String(a.message ?? '')).slice(0, 6000)
    if (body.length < 20) continue
    const posted = a.posted_at ? localDay(a.posted_at) : localDay()
    let raw: AnnounceRaw
    try {
      raw = await completeJson<AnnounceRaw>(ANNOUNCE_SYSTEM, `POSTED ${posted} in ${course}.\nTITLE: ${a.title}\n\n${body}`)
    } catch (err) {
      console.warn('[lms] announcement read failed', err)
      continue
    }
    for (const it of Array.isArray(raw?.items) ? raw.items : []) {
      if (!it || typeof it !== 'object') continue
      const o = it as Record<string, unknown>
      const title = String(o.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      const due = String(o.due ?? '')
      if (!title || !DAY_RE.test(due) || Number.isNaN(Date.parse(due + 'T12:00:00'))) continue
      const id = `ann:${a.id}:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`
      if (lms.dismissed.includes(id) || lms.suggestions.some((s) => s.id === id) || pending.suggestions.some((s) => s.id === id)) continue
      // Already on the ledger (same course, same day, similar title): nothing to ask.
      const dup = school.items.some((i) => i.course === course && i.due === due && similar(i.title, title))
      if (dup) continue
      const time = String(o.time ?? '')
      pending.suggestions.push({
        id,
        type: 'item',
        course,
        title,
        kind: FEED_KINDS.includes(o.kind as SchoolKind) ? (o.kind as SchoolKind) : classifyTitle(title, true),
        due,
        time: TIME_RE.test(time) ? time : null,
        evidence: String(o.evidence ?? '').slice(0, 160),
        confidence: o.confidence === 'high' || o.confidence === 'medium' ? o.confidence : 'low',
        from: String(a.title ?? '').slice(0, 120),
        url: typeof a.html_url === 'string' ? a.html_url : null,
        postedAt: a.posted_at ?? new Date().toISOString()
      })
      n++
    }
  }
  return n
}

function similar(a: string, b: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const x = norm(a)
  const y = norm(b)
  return x === y || x.includes(y) || y.includes(x)
}

export function resolveAnnouncementSuggestion(id: string, accept: boolean): AnnouncementSuggestion | null {
  const lms = load()
  const idx = lms.suggestions.findIndex((s) => s.id === id)
  if (idx === -1) return null
  const [s] = lms.suggestions.splice(idx, 1)
  if (!accept) lms.dismissed.push(id)
  if (lms.dismissed.length > 500) lms.dismissed = lms.dismissed.slice(-500)
  save(lms)
  return accept ? s : null
}
