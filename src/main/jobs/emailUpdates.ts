import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JobSource, JobStatus, JobTerm } from '../../shared/jobs'
import { detectTerm } from './normalize'

/**
 * Email drops a JSON file; briefly only reads it. Processed ids live in jobs.json
 * (`emailImports`) so a repeated scan is a no-op and a bad file never reaches the store.
 */
export const EMAIL_UPDATES_FILE = process.env.BRIEFLY_EMAIL_FILE ?? join(homedir(), '.briefly', 'email-updates.json')

export const EMAIL_UPDATES_VERSION = 1
/** Refuse the whole file above this. A partial read must not become a partial import. */
export const MAX_EMAIL_BYTES = 2_000_000
export const MAX_EMAIL_ENTRIES = 5_000
const MAX_ID = 200
const MAX_TEXT = 300
const MAX_NOTE = 2_000

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
/** Datetimes need an explicit offset. A zone-less "19:00" would mean a different hour on every machine. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

const STATUS_WORDS: Record<string, JobStatus> = {
  applied: 'applied',
  oa: 'oa',
  'online assessment': 'oa',
  assessment: 'oa',
  interview: 'interview',
  interviewing: 'interview',
  offer: 'offer',
  rejected: 'rejected',
  rejection: 'rejected'
}

/** Higher wins. `rejected` is not on this ladder; it is allowed in from any status, like `offer`. */
const RANK: Partial<Record<JobStatus, number>> = {
  new: 0,
  saved: 1,
  applying: 2,
  applied: 3,
  oa: 4,
  interview: 5,
  offer: 6
}

const ROLE_NOISE = new Set([
  'university',
  'campus',
  'usa',
  'new',
  'grad',
  'graduate',
  'undergraduate',
  'program',
  'position',
  'role',
  'the',
  'and',
  'for',
  'full',
  'time',
  'early',
  'career',
  'careers',
  'year',
  'years'
])
/** Words that may appear on only one side without making two titles different roles. */
const ROLE_EXTRA = new Set([...ROLE_NOISE, 'development'])

const COMPANY_REST =
  /^(chase|company|group|labs|lab|inc|corp|capital|securities|bank|markets|technologies|technology|tech|ai|hq|io)$/

export interface EmailDeadline {
  /** As written in the file: YYYY-MM-DD, or an ISO-8601 instant with a timezone offset. */
  at: string
  /** Calendar day the task should use. For a datetime this is the machine's local day of that instant. */
  day: string
  /** Set when `at` is a clock time. Null for a date-only deadline (the daily notification covers those). */
  dueAt: string | null
  dateOnly: boolean
  kind?: string
  platform?: string
  /** Shown in the task text when the assistant already formatted the time ("Dec 3, 2:58 PM PT"). */
  display?: string
}

export interface EmailEntry {
  id: string
  company: string
  role: string
  status: JobStatus
  /** When the status happened. Date-only is the start of that local day for "is this newer?" checks. */
  eventAt: string
  appliedAt?: string
  subject?: string
  emailAt?: string
  note?: string
  deadline?: EmailDeadline
}

export interface Skip {
  index: number
  id: string | null
  reason: string
}

export interface FileResult {
  ok: boolean
  missing: boolean
  error: string | null
  entries: EmailEntry[]
  skipped: Skip[]
  warnings: string[]
  duplicates: number
}

export interface EmailLedgerEntry {
  fingerprint: string
  trackerId: string
  status: JobStatus
  eventAt: string
  /**
   * Event time that was actually written onto the tracker row from this entry.
   * Null when the entry was recorded but did not change the status (stale, downgrade, or manual).
   * A later file cannot move the row with an older event than the newest one of these.
   */
  statusEventAt: string | null
  taskId: string | null
  /** The linked task was completed or deleted. Never create another for this entry. */
  taskClosed: boolean
  dueKey: string | null
}

export interface MatchRow {
  id: string
  company: string
  title: string
  status: JobStatus
  updatedAt: string
  /** `inherited === false` on the user state: a person set this status. */
  manual: boolean
  note: string
  appliedAt: string | null
  url: string
  term: JobTerm
  source: JobSource
  location: string | null
  hasState: boolean
}

export interface TaskSnap {
  id: string
  externalId: string | null
  state: string
  deadline: string | null
  dueAt: string | null
  text: string
  /** The person edited the task after it was created. Don't replace their wording. */
  touched: boolean
}

export interface StatusPatch {
  id: string
  status?: JobStatus
  note?: string
  appliedAt?: string
  updatedAt?: string
  /** Email superseded an older manual status; stop treating that old edit as the latest word. */
  clearManual?: boolean
  create?: {
    company: string
    title: string
    url: string
    term: JobTerm
    source: JobSource
    location: string | null
    note: string
    status: JobStatus
    appliedAt: string | null
    updatedAt: string
  }
}

export interface TaskWrite {
  externalId: string
  action: 'create' | 'update'
  text: string
  deadline: string
  dueAt: string | null
  priority: 'high' | 'medium' | 'low'
  horizon: 'now' | 'soon'
  updateText: boolean
}

export interface ApplyOutcome {
  dirty: boolean
  patches: StatusPatch[]
  ledger: Record<string, EmailLedgerEntry>
  taskWrites: TaskWrite[]
  matched: number
  created: number
  statusUpdated: number
  ambiguous: number
  manualKept: number
  unchanged: number
  tasksClosed: number
  warnings: string[]
}

export interface EmailCommitState {
  status: JobStatus
  note: string
  appliedAt?: string | null
  inherited?: boolean
  updatedAt: string
  promotedTaskId: string | null
  openedInAsideAt: string | null
  snapshot: {
    company: string
    title: string
    url: string
    term: JobTerm
    source: JobSource
    location?: string | null
  }
}

export interface EmailCommitStore {
  state: Record<string, EmailCommitState>
  emailImports?: Record<string, EmailLedgerEntry>
}

const emptyFile = (): FileResult => ({
  ok: true,
  missing: false,
  error: null,
  entries: [],
  skipped: [],
  warnings: [],
  duplicates: 0
})

/**
 * False for a missing, empty, or rejected file. importEmailUpdates uses this so jobs.json
 * is not opened — and therefore cannot be rewritten — when the drop is unusable.
 */
export function shouldTouchJobs(file: FileResult): boolean {
  return file.ok && !file.missing && file.entries.length > 0
}

/** Missing file is not an error — the assistant may not have written one yet. */
export function readEmailUpdates(path = EMAIL_UPDATES_FILE): FileResult {
  if (!existsSync(path)) return { ...emptyFile(), missing: true }
  let size = 0
  try {
    size = statSync(path).size
  } catch (err) {
    return { ...emptyFile(), ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (size > MAX_EMAIL_BYTES) {
    return {
      ...emptyFile(),
      ok: false,
      error: `email-updates.json is ${size} bytes (limit ${MAX_EMAIL_BYTES}); left the tracker untouched`
    }
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return { ...emptyFile(), ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return parseEmailUpdatesDocument(text, size)
}

export function parseEmailUpdatesDocument(text: string, byteLength = Buffer.byteLength(text)): FileResult {
  if (byteLength > MAX_EMAIL_BYTES) {
    return {
      ...emptyFile(),
      ok: false,
      error: `email-updates.json is ${byteLength} bytes (limit ${MAX_EMAIL_BYTES}); left the tracker untouched`
    }
  }
  const body = text.replace(/^\uFEFF/, '')
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return {
      ...emptyFile(),
      ok: false,
      error: `email-updates.json is not valid JSON (${err instanceof Error ? err.message : String(err)}); left the tracker untouched`
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...emptyFile(), ok: false, error: 'email-updates.json must be a JSON object; left the tracker untouched' }
  }
  const doc = raw as Record<string, unknown>
  if (doc.version !== EMAIL_UPDATES_VERSION) {
    return {
      ...emptyFile(),
      ok: false,
      error: `email-updates.json version ${String(doc.version)} is not supported (expected ${EMAIL_UPDATES_VERSION}); left the tracker untouched`
    }
  }
  if (!Array.isArray(doc.entries)) {
    return { ...emptyFile(), ok: false, error: 'email-updates.json is missing an entries array; left the tracker untouched' }
  }
  if (doc.entries.length > MAX_EMAIL_ENTRIES) {
    return {
      ...emptyFile(),
      ok: false,
      error: `email-updates.json has ${doc.entries.length} entries (limit ${MAX_EMAIL_ENTRIES}); left the tracker untouched`
    }
  }
  const warnings: string[] = []
  if (doc.generatedAt !== undefined && (typeof doc.generatedAt !== 'string' || Number.isNaN(Date.parse(doc.generatedAt)))) {
    warnings.push('ignored generatedAt; it is not a timestamp')
  }
  const skipped: Skip[] = []
  const parsed: { entry: EmailEntry; index: number }[] = []
  doc.entries.forEach((value, index) => {
    const result = parseEntry(value, index)
    if ('skip' in result) skipped.push(result.skip)
    else {
      parsed.push({ entry: result.entry, index })
      warnings.push(...result.warnings.map((w) => `${result.entry.id}: ${w}`))
    }
  })
  parsed.sort((a, b) => eventMillis(a.entry.eventAt) - eventMillis(b.entry.eventAt) || a.index - b.index)
  const byId = new Map<string, EmailEntry>()
  let duplicates = 0
  for (const { entry } of parsed) {
    if (byId.has(entry.id)) duplicates++
    byId.set(entry.id, entry)
  }
  if (duplicates) warnings.push(`collapsed ${duplicates} duplicate id${duplicates === 1 ? '' : 's'}; kept the newest event`)
  const entries = [...byId.values()].sort((a, b) => eventMillis(a.eventAt) - eventMillis(b.eventAt) || a.id.localeCompare(b.id))
  return { ok: true, missing: false, error: null, entries, skipped, warnings, duplicates }
}

function parseEntry(value: unknown, index: number): { entry: EmailEntry; warnings: string[] } | { skip: Skip } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { skip: { index, id: null, reason: 'entry is not an object' } }
  }
  const o = value as Record<string, unknown>
  const id = typeof o.id === 'string' ? clean(o.id, MAX_ID) : ''
  if (!id) return { skip: { index, id: null, reason: 'missing id' } }
  const company = typeof o.company === 'string' ? clean(o.company, MAX_TEXT) : ''
  if (!company) return { skip: { index, id, reason: 'missing company' } }
  const status = typeof o.status === 'string' ? STATUS_WORDS[o.status.trim().toLowerCase()] : undefined
  if (!status) return { skip: { index, id, reason: 'status must be applied, oa, interview, offer, or rejected' } }
  const eventAt = typeof o.eventAt === 'string' ? o.eventAt.trim() : ''
  if (!validWhen(eventAt)) return { skip: { index, id, reason: 'eventAt must be YYYY-MM-DD or an ISO-8601 time with a timezone' } }
  const warnings: string[] = []
  const role = typeof o.role === 'string' ? clean(o.role, MAX_TEXT) : ''
  const entry: EmailEntry = { id, company, role, status, eventAt }
  const applied = optionalWhen(o.appliedAt)
  if (applied === 'bad') warnings.push('ignored appliedAt')
  else if (applied) entry.appliedAt = applied
  const emailAt = optionalWhen(o.emailAt)
  if (emailAt === 'bad') warnings.push('ignored emailAt')
  else if (emailAt) entry.emailAt = emailAt
  if (typeof o.subject === 'string' && o.subject.trim()) entry.subject = clean(o.subject, MAX_TEXT)
  if (typeof o.note === 'string' && o.note.trim()) entry.note = clean(o.note, MAX_NOTE)
  if (o.deadline !== undefined && o.deadline !== null) {
    const deadline = parseDeadline(o.deadline)
    if ('error' in deadline) warnings.push(deadline.error)
    else entry.deadline = deadline.deadline
  }
  return { entry, warnings }
}

function optionalWhen(value: unknown): string | null | 'bad' {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !validWhen(value.trim())) return 'bad'
  return value.trim()
}

function validWhen(value: string): boolean {
  if (DATE_ONLY.test(value)) return true
  return INSTANT.test(value) && !Number.isNaN(Date.parse(value))
}

function parseDeadline(value: unknown): { deadline: EmailDeadline } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'ignored deadline; expected an object' }
  const o = value as Record<string, unknown>
  const at = typeof o.at === 'string' ? o.at.trim() : ''
  if (!at) return { error: 'ignored deadline; missing at' }
  let deadline: EmailDeadline
  if (DATE_ONLY.test(at)) {
    deadline = { at, day: at, dueAt: null, dateOnly: true }
  } else if (INSTANT.test(at) && !Number.isNaN(Date.parse(at))) {
    const ms = Date.parse(at)
    deadline = { at, day: localDayFromInstant(ms), dueAt: new Date(ms).toISOString(), dateOnly: false }
  } else {
    return { error: 'ignored deadline; at must be YYYY-MM-DD or an ISO-8601 time with a timezone' }
  }
  if (typeof o.kind === 'string' && o.kind.trim()) deadline.kind = clean(o.kind, 40)
  if (typeof o.platform === 'string' && o.platform.trim()) deadline.platform = clean(o.platform, 80)
  if (typeof o.display === 'string' && o.display.trim()) deadline.display = clean(o.display, 80)
  return { deadline }
}

export function localDayFromInstant(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function clean(s: string, max: number): string {
  return s.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Start of the local calendar day for a date, or the real instant. Invalid input → NaN. */
export function eventMillis(eventAt: string): number {
  if (DATE_ONLY.test(eventAt)) {
    const [y, m, d] = eventAt.split('-').map(Number)
    return new Date(y, m - 1, d).getTime()
  }
  return Date.parse(eventAt)
}

function eventIso(eventAt: string): string {
  if (DATE_ONLY.test(eventAt)) return `${eventAt}T12:00:00`
  return new Date(eventAt).toISOString()
}

export function companyKey(input: string): string {
  let t = input.toLowerCase().replace(/&/g, '')
  t = t.replace(/\./g, '')
  t = t.replace(/[^a-z0-9]+/g, ' ')
  t = t.replace(
    /\b(incorporated|corporation|company|companies|labs|lab|inc|llc|corp|ltd|limited|plc|gmbh|holdings|group|co)\b/g,
    ' '
  )
  return t.replace(/[^a-z0-9]+/g, '')
}

export function companiesMatch(a: string, b: string): boolean {
  const ka = companyKey(a)
  const kb = companyKey(b)
  if (!ka || !kb) return false
  if (ka === kb) return true
  if (ka.length >= 8 && kb.length >= 8 && levenshtein(ka, kb) <= 1) return true
  const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka]
  if (shorter.length < 5 || !longer.startsWith(shorter)) return false
  return COMPANY_REST.test(longer.slice(shorter.length))
}

export function roleKey(input: string): string {
  let t = input.toLowerCase()
  t = t.replace(/\([^)]*\)/g, ' ')
  t = t.replace(/\[[^\]]*\]/g, ' ')
  t = t.replace(/\b(id|req|requisition|job)\s*[:#]?\s*\d+\b/g, ' ')
  t = t.replace(/\br\d{4,}\b/g, ' ')
  t = t.replace(/\b\d{4,}\b/g, ' ')
  t = t.replace(/\b(summer|winter|spring|fall|autumn)\b/g, ' ')
  t = t.replace(/\bsoftware engineering\b/g, 'software engineer')
  t = t.replace(/\b(swe|sde|se)\b/g, 'software engineer')
  t = t.replace(/\bmle\b/g, 'machine learning engineer')
  t = t.replace(/\bml\b/g, 'machine learning')
  t = t.replace(/\beng\b/g, 'engineer')
  t = t.replace(/\bdevs?\b/g, 'developer')
  t = t.replace(/\bintern(?:ship)?s?\b/g, 'intern')
  t = t.replace(/[^a-z0-9]+/g, ' ')
  return t
    .split(/\s+/)
    .filter((w) => w && !ROLE_NOISE.has(w))
    .join(' ')
}

export function rolesMatch(a: string, b: string): boolean {
  const ka = roleKey(a)
  const kb = roleKey(b)
  if (!ka || !kb) return false
  if (ka === kb) return true
  const sa = new Set(ka.split(' '))
  const sb = new Set(kb.split(' '))
  const onlyA = [...sa].filter((w) => !sb.has(w))
  const onlyB = [...sb].filter((w) => !sa.has(w))
  if (onlyA.length === 0 && onlyB.length === 0) return true
  if (onlyA.length === 0 && onlyB.every((w) => ROLE_EXTRA.has(w))) return true
  if (onlyB.length === 0 && onlyA.every((w) => ROLE_EXTRA.has(w))) return true
  return false
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = next
  }
  return prev[b.length]
}

export function emailTrackerId(entryId: string): string {
  return createHash('sha1').update(`email:${entryId}`).digest('hex').slice(0, 16)
}

export function fingerprint(entry: EmailEntry): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        company: entry.company,
        role: entry.role,
        status: entry.status,
        eventAt: entry.eventAt,
        appliedAt: entry.appliedAt ?? null,
        subject: entry.subject ?? null,
        emailAt: entry.emailAt ?? null,
        note: entry.note ?? null,
        deadline: entry.deadline ?? null
      })
    )
    .digest('hex')
    .slice(0, 20)
}

export function matchRowsFrom(store: {
  items: {
    id: string
    company: string
    title: string
    url?: string
    term?: JobTerm
    source?: JobSource
    location?: string | null
    seenAt?: string
  }[]
  state: Record<
    string,
    {
      status: JobStatus
      note?: string
      appliedAt?: string | null
      inherited?: boolean
      updatedAt: string
      snapshot?: {
        company: string
        title: string
        url?: string
        term?: JobTerm
        source?: JobSource
        location?: string | null
      }
    }
  >
}): MatchRow[] {
  const rows: MatchRow[] = []
  const seen = new Set<string>()
  for (const item of store.items) {
    const st = store.state[item.id]
    const snap = st?.snapshot
    rows.push({
      id: item.id,
      company: snap?.company || item.company,
      title: snap?.title || item.title,
      status: st?.status ?? 'new',
      updatedAt: st?.updatedAt ?? item.seenAt ?? '',
      manual: st?.inherited === false,
      note: st?.note ?? '',
      appliedAt: st?.appliedAt ?? null,
      url: snap?.url || item.url || '',
      term: snap?.term || item.term || 'unknown',
      source: snap?.source || item.source || 'manual',
      location: snap?.location ?? item.location ?? null,
      hasState: Boolean(st)
    })
    seen.add(item.id)
  }
  for (const [id, st] of Object.entries(store.state)) {
    if (seen.has(id) || !st.snapshot) continue
    rows.push({
      id,
      company: st.snapshot.company,
      title: st.snapshot.title,
      status: st.status,
      updatedAt: st.updatedAt,
      manual: st.inherited === false,
      note: st.note ?? '',
      appliedAt: st.appliedAt ?? null,
      url: st.snapshot.url || '',
      term: st.snapshot.term || 'unknown',
      source: st.snapshot.source || 'manual',
      location: st.snapshot.location ?? null,
      hasState: true
    })
  }
  return rows
}

type StatusDecision = 'update' | 'same' | 'keep' | 'manual'

function decideStatus(row: MatchRow, next: JobStatus, eventAt: string, stale: boolean): StatusDecision {
  if (row.hasState && row.status === next) return 'same'
  const updatedMs = Date.parse(row.updatedAt)
  // A person edited the row after this email. Their status stands, including against Offer/Rejected.
  if (row.manual && !Number.isNaN(updatedMs) && updatedMs > eventMillis(eventAt)) return 'manual'
  // An older email must not overwrite a status we already took from a newer one, even for Offer/Rejected.
  if (stale) return 'keep'
  // Offer and Rejected are terminal: only the other one of those two may replace them.
  if (row.hasState && (row.status === 'rejected' || row.status === 'offer') && next !== 'rejected' && next !== 'offer') {
    return 'keep'
  }
  if (next === 'rejected' || next === 'offer') return 'update'
  if (row.status === 'skipped') return 'keep'
  const current = RANK[row.status] ?? 0
  const incoming = RANK[next] ?? 0
  return incoming > current ? 'update' : 'keep'
}

function latestStatusEvent(ledger: Record<string, EmailLedgerEntry>, trackerId: string, ignoreEntryId: string): number {
  let max = -Infinity
  for (const [id, entry] of Object.entries(ledger)) {
    if (id === ignoreEntryId || entry.trackerId !== trackerId || !entry.statusEventAt) continue
    const ms = eventMillis(entry.statusEventAt)
    if (ms > max) max = ms
  }
  return max
}

function noteFragment(entry: EmailEntry): string {
  const bits: string[] = []
  if (entry.deadline) {
    const kind = entry.deadline.kind || defaultKind(entry.status)
    const when = entry.deadline.display || (entry.deadline.dateOnly ? formatDay(entry.deadline.day) : formatInstant(entry.deadline.at))
    bits.push([kind, entry.deadline.platform, when].filter(Boolean).join(' '))
  }
  if (entry.note) bits.push(entry.note)
  return bits.join(' · ').slice(0, 500)
}

function mergeNote(existing: string, fragment: string): string | null {
  const extra = fragment.trim()
  if (!extra || existing.includes(extra)) return null
  return (existing ? `${existing} · ${extra}` : extra).slice(0, MAX_NOTE)
}

function defaultKind(status: JobStatus): string {
  if (status === 'oa') return 'OA'
  if (status === 'interview') return 'Interview'
  if (status === 'offer') return 'Offer'
  return 'Deadline'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatDay(day: string): string {
  const [, m, d] = day.split('-').map(Number)
  return `${MONTHS[(m ?? 1) - 1] ?? day} ${d}`
}

function formatInstant(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}).*(Z|[+-]\d{2}:\d{2})$/.exec(iso)
  if (!m) return iso
  let hour = Number(m[4])
  const ampm = hour >= 12 ? 'PM' : 'AM'
  hour = hour % 12 || 12
  const zone = m[6] === 'Z' ? 'UTC' : `UTC${m[6]}`
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${hour}:${m[5]} ${ampm} ${zone}`
}

export function taskTextFor(entry: EmailEntry): string {
  const kind = entry.deadline?.kind || defaultKind(entry.status)
  const role = entry.role ? ` — ${entry.role}` : ''
  const when = entry.deadline
    ? entry.deadline.display || (entry.deadline.dateOnly ? formatDay(entry.deadline.day) : formatInstant(entry.deadline.at))
    : ''
  const extra = [entry.deadline?.platform, when].filter(Boolean).join(', ')
  return `${kind}: ${entry.company}${role}${extra ? ` (${extra})` : ''}`.slice(0, 500)
}

function dueKeyOf(entry: EmailEntry): string | null {
  if (!entry.deadline) return null
  return `${entry.deadline.day}|${entry.deadline.dueAt ?? ''}`
}

function taskDueKey(task: TaskSnap): string {
  return `${task.deadline ?? ''}|${task.dueAt ?? ''}`
}

function actionable(entry: EmailEntry, today: string, nowMs: number): boolean {
  const d = entry.deadline
  if (!d) return false
  if (d.dueAt) return Date.parse(d.dueAt) >= nowMs - 15 * 60_000
  return d.day >= today
}

function findTask(tasks: TaskSnap[], entryId: string, prev: EmailLedgerEntry | undefined): TaskSnap | null {
  return (
    tasks.find((t) => t.externalId === entryId) ??
    (prev?.taskId ? tasks.find((t) => t.id === prev.taskId) ?? null : null)
  )
}

/**
 * Same expansions as roleKey, but season, year, and parenthetical words stay.
 * roleKey deletes those, which is why a generic title and a "Summer 2027"
 * title both match; this form is only for choosing between those hits.
 */
function titleRankKey(input: string): string {
  let t = input.toLowerCase()
  t = t.replace(/\b(id|req|requisition|job)\s*[:#]?\s*\d+\b/g, ' ')
  t = t.replace(/\br\d{4,}\b/g, ' ')
  t = t.replace(/\b\d{5,}\b/g, ' ')
  t = t.replace(/\bsoftware engineering\b/g, 'software engineer')
  t = t.replace(/\b(swe|sde|se)\b/g, 'software engineer')
  t = t.replace(/\bmle\b/g, 'machine learning engineer')
  t = t.replace(/\bml\b/g, 'machine learning')
  t = t.replace(/\beng\b/g, 'engineer')
  t = t.replace(/\bdevs?\b/g, 'developer')
  t = t.replace(/\bintern(?:ship)?s?\b/g, 'intern')
  t = t.replace(/[^a-z0-9]+/g, ' ')
  return t
    .split(/\s+/)
    .filter((w) => w && !ROLE_NOISE.has(w))
    .join(' ')
}

function looseTitle(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

type TitleScore = readonly [number, number, number, number]

/** Fewer missing email words, then fewer extras, then an exact expansion, then an exact raw title. */
function titleRankScore(role: string, title: string): TitleScore {
  const wantKey = titleRankKey(role)
  const gotKey = titleRankKey(title)
  const want = new Set(wantKey.split(' ').filter(Boolean))
  const got = new Set(gotKey.split(' ').filter(Boolean))
  let missing = 0
  for (const w of want) if (!got.has(w)) missing++
  let extra = 0
  for (const w of got) if (!want.has(w)) extra++
  return [missing, extra, wantKey === gotKey ? 0 : 1, looseTitle(role) === looseTitle(title) ? 0 : 1]
}

function cmpScore(a: TitleScore, b: TitleScore): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/**
 * roleKey already decided these rows are the same company and role. Prefer the
 * closest title: fewest missing words, then fewest extras, then an exact
 * expansion, then an exact raw title. "… Summer 2027" beats a shorter generic
 * title when the email names that season. Ambiguous only when two or more hits
 * share that best score — a tie is not a guess.
 */
function closestTitle(role: string, hits: MatchRow[]): MatchRow | 'ambiguous' {
  let best: MatchRow | null = null
  let bestScore: TitleScore | null = null
  let tied = false
  for (const hit of hits) {
    const score = titleRankScore(role, hit.title)
    const cmp = bestScore ? cmpScore(score, bestScore) : -1
    if (cmp < 0) {
      best = hit
      bestScore = score
      tied = false
    } else if (cmp === 0) {
      tied = true
    }
  }
  if (!best || tied) return 'ambiguous'
  return best
}

function fuzzyFind(entry: EmailEntry, rows: MatchRow[], emptyRoleCount: Map<string, number>): MatchRow | 'ambiguous' | null {
  if (!entry.role.trim()) {
    // No role words to rank. Several rows at this company stay ambiguous.
    if ((emptyRoleCount.get(companyKey(entry.company)) ?? 0) > 1) return null
    const hits = rows.filter((r) => companiesMatch(r.company, entry.company))
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return 'ambiguous'
    return null
  }
  const hits = rows.filter((r) => companiesMatch(r.company, entry.company) && rolesMatch(r.title, entry.role))
  if (hits.length <= 1) return hits[0] ?? null
  return closestTitle(entry.role, hits)
}

function appliedIso(entry: EmailEntry): string | null {
  const raw = entry.appliedAt || (entry.status === 'applied' ? entry.eventAt : '')
  if (!raw) return null
  if (DATE_ONLY.test(raw)) return `${raw}T12:00:00`
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/**
 * Pure apply. Copies the ledger and row list; does not touch the caller's objects.
 * `dirty` is false when every entry was already processed and no task link changed.
 */
export function applyEmailImport(
  inputRows: MatchRow[],
  ledgerIn: Record<string, EmailLedgerEntry>,
  tasks: TaskSnap[],
  entries: EmailEntry[],
  now: Date
): ApplyOutcome {
  const working = inputRows.map((r) => ({ ...r }))
  const byId = new Map(working.map((r) => [r.id, r]))
  const ledger: Record<string, EmailLedgerEntry> = { ...ledgerIn }
  const patches: StatusPatch[] = []
  const taskWrites: TaskWrite[] = []
  const warnings: string[] = []
  let matched = 0
  let created = 0
  let statusUpdated = 0
  let ambiguous = 0
  let manualKept = 0
  let unchanged = 0
  let tasksClosed = 0
  const today = localDayFromInstant(now.getTime())
  const nowMs = now.getTime()
  const emptyRoleCount = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.role.trim()) emptyRoleCount.set(companyKey(entry.company), (emptyRoleCount.get(companyKey(entry.company)) ?? 0) + 1)
  }

  for (const entry of entries) {
    const fp = fingerprint(entry)
    const prev = ledger[entry.id]
    let row = (prev && byId.get(prev.trackerId)) || byId.get(emailTrackerId(entry.id)) || null
    if (!row) {
      const found = fuzzyFind(entry, working, emptyRoleCount)
      if (found === 'ambiguous') {
        ambiguous++
        warnings.push(`${entry.id}: ${entry.company} matches more than one row; left them all alone`)
        continue
      }
      row = found
    }
    const isNew = !row
    if (!row) {
      const title = entry.role.trim() || 'Role not in email'
      row = {
        id: emailTrackerId(entry.id),
        company: entry.company,
        title,
        status: 'new',
        updatedAt: '',
        manual: false,
        note: '',
        appliedAt: null,
        url: '',
        term: detectTerm(title),
        source: 'manual',
        location: null,
        hasState: false
      }
      working.push(row)
      byId.set(row.id, row)
    }

    const same = prev?.fingerprint === fp && row.hasState
    const patch: StatusPatch = { id: row.id }
    let patchUsed = false
    let statusEventAt = prev?.statusEventAt ?? null
    if (!same) {
      const ownEvent = prev?.statusEventAt ? eventMillis(prev.statusEventAt) : -Infinity
      const stale = eventMillis(entry.eventAt) < Math.max(ownEvent, latestStatusEvent(ledger, row.id, entry.id))
      const decision = decideStatus(row, entry.status, entry.eventAt, stale)
      if (decision === 'manual') {
        manualKept++
        warnings.push(`${entry.id}: kept ${row.status}; a manual edit is newer than ${entry.eventAt}`)
      } else if (decision === 'keep') {
        unchanged++
      } else if (decision === 'update') {
        patch.status = entry.status
        patch.updatedAt = eventIso(entry.eventAt)
        patch.clearManual = row.manual
        row.status = entry.status
        row.updatedAt = patch.updatedAt
        row.manual = false
        statusEventAt = entry.eventAt
        if (!isNew) statusUpdated++
        patchUsed = true
      } else {
        unchanged++
      }
      const fragment = noteFragment(entry)
      const note = mergeNote(row.note, fragment)
      if (note && note !== row.note) {
        patch.note = note
        row.note = note
        patchUsed = true
      }
      const applied = appliedIso(entry)
      if (applied && !row.appliedAt && (entry.appliedAt || entry.status === 'applied' || decision === 'update')) {
        patch.appliedAt = applied
        row.appliedAt = applied
        patchUsed = true
      }
      if (!row.hasState) {
        patch.create = {
          company: row.company,
          title: row.title,
          url: row.url,
          term: row.term,
          source: row.source,
          location: row.location,
          note: row.note,
          status: row.status === 'new' ? entry.status : row.status,
          appliedAt: row.appliedAt,
          updatedAt: patch.updatedAt ?? eventIso(entry.eventAt)
        }
        if (!patch.status) patch.status = patch.create.status
        row.hasState = true
        row.status = patch.create.status
        patchUsed = true
      }
      if (isNew) created++
      else matched++
      if (patchUsed) patches.push(patch)
    } else {
      matched++
      unchanged++
    }

    const task = findTask(tasks, entry.id, prev)
    const closedState = task && task.state !== 'open' && task.state !== 'snoozed'
    let taskClosed = prev?.taskClosed ?? false
    let taskId = task?.id ?? prev?.taskId ?? null
    if (closedState) {
      if (!taskClosed) tasksClosed++
      taskClosed = true
    } else if (prev?.taskId && !task) {
      if (!taskClosed) tasksClosed++
      taskClosed = true
      taskId = prev.taskId
    } else if (task && entry.deadline) {
      const nextKey = dueKeyOf(entry)
      const prevEvent = prev ? eventMillis(prev.eventAt) : -Infinity
      const newer = eventMillis(entry.eventAt) >= prevEvent
      // Compare to the ledger, not the task: a due time Owen edited by hand stays until the file changes.
      const emailChanged = !prev || nextKey !== prev.dueKey
      if (nextKey && emailChanged && newer && nextKey !== taskDueKey(task)) {
        taskWrites.push({
          externalId: entry.id,
          action: 'update',
          text: taskTextFor(entry),
          deadline: entry.deadline.day,
          dueAt: entry.deadline.dueAt,
          priority: entry.status === 'interview' || entry.status === 'offer' ? 'high' : 'medium',
          horizon: entry.deadline.day <= addDays(today, 1) ? 'now' : 'soon',
          updateText: !task.touched
        })
      }
    } else if (!task && !taskClosed && entry.status !== 'rejected' && entry.deadline && actionable(entry, today, nowMs)) {
      const deadline = entry.deadline
      taskWrites.push({
        externalId: entry.id,
        action: 'create',
        text: taskTextFor(entry),
        deadline: deadline.day,
        dueAt: deadline.dueAt,
        priority: entry.status === 'interview' || entry.status === 'offer' ? 'high' : 'medium',
        horizon: deadline.day <= addDays(today, 1) ? 'now' : 'soon',
        updateText: true
      })
      taskId = null
    }

    ledger[entry.id] = {
      fingerprint: fp,
      trackerId: row.id,
      status: row.status,
      eventAt: entry.eventAt,
      statusEventAt,
      taskId,
      taskClosed,
      dueKey: dueKeyOf(entry)
    }
  }

  const dirty =
    patches.length > 0 || taskWrites.length > 0 || JSON.stringify(ledger) !== JSON.stringify(ledgerIn)
  return {
    dirty,
    patches,
    ledger,
    taskWrites,
    matched,
    created,
    statusUpdated,
    ambiguous,
    manualKept,
    unchanged,
    tasksClosed,
    warnings
  }
}

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1)
  dt.setDate(dt.getDate() + days)
  return localDayFromInstant(dt.getTime())
}

/**
 * Apply patches onto a store slice. Never replaces `items`, never removes a state row,
 * and never replaces an existing state object (prepared, promoted tasks, and anything
 * else on it stay). New rows are inserted only for ids that have no state yet.
 */
export function commitEmailResult<S extends EmailCommitStore>(store: S, result: ApplyOutcome): void {
  for (const patch of result.patches) {
    const existing = store.state[patch.id]
    if (!existing) {
      const created = patch.create
      if (!created) continue
      store.state[patch.id] = {
        status: patch.status ?? created.status,
        note: patch.note ?? created.note,
        appliedAt: patch.appliedAt ?? created.appliedAt,
        promotedTaskId: null,
        openedInAsideAt: null,
        snapshot: {
          company: created.company,
          title: created.title,
          url: created.url,
          term: created.term,
          source: created.source,
          location: created.location
        },
        updatedAt: patch.updatedAt ?? created.updatedAt
      }
      continue
    }
    if (patch.status) existing.status = patch.status
    if (patch.note !== undefined) existing.note = patch.note
    if (patch.appliedAt && !existing.appliedAt) existing.appliedAt = patch.appliedAt
    if (patch.updatedAt) existing.updatedAt = patch.updatedAt
    if (patch.clearManual) delete existing.inherited
  }
  store.emailImports = result.ledger
}

/** Fill in task ids after the task store write. Returns true when the ledger changed. */
export function recordTaskResults(
  ledger: Record<string, EmailLedgerEntry>,
  results: { externalId: string; action: string; taskId: string | null }[]
): boolean {
  let changed = false
  for (const r of results) {
    const cur = ledger[r.externalId]
    if (!cur) continue
    if ((r.action === 'created' || r.action === 'updated' || r.action === 'unchanged') && cur.taskId !== r.taskId) {
      cur.taskId = r.taskId
      changed = true
    }
    if ((r.action === 'closed' || r.action === 'missing') && !cur.taskClosed) {
      cur.taskClosed = true
      changed = true
    }
  }
  return changed
}

/**
 * Parse and plan. A document that fails validation returns `applied: false` and no plan,
 * which is the signal to not open jobs.json at all.
 */
export function planEmailDocument(
  text: string,
  rows: MatchRow[],
  ledger: Record<string, EmailLedgerEntry>,
  tasks: TaskSnap[],
  now: Date
): { applied: false; error: string } | { applied: true; file: FileResult; outcome: ApplyOutcome } {
  const file = parseEmailUpdatesDocument(text)
  if (!file.ok) return { applied: false, error: file.error ?? 'unreadable' }
  if (file.entries.length === 0) return { applied: false, error: file.skipped.length ? 'no valid entries' : 'empty' }
  const outcome = applyEmailImport(rows, ledger, tasks, file.entries, now)
  outcome.warnings = [...file.warnings, ...outcome.warnings]
  return { applied: true, file, outcome }
}
