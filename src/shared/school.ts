/**
 * School: every deadline across courses, from the Canvas calendar feed, your own recurring
 * rules, syllabus extraction, and quick-add — merged into one ledger and mirrored into Tasks.
 */
import { addDays } from './dates'

export type SchoolSource = 'canvas' | 'rule' | 'syllabus' | 'manual' | 'gradescope'

/**
 * `study` is for work no feed can see — rewatch a lecture, redo a problem set, read ahead. Only you
 * add those; the model and the feeds never produce them, so they are never merged with graded work.
 */
export type SchoolKind = 'assignment' | 'quiz' | 'exam' | 'project' | 'event' | 'study' | 'other'

export const SCHOOL_KINDS: SchoolKind[] = ['assignment', 'quiz', 'exam', 'project', 'event', 'study', 'other']

/** Kinds the feeds and the syllabus reader may emit; `study` is yours alone. */
export const FEED_KINDS: SchoolKind[] = SCHOOL_KINDS.filter((k) => k !== 'study')

export interface SchoolItem {
  /** Stable id: `canvas:<uid>`, `rule:<ruleId>:<YYYY-MM-DD>`, `manual:<nanoid>`, … */
  id: string
  source: SchoolSource
  /** Canonical course key (`E E 241`, `STAT 390`, `AMATH 301`). Section letters are dropped. */
  course: string
  title: string
  kind: SchoolKind
  /** Local day, YYYY-MM-DD. */
  due: string
  /** Local wall-clock HH:MM when known (rules and timed events); null for all-day Canvas assignments. */
  dueTime: string | null
  url: string | null
  /** When the source first/last reported this item. Feed items that vanish keep their lastSeenAt. */
  seenAt: string
  lastSeenAt: string
  done: boolean
  doneAt: string | null
  /** Hidden by the user (e.g. an office-hours series). Still stored so it doesn't come back. */
  hidden: boolean
  /** Linked Task id once mirrored into the Tasks tab. */
  taskId: string | null
  /** For rule instances: the id of a real (canvas/gradescope) item that satisfied this slot. */
  satisfiedBy: string | null
  /**
   * Born in Tasks (a task you put on the School track) rather than here. The task owns its text and
   * deadline; this row follows it, and is never taken off the board by the mirror window.
   */
  fromTask?: boolean
}

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface SchoolRule {
  id: string
  course: string
  /** Title template; `{n}` is replaced by the instance number within the term. */
  title: string
  kind: SchoolKind
  weekday: Weekday
  /** HH:MM local, e.g. 21:10. */
  time: string
  /** Inclusive local-day bounds; the term, typically. */
  startDate: string
  endDate: string
  enabled: boolean
  createdAt: string
}

export interface SchoolCourse {
  course: string
  /** Display name, from the syllabus or you. Falls back to the course key. */
  name: string
  /** Canvas numeric id, if the feed has shown it. */
  canvasId: string | null
  hidden: boolean
  /** Last time any non-rule source reported a new item for this course. */
  lastNewItemAt: string | null
  /** Hide recurring calendar events (office hours, sections) for this course. Default true. */
  hideEvents: boolean
}

export type SchoolFlagKind = 'expected-not-seen' | 'quiet' | 'feed-error' | 'feed-missing' | 'lms-login' | 'lms-error'

export interface SchoolFlag {
  kind: SchoolFlagKind
  course: string | null
  message: string
  /** Week (Monday, YYYY-MM-DD) the flag belongs to, so it renders inline in that group. */
  week: string | null
}

export interface SchoolStatus {
  feedConfigured: boolean
  lastPollAt: string | null
  lastPollError: string | null
  /** Items the last poll added (for the "n new" line). */
  lastPollNew: number
  lastDigestAt: string | null
}

export type LmsKind = 'gradescope' | 'canvas'

/** A logged-in LMS session briefly holds (cookies, encrypted) and reads your own pages with. */
export interface LmsStatus {
  kind: LmsKind
  connected: boolean
  connectedAt: string | null
  lastSyncAt: string | null
  lastError: string | null
  /** The session stopped working (expired or signed out); reconnect to resume. */
  needsLogin: boolean
  /** Which Canvas host this is for; empty for Gradescope. */
  host: string
}

/** A deadline the model read out of a Canvas announcement; you confirm or drop it. */
export interface AnnouncementSuggestion extends SyllabusSuggestion {
  /** Announcement title, for context. */
  from: string
  url: string | null
  postedAt: string
}

export interface SchoolView {
  items: SchoolItem[]
  rules: SchoolRule[]
  courses: SchoolCourse[]
  flags: SchoolFlag[]
  status: SchoolStatus
  lms: LmsStatus[]
  /** Deadlines found in recent announcements, waiting for a yes/no. */
  announcementSuggestions: AnnouncementSuggestion[]
  llmConfigured: boolean
  /** Playwright found a browser to drive; LMS connect needs one. */
  browserAvailable: boolean
}

/** A single deadline or rule the syllabus parser proposes; you confirm or drop each one. */
export interface SyllabusSuggestion {
  id: string
  type: 'item' | 'rule'
  course: string
  title: string
  kind: SchoolKind
  /** Items: YYYY-MM-DD. */
  due?: string
  /** Rules: weekday + time; items: optional time. */
  weekday?: Weekday
  time?: string | null
  /** Short quote from the syllabus the parser based this on. */
  evidence: string
  /** The parser's own confidence, for ordering only. */
  confidence: 'high' | 'medium' | 'low'
}

export interface SyllabusParseResult {
  ok: boolean
  error?: string
  course?: string
  courseName?: string
  termStart?: string
  termEnd?: string
  suggestions?: SyllabusSuggestion[]
  /** Dates the parser saw but couldn't pin to a day ("week 7", "TBD"), surfaced so you can add them by hand. */
  unresolved?: string[]
}

export interface QuickAddInput {
  course: string
  title: string
  due: string
  time?: string | null
  kind?: SchoolKind
  url?: string | null
}

export interface RuleInput {
  id?: string
  course: string
  title: string
  kind: SchoolKind
  weekday: Weekday
  time: string
  startDate: string
  endDate: string
  enabled?: boolean
}

export const SCHOOL_POLL_CHOICES = [0, 60, 180, 360]

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/**
 * `E E 241 A` → `E E 241`; `STAT 390 A` → `STAT 390`; `AMATH 351 B - AU26` → `AMATH 351`. Canvas
 * appends the section letter and sometimes the term; the course key should depend on neither.
 */
export function courseKey(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim().toUpperCase()
  const m = s.match(/^([A-Z][A-Z &/]*?\s?\d{3}[A-Z]?)(?=\s|$|[^A-Z0-9])/)
  if (m) return m[1].trim()
  return s.split(/\s[-–—:]\s/)[0].trim()
}

/** "HH:MM" (how times are stored) → "9:00 PM". Anything unparsable is returned as-is. */
export function clock12(hhmm: string | null | undefined): string {
  if (!hhmm) return ''
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return hhmm
  const h = Number(m[1])
  if (h > 23) return hhmm
  const suffix = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${m[2]} ${suffix}`
}

/** Monday (local) of the week containing a YYYY-MM-DD day. */
export function weekOf(day: string): string {
  const d = new Date(day + 'T12:00:00')
  const dow = (d.getDay() + 6) % 7
  return addDays(day, -dow)
}
