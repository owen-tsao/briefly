import { Notification, powerMonitor, type BrowserWindow } from 'electron'
import { addDays, localDay } from '../../shared/dates'
import {
  courseKey,
  weekOf,
  type QuickAddInput,
  type RuleInput,
  type SchoolFlag,
  type SchoolItem,
  type SchoolKind,
  type SchoolRule,
  type SchoolView,
  SCHOOL_KINDS,
  WEEKDAY_LABELS
} from '../../shared/school'
import { getNotificationsEnabled, getSchoolConfig, getSchoolFeedUrl, llmConfigured } from '../settings'
import { addTask, listTasks, removeTask, setTaskState, setTaskTrack, syncTaskFromSource } from '../taskStore'
import { updateTrayCount } from '../tray'
import { fetchText } from '../jobs/extract'
import { classifyTitle, looksLikeRecurringEvent, MAX_ICS_BYTES, parseIcs } from './ics'
import { ensureCourse, load, newId, save, type SchoolStore } from './store'
import { browserAvailable, getAnnouncementSuggestions, getLmsStatus, syncLmsIfDue } from './lms'

/**
 * The School engine. One store, four writers (feed poll, rule expansion, syllabus/quick-add,
 * the user), one reader (the view). Every deadline within the task horizon is mirrored into
 * Tasks; done-state flows both ways.
 */

let getWindow: () => BrowserWindow | null = () => null
let openPopover: (() => void) | null = null
let timer: ReturnType<typeof setInterval> | null = null
let running = false

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const RULE_LOOKBACK_DAYS = 7
const RULE_LOOKAHEAD_DAYS = 28
/** A rule slot counts as satisfied by a real item due within this many days of it. */
const RULE_MATCH_WINDOW_DAYS = 3
const QUIET_DAYS = 14
const VIEW_PAST_DAYS = 60
/** Deadlines older than this never become Tasks (first sync of a half-finished term). */
const TASK_LOOKBACK_DAYS = 1
const DIGEST_HOUR = 17

function validDay(d: unknown): d is string {
  return typeof d === 'string' && DAY_RE.test(d) && !Number.isNaN(Date.parse(d + 'T12:00:00'))
}

function pushView(): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('school:changed', getView())
}

/** Another writer (LMS sync) changed the store; refresh the tab. */
export function afterExternalChange(): void {
  pushView()
}

function notify(title: string, body: string): void {
  if (!getNotificationsEnabled() || !Notification.isSupported()) return
  const n = new Notification({ title, body, silent: true })
  n.on('click', () => openPopover?.())
  n.show()
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

export async function pollFeed(force = false): Promise<{ ok: boolean; error?: string; added: number }> {
  const url = getSchoolFeedUrl()
  if (!url) {
    const store = load()
    store.lastPollError = null
    save(store)
    return { ok: false, error: 'No Canvas feed set.', added: 0 }
  }
  const etag = load().feedEtag
  const now = new Date().toISOString()
  try {
    const headers: Record<string, string> = { accept: 'text/calendar, text/plain;q=0.8' }
    if (etag && !force) headers['if-none-match'] = etag
    const r = await fetchText(url, { headers }, MAX_ICS_BYTES)
    // The fetch can take many seconds; anything you did in the tab meanwhile (checked an item off,
    // deleted one, added a rule) is already on disk, so merge into a fresh copy, not the one we
    // read before the request.
    const store = load()
    if (r.status === 304) {
      store.lastPollAt = now
      store.lastPollError = null
      store.lastPollNew = 0
      save(store)
      return { ok: true, added: 0 }
    }
    if (!r.ok) throw new Error(r.status === 404 ? 'Canvas says this feed no longer exists (regenerated?).' : `Canvas returned HTTP ${r.status}.`)
    if (!/^\s*BEGIN:VCALENDAR/i.test(r.text)) throw new Error('That URL did not return a calendar.')
    const events = parseIcs(r.text)
    const firstPoll = !store.items.some((i) => i.source === 'canvas')
    const added: SchoolItem[] = []
    const moved: { item: SchoolItem; from: string }[] = []
    for (const ev of events) {
      const id = `canvas:${ev.uid}`
      if (store.deletedIds.includes(id)) continue
      const course = ev.course ?? 'OTHER'
      const c = ensureCourse(store, course, ev.courseId)
      const kind = classifyTitle(ev.summary, ev.isAssignment)
      const existing = store.items.find((i) => i.id === id)
      if (existing) {
        if (existing.due !== ev.day && !existing.done) moved.push({ item: existing, from: existing.due })
        existing.due = ev.day
        existing.dueTime = ev.time
        existing.title = ev.summary.slice(0, 200)
        existing.url = ev.url
        existing.kind = existing.kind === 'other' ? kind : existing.kind
        existing.lastSeenAt = now
        continue
      }
      const recurring = !ev.isAssignment && looksLikeRecurringEvent(ev.summary, ev.location)
      const item: SchoolItem = {
        id,
        source: 'canvas',
        course,
        title: ev.summary.slice(0, 200),
        kind,
        due: ev.day,
        dueTime: ev.time,
        url: ev.url,
        seenAt: now,
        lastSeenAt: now,
        done: false,
        doneAt: null,
        hidden: recurring && c.hideEvents,
        taskId: null,
        satisfiedBy: null
      }
      store.items.push(item)
      if (!item.hidden) {
        added.push(item)
        c.lastNewItemAt = now
      }
    }
    store.feedEtag = r.etag
    store.lastPollAt = now
    store.lastPollError = null
    store.lastPollNew = added.length
    save(store)
    expandRules()
    syncTasks()
    if (!firstPoll) {
      if (added.length) {
        const first = added.sort((a, b) => a.due.localeCompare(b.due))[0]
        notify(
          added.length === 1 ? `${first.course}: ${first.title}` : `${added.length} new deadlines on Canvas`,
          added.length === 1 ? `Due ${fmtDay(first.due)}` : added.map((i) => `${i.course}: ${i.title} (${fmtDay(i.due)})`).slice(0, 4).join('\n')
        )
      }
      for (const m of moved.slice(0, 3)) {
        notify(`${m.item.course}: due date moved`, `${m.item.title}: ${fmtDay(m.from)} → ${fmtDay(m.item.due)}`)
      }
    }
    pushView()
    return { ok: true, added: added.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const store = load()
    // Never let the URL (the secret) ride along in an error string.
    store.lastPollError = msg.replace(/https?:\/\/\S+/g, '<feed>').slice(0, 200)
    store.lastPollAt = now
    save(store)
    pushView()
    return { ok: false, error: store.lastPollError, added: 0 }
  }
}

function fmtDay(day: string): string {
  const d = new Date(day + 'T12:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

// ---------------------------------------------------------------------------
// Rules → instances
// ---------------------------------------------------------------------------

function weekdayOf(day: string): number {
  return new Date(day + 'T12:00:00').getDay()
}

/**
 * Materialise each enabled rule into dated items for a sliding window, then mark any slot that a
 * real (Canvas/Gradescope) item in the same course falls on as satisfied, so the ledger shows the
 * real posting rather than the placeholder.
 */
export function expandRules(): void {
  const store = load()
  const today = localDay()
  const from = addDays(today, -RULE_LOOKBACK_DAYS)
  const to = addDays(today, RULE_LOOKAHEAD_DAYS)
  let changed = false
  const liveRuleIds = new Set(store.rules.filter((r) => r.enabled).map((r) => r.id))

  // Drop untouched instances of rules that no longer exist, are disabled, or whose dates were
  // edited so the instance now falls outside the rule's term.
  const ruleById = new Map(store.rules.map((r) => [r.id, r]))
  const before = store.items.length
  store.items = store.items.filter((i) => {
    if (i.source !== 'rule') return true
    const [, ruleId, day] = i.id.split(':')
    const rule = ruleById.get(ruleId)
    const inTerm = rule ? day >= rule.startDate && day <= rule.endDate : false
    if (liveRuleIds.has(ruleId) && inTerm) return true
    if (i.done) return true
    if (i.taskId) removeTask(i.taskId, { sourceText: taskText(i) })
    return false
  })
  if (store.items.length !== before) changed = true

  for (const rule of store.rules) {
    if (!rule.enabled) continue
    const start = rule.startDate > from ? rule.startDate : from
    const end = rule.endDate < to ? rule.endDate : to
    for (let day = start; day <= end; day = addDays(day, 1)) {
      if (weekdayOf(day) !== rule.weekday) continue
      const id = `rule:${rule.id}:${day}`
      if (store.deletedIds.includes(id)) continue
      const n = occurrenceNumber(rule, day)
      const title = rule.title.replace(/\{n\}/g, String(n)).slice(0, 200)
      const existing = store.items.find((i) => i.id === id)
      if (existing) {
        if (existing.title !== title || existing.dueTime !== rule.time || existing.kind !== rule.kind) {
          existing.title = title
          existing.dueTime = rule.time
          existing.kind = rule.kind
          changed = true
        }
        continue
      }
      ensureCourse(store, rule.course)
      store.items.push({
        id,
        source: 'rule',
        course: rule.course,
        title,
        kind: rule.kind,
        due: day,
        dueTime: rule.time,
        url: null,
        seenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        done: false,
        doneAt: null,
        hidden: false,
        taskId: null,
        satisfiedBy: null
      })
      changed = true
    }
  }

  // Reconcile: one assignment, one row. Three ways the same thing arrives more than once:
  //  1. Canvas emits an assignment AND a section override of it ("Quiz 1" + "Quiz 1 (STAT 390 AD)").
  //  2. Canvas and Gradescope both list it, spelled differently ("Homework 1" / "HW 1").
  //  3. A syllabus one-off or recurring rule predicted it ("Week 2 Lab Quiz") and it then showed up.
  // Seen rows (canvas/gradescope) fold into one primary; predicted rows point at the seen one.
  // `satisfiedBy` hides the duplicate everywhere; done state flows to the primary, never undone.
  const seen = store.items.filter((i) => (i.source === 'canvas' || i.source === 'gradescope') && !i.hidden && i.kind !== 'event')
  const primaryOf = new Map<string, SchoolItem>()
  for (const i of seen) {
    const twin = seen.find(
      (r) => r !== i && r.course === i.course && Math.abs(dayDiff(r.due, i.due)) <= 1 && kindCompatible(r.kind, i.kind) && titleKey(r.title) === titleKey(i.title)
    )
    if (!twin) continue
    const group = seen.filter((r) => r.course === i.course && Math.abs(dayDiff(r.due, i.due)) <= 1 && kindCompatible(r.kind, i.kind) && titleKey(r.title) === titleKey(i.title))
    const primary = group.slice().sort((a, b) => duplicateRank(b) - duplicateRank(a))[0]
    for (const g of group) primaryOf.set(g.id, primary)
  }
  for (const i of seen) {
    const primary = primaryOf.get(i.id)
    const next = primary && primary.id !== i.id ? primary.id : null
    if (primary && primary.id !== i.id) {
      if (i.done && !primary.done) {
        primary.done = true
        primary.doneAt = i.doneAt ?? new Date().toISOString()
        changed = true
      }
      // Section overrides carry the real due time; keep the cleaner base title.
      if (/override/.test(i.id) && (primary.due !== i.due || primary.dueTime !== i.dueTime)) {
        primary.due = i.due
        primary.dueTime = i.dueTime
        changed = true
      }
    }
    if (i.satisfiedBy !== next) {
      i.satisfiedBy = next
      changed = true
    }
  }
  const real = seen.filter((i) => !i.satisfiedBy)
  for (const inst of store.items) {
    if (inst.source !== 'rule' && inst.source !== 'syllabus') continue
    const prev = inst.satisfiedBy
    const match = real.find((r) => r.course === inst.course && Math.abs(dayDiff(r.due, inst.due)) <= RULE_MATCH_WINDOW_DAYS && predictedMatches(inst, r))
    const next = match ? match.id : null
    if (prev !== next) {
      inst.satisfiedBy = next
      changed = true
    }
  }
  if (changed) save(store)
}

/**
 * A recurring rule is loose by design (any compatible work in the window). A syllabus one-off is a
 * specific thing, so it needs the same kind for quizzes/exams/labs, or a matching title for work.
 */
function predictedMatches(predicted: SchoolItem, real: SchoolItem): boolean {
  if (!kindCompatible(real.kind, predicted.kind)) return false
  if (predicted.source === 'rule') return true
  if (predicted.kind === 'quiz' || predicted.kind === 'exam') return real.kind === predicted.kind
  const a = titleKey(predicted.title)
  const b = titleKey(real.title)
  return a === b || a.startsWith(b) || b.startsWith(a)
}

/**
 * Which duplicate stays visible: knows a due time > Gradescope (knows submission) > has a link. A Canvas
 * section override ranks last so the clean base title stays, but its due time is copied onto the base above.
 */
function duplicateRank(i: SchoolItem): number {
  return (/override/.test(i.id) ? -8 : 0) + (i.dueTime ? 4 : 0) + (i.source === 'gradescope' ? 2 : 0) + (i.url ? 1 : 0)
}

/**
 * "HW 1", "Homework #01", "Homework 1 (STAT 390 AD)" → "homework 1". Only a trailing parenthetical
 * that looks like a course/section tag is dropped; "(Ch. 3)" vs "(Ch. 4)" are different assignments.
 */
export function titleKey(title: string): string {
  return title
    .replace(/\s*\(([^)]*)\)\s*$/, (m, inner: string) => (looksLikeSectionTag(inner) ? '' : m))
    .toLowerCase()
    .replace(/\s*[-–:]\s*(section|sec)\s+\w+$/, '')
    .replace(/\b(hw|hmwk|hwk|assignment|assn|asgn)\b/g, 'homework')
    .replace(/\bpset\b|problem set/g, 'problem set')
    .replace(/#/g, ' ')
    .replace(/\b0+(\d)/g, '$1')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "STAT 390 AD", "EE 241 A", "Section B", "AD", "Lec 2" — not "Ch. 3", "Week 2", "optional". */
function looksLikeSectionTag(inner: string): boolean {
  const s = inner.trim()
  if (!s) return true
  if (/^[A-Z]{1,5}\s?\d{2,4}[A-Z]?(\s+[A-Z]{1,3}\d?)?$/.test(s)) return true // course code (+ section)
  if (/^(section|sec|sect|lecture|lec|lab|quiz section)\s*[A-Z0-9]{1,3}$/i.test(s)) return true
  return /^[A-Z]{1,3}\d?$/.test(s) // bare section letters: "AD", "B", "A1"
}

function kindCompatible(a: SchoolKind, b: SchoolKind): boolean {
  if (a === b) return true
  const work = new Set<SchoolKind>(['assignment', 'project', 'other'])
  return work.has(a) && work.has(b)
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a + 'T12:00:00') - Date.parse(b + 'T12:00:00')) / 86_400_000)
}

/** 1-based index of this occurrence counting from the rule's start date. */
function occurrenceNumber(rule: SchoolRule, day: string): number {
  const first = firstOccurrence(rule)
  return Math.floor(dayDiff(day, first) / 7) + 1
}

function firstOccurrence(rule: SchoolRule): string {
  let d = rule.startDate
  for (let i = 0; i < 7; i++) {
    if (weekdayOf(d) === rule.weekday) return d
    d = addDays(d, 1)
  }
  return rule.startDate
}

// ---------------------------------------------------------------------------
// Tasks mirror
// ---------------------------------------------------------------------------

function visible(store: SchoolStore, i: SchoolItem): boolean {
  if (i.hidden || i.satisfiedBy) return false
  const c = store.courses.find((x) => x.course === i.course)
  return !(c && c.hidden)
}

function taskText(i: SchoolItem): string {
  return `${i.course}: ${i.title}`
}

/**
 * Tasks → School. A task you put on the School track (or that Notes classified there) shows up in
 * the ledger as your own row, linked both ways: done here is done there, and the row keeps the
 * task's text and deadline. "STAT 390 reread ch. 3" lands under STAT 390; anything without a
 * recognisable course goes under General. A task with no deadline floats on today until done.
 */
function adoptSchoolTasks(store: ReturnType<typeof load>, today: string): boolean {
  const linked = new Set(store.items.map((i) => i.taskId).filter((x): x is string => Boolean(x)))
  const known = store.courses.filter((c) => !c.hidden).map((c) => c.course)
  let changed = false
  for (const t of listTasks()) {
    if (t.track !== 'school' || linked.has(t.id)) continue
    if (t.state !== 'open' && t.state !== 'snoozed') continue
    if (t.sourceNote === 'school') continue // the mirror's own task whose row was deleted; not a new one
    const { course, title } = splitCourse(t.text, known)
    const guessed = classifyTitle(title, true)
    const kind: SchoolKind = guessed === 'assignment' && !/\b(hw|homework|assignment|pset|problem set|lab|worksheet)\b/i.test(title) ? 'study' : guessed
    const now = new Date().toISOString()
    store.items.push({
      id: newId('task'),
      source: 'manual',
      fromTask: true,
      course,
      title,
      kind,
      due: t.deadline ?? today,
      dueTime: null,
      url: null,
      seenAt: now,
      lastSeenAt: now,
      done: false,
      doneAt: null,
      hidden: false,
      taskId: t.id,
      satisfiedBy: null
    })
    linked.add(t.id)
    changed = true
  }
  return changed
}

/**
 * "STAT 390: reread ch. 3" / "stat390 hw 2" / "Rewatch EE 241 lecture 5" → the course and the rest.
 * Known courses win however they are spaced or cased ("EE 241" is your "E E 241"); otherwise an
 * upper-case code like "CSE 143" counts; anything else goes under General.
 */
export function splitCourse(text: string, known: string[]): { course: string; title: string } {
  const squash = (s: string): string => s.replace(/\s+/g, '').toUpperCase()
  const tidy = (s: string): string => s.replace(/^\s*[:\-–—]\s*/, '').replace(/\s*[:\-–—]\s*$/, '').replace(/\s+/g, ' ').trim() || text.trim()
  const codes = [...text.matchAll(/\b([A-Za-z]{1,6}(?:\s[A-Za-z]{1,2})?\s?\d{3}[A-Za-z]?)\b/g)]
  for (const m of codes) {
    const hit = known.find((k) => squash(k) === squash(m[1]))
    if (hit) return { course: hit, title: tidy(text.replace(m[0], ' ')) }
  }
  const upper = codes.find((m) => /^[A-Z]/.test(m[1]) && m[1] === m[1].toUpperCase())
  if (upper) return { course: courseKey(upper[1]), title: tidy(text.replace(upper[0], ' ')) }
  return { course: 'General', title: text.trim() }
}

/**
 * Two-way mirror. School → Tasks: every visible, undone deadline within the horizon has a task
 * with the right deadline. Tasks → School: completing the task completes the item; dismissing it
 * hides the item. Removing a task is only done while it is untouched (removeTask's own guard).
 */
export function syncTasks(): void {
  const store = load()
  const { taskHorizonDays } = getSchoolConfig()
  const horizon = addDays(localDay(), taskHorizonDays)
  // No lower bound would turn a mid-term Canvas connect into a wall of overdue tasks for work you
  // already handed in (the ICS feed carries the whole term and no submission state). Yesterday's
  // misses still surface; older ones stay in the School ledger only.
  const floor = addDays(localDay(), -TASK_LOOKBACK_DAYS)
  const today = localDay()
  let changed = adoptSchoolTasks(store, today)
  const tasks = new Map(listTasks().map((t) => [t.id, t]))
  for (const item of store.items) {
    const t = item.taskId ? tasks.get(item.taskId) : undefined
    if (item.taskId && !t) {
      item.taskId = null
      changed = true
      if (item.fromTask && !item.done) {
        // The task it came from was deleted outright; its row goes too.
        item.hidden = true
      }
    }
    if (t && item.fromTask) {
      // The task owns a task-born row. Text, deadline and track all flow this way.
      const want = t.deadline ?? today
      if (!item.done && item.due !== want) {
        item.due = want
        changed = true
      }
      const { course, title } = splitCourse(t.text, store.courses.filter((c) => !c.hidden).map((c) => c.course))
      if (item.title !== title || item.course !== course) {
        item.title = title
        item.course = course
        changed = true
      }
      if (t.track !== 'school' && !item.hidden) {
        item.hidden = true
        changed = true
      } else if (t.track === 'school' && item.hidden && t.state !== 'dismissed' && t.state !== 'archived') {
        item.hidden = false
        changed = true
      }
    }
    if (t) {
      // The mirror owns this task. An older build's Notes reconcile relabelled some as note-sourced
      // ("Courses", "Work"), which blocked cleanup and risked an auto-complete; take them back.
      if (!item.fromTask && t.sourceNote !== 'school') syncTaskFromSource(t.id, { sourceNote: 'school' })
      if (t.state === 'done' && !item.done) {
        item.done = true
        item.doneAt = t.updatedAt
        changed = true
      } else if (t.state === 'dismissed' || t.state === 'archived') {
        if (!item.hidden) {
          item.hidden = true
          changed = true
        }
      } else if (item.done && (t.state === 'open' || t.state === 'snoozed')) {
        // Whichever side moved last wins: School marked it done after the task was last touched →
        // complete the task; the task was reopened after that → reopen the item.
        if ((item.doneAt ?? '') >= t.updatedAt) {
          setTaskState(t.id, 'done')
        } else {
          item.done = false
          item.doneAt = null
          changed = true
        }
      } else if (!item.done && !item.fromTask && t.deadline !== item.due) {
        syncTaskFromSource(t.id, { deadline: item.due })
      }
      // Keep the title in step with the source while the task is still untouched by the user.
      if (!item.fromTask && !item.done && t.text !== taskText(item) && t.updatedAt === t.createdAt && (t.state === 'open' || t.state === 'snoozed')) {
        syncTaskFromSource(t.id, { text: taskText(item) })
      }
    }
    // Task-born rows are the task's; the mirror window never creates or removes their task.
    if (item.fromTask) continue
    // Horizon 0 means "never mirror". Otherwise a deadline inside the window gets a task; one that
    // has slipped outside it (the window was shrunk) loses its task again, but only while untouched
    // (removeTask's guard), so anything you edited or snoozed stays on the list.
    const inWindow = taskHorizonDays > 0 && item.due <= horizon && item.due >= floor
    const shouldHaveTask = visible(store, item) && !item.done && inWindow && item.kind !== 'event'
    // Only the far edge takes a task away: an overdue task stays on the board until you finish it.
    const slippedOut = taskHorizonDays === 0 || item.due > horizon
    if (shouldHaveTask && !item.taskId) {
      const id = addTask(taskText(item), {
        sourceNote: 'school',
        track: 'school',
        deadline: item.due,
        priority: item.kind === 'exam' || item.kind === 'project' ? 'high' : 'medium'
      })
      if (id) {
        item.taskId = id
        changed = true
      }
    } else if (!shouldHaveTask && item.taskId && t && !item.done && (item.hidden || item.satisfiedBy || slippedOut)) {
      if (removeTask(item.taskId, { sourceText: taskText(item) })) {
        item.taskId = null
        changed = true
      }
    }
  }
  if (changed) save(store)
  updateTrayCount()
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

function buildFlags(store: SchoolStore, feedConfigured: boolean): SchoolFlag[] {
  const flags: SchoolFlag[] = []
  const today = localDay()
  if (store.lastPollError) {
    flags.push({ kind: 'feed-error', course: null, week: null, message: `Canvas feed: ${store.lastPollError}` })
  } else if (!feedConfigured) {
    flags.push({ kind: 'feed-missing', course: null, week: null, message: 'No Canvas feed yet — add it in Settings → School.' })
  }
  for (const l of getLmsStatus()) {
    const name = l.kind === 'canvas' ? 'Canvas login' : 'Gradescope'
    if (!l.connected) continue
    if (l.needsLogin) flags.push({ kind: 'lms-login', course: null, week: null, message: `${name}: signed out — reconnect to keep syncing.` })
    else if (l.lastError) flags.push({ kind: 'lms-error', course: null, week: null, message: `${name}: ${l.lastError}` })
  }

  // Expected-not-seen: a rule slot in this or next week, unsatisfied, in a course where a syncing
  // source has actually delivered assignments before (office-hours events don't count — STAT 390
  // posts homework on Gradescope, so its Canvas calendar never will). Without such a source the
  // rule instance itself is the item.
  const syncing = new Set(
    store.items
      .filter((i) => (i.source === 'canvas' || i.source === 'gradescope') && i.kind !== 'event' && !i.hidden)
      .map((i) => i.course)
  )
  const thisWeek = weekOf(today)
  const nextWeek = addDays(thisWeek, 7)
  for (const inst of store.items) {
    if (inst.source !== 'rule' || inst.satisfiedBy || inst.done || inst.hidden) continue
    // A recurring study habit ("rewatch lecture every Thu") is yours; no feed will ever "post" it.
    if (inst.kind === 'study' || inst.kind === 'event') continue
    if (!syncing.has(inst.course) || inst.due < today) continue
    const w = weekOf(inst.due)
    if (w !== thisWeek && w !== nextWeek) continue
    flags.push({
      kind: 'expected-not-seen',
      course: inst.course,
      week: w,
      message: `${inst.course}: expected ${inst.title} (${WEEKDAY_LABELS[weekdayOf(inst.due)]}) — not posted yet`
    })
  }

  // Quiet course: used to post, hasn't lately, while others have.
  const cutoff = new Date(Date.now() - QUIET_DAYS * 86_400_000).toISOString()
  const active = store.courses.filter((c) => !c.hidden && c.lastNewItemAt)
  const anyRecent = active.some((c) => (c.lastNewItemAt ?? '') >= cutoff)
  if (anyRecent) {
    for (const c of active) {
      const count = store.items.filter((i) => i.course === c.course && i.source !== 'rule' && !i.hidden).length
      if (count >= 2 && (c.lastNewItemAt ?? '') < cutoff) {
        flags.push({
          kind: 'quiet',
          course: c.course,
          week: null,
          message: `${c.course} hasn't posted anything new in ${QUIET_DAYS}+ days — worth a look at the course page`
        })
      }
    }
  }
  return flags
}

// ---------------------------------------------------------------------------
// View + user actions
// ---------------------------------------------------------------------------

export function getView(): SchoolView {
  const store = load()
  const { feedConfigured } = getSchoolConfig()
  const floor = addDays(localDay(), -VIEW_PAST_DAYS)
  return {
    items: store.items.filter((i) => i.due >= floor),
    rules: store.rules,
    courses: store.courses,
    flags: buildFlags(store, feedConfigured),
    status: {
      feedConfigured,
      lastPollAt: store.lastPollAt,
      lastPollError: store.lastPollError,
      lastPollNew: store.lastPollNew,
      lastDigestAt: store.lastDigestAt
    },
    lms: getLmsStatus(),
    announcementSuggestions: getAnnouncementSuggestions(),
    llmConfigured: llmConfigured(),
    browserAvailable: browserAvailable()
  }
}

function cleanTitle(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

function cleanCourse(raw: unknown): string {
  const k = courseKey(String(raw ?? '').slice(0, 40))
  if (!/^[A-Z][A-Z0-9 &/-]{1,30}$/.test(k)) throw new Error('Course should look like "STAT 390" or "E E 241".')
  return foldCourse(k)
}

/** UW prints "E E 241"; people type "EE 241". Fold onto a course the ledger already knows. */
function foldCourse(k: string): string {
  const flat = k.replace(/\s+/g, '')
  const known = load().courses.find((c) => c.course.replace(/\s+/g, '') === flat)
  return known ? known.course : k
}

function cleanKind(raw: unknown, fallback: SchoolKind): SchoolKind {
  return SCHOOL_KINDS.includes(raw as SchoolKind) ? (raw as SchoolKind) : fallback
}

function cleanTime(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  const t = String(raw).trim()
  if (!TIME_RE.test(t)) throw new Error('Time should be HH:MM (24-hour), like 21:10.')
  return t
}

function cleanUrl(raw: unknown): string | null {
  if (!raw) return null
  try {
    const u = new URL(String(raw))
    if (u.protocol !== 'https:') return null
    return u.toString().slice(0, 500)
  } catch {
    return null
  }
}

/** Already on the ledger? Same course, same day, similar title (either contains the other). */
export function hasSimilarItem(course: string, due: string, title: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const t = norm(title)
  const key = foldCourse(courseKey(course))
  return load().items.some((i) => i.course === key && i.due === due && (norm(i.title) === t || norm(i.title).includes(t) || t.includes(norm(i.title))))
}

/** An enabled rule for the same course and weekday with a matching title already exists. */
export function hasSimilarRule(course: string, weekday: number, title: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/\{n\}/g, '').replace(/[^a-z]+/g, ' ').trim()
  const t = norm(title)
  const key = foldCourse(courseKey(course))
  return load().rules.some((r) => r.course === key && r.weekday === weekday && norm(r.title) === t)
}

export function addItem(input: QuickAddInput, source: 'manual' | 'syllabus' | 'canvas' = 'manual'): SchoolItem {
  const course = cleanCourse(input.course)
  const title = cleanTitle(input.title)
  if (!title) throw new Error('Give it a title.')
  if (!validDay(input.due)) throw new Error('Due date should be YYYY-MM-DD.')
  const store = load()
  ensureCourse(store, course)
  const now = new Date().toISOString()
  const item: SchoolItem = {
    id: newId(source),
    source,
    course,
    title,
    kind: cleanKind(input.kind, classifyTitle(title, true)),
    due: input.due,
    dueTime: cleanTime(input.time),
    url: cleanUrl(input.url),
    seenAt: now,
    lastSeenAt: now,
    done: false,
    doneAt: null,
    hidden: false,
    taskId: null,
    satisfiedBy: null
  }
  store.items.push(item)
  save(store)
  syncTasks()
  pushView()
  return item
}

export function setDone(id: string, done: boolean): void {
  const store = load()
  const item = store.items.find((i) => i.id === id)
  if (!item) return
  item.done = done
  item.doneAt = done ? new Date().toISOString() : null
  save(store)
  if (item.taskId) setTaskState(item.taskId, done ? 'done' : 'open')
  syncTasks()
  pushView()
}

/**
 * A task-born row is owned by its task: syncTasks would undo a bare `hidden` flip on the next
 * tick. Hiding one means "this isn't school work" — move the task off the School track (it stays
 * in Tasks); unhiding puts it back. Feed rows just flip the flag.
 */
export function setHidden(id: string, hidden: boolean): void {
  const store = load()
  const item = store.items.find((i) => i.id === id)
  if (!item) return
  item.hidden = hidden
  save(store)
  if (item.fromTask && item.taskId) setTaskTrack(item.taskId, hidden ? 'other' : 'school')
  syncTasks()
  pushView()
}

/**
 * Remove for good. The id is remembered so a feed re-send doesn't resurrect it. A task-born row
 * comes back through adoptSchoolTasks as long as its task is on the School track, so the task is
 * moved off the track (deleting it outright would lose the user's own task).
 */
export function deleteItem(id: string): void {
  const store = load()
  const idx = store.items.findIndex((i) => i.id === id)
  if (idx === -1) return
  const [item] = store.items.splice(idx, 1)
  if (item.taskId) {
    if (item.fromTask) setTaskTrack(item.taskId, 'other')
    else removeTask(item.taskId, { sourceText: taskText(item) })
  }
  if (!store.deletedIds.includes(id)) store.deletedIds.push(id)
  if (store.deletedIds.length > 2000) store.deletedIds = store.deletedIds.slice(-2000)
  save(store)
  pushView()
}

export function saveRule(input: RuleInput): SchoolRule {
  const course = cleanCourse(input.course)
  const title = cleanTitle(input.title)
  if (!title) throw new Error('Give the rule a title, like "Homework {n}".')
  const weekday = Number(input.weekday)
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Pick a weekday.')
  const time = cleanTime(input.time) ?? '23:59'
  if (!validDay(input.startDate) || !validDay(input.endDate) || input.endDate < input.startDate) {
    throw new Error('Start and end dates should be YYYY-MM-DD, start first.')
  }
  if (dayDiff(input.endDate, input.startDate) > 200) throw new Error('A rule can span at most 200 days (one term).')
  const store = load()
  let rule = input.id ? store.rules.find((r) => r.id === input.id) : undefined
  if (!rule) {
    rule = {
      id: newId('r').slice(2),
      course,
      title,
      kind: cleanKind(input.kind, 'assignment'),
      weekday: weekday as SchoolRule['weekday'],
      time,
      startDate: input.startDate,
      endDate: input.endDate,
      enabled: input.enabled !== false,
      createdAt: new Date().toISOString()
    }
    store.rules.push(rule)
  } else {
    Object.assign(rule, {
      course,
      title,
      kind: cleanKind(input.kind, rule.kind),
      weekday,
      time,
      startDate: input.startDate,
      endDate: input.endDate,
      enabled: input.enabled !== false
    })
  }
  ensureCourse(store, course)
  save(store)
  expandRules()
  syncTasks()
  pushView()
  return rule
}

export function deleteRule(id: string): void {
  const store = load()
  store.rules = store.rules.filter((r) => r.id !== id)
  save(store)
  expandRules()
  syncTasks()
  pushView()
}

export function setCourse(course: string, patch: { name?: string; hidden?: boolean; hideEvents?: boolean }): void {
  const store = load()
  const c = store.courses.find((x) => x.course === course)
  if (!c) return
  if (typeof patch.name === 'string') c.name = cleanTitle(patch.name).slice(0, 80) || c.course
  if (typeof patch.hidden === 'boolean') c.hidden = patch.hidden
  if (typeof patch.hideEvents === 'boolean') {
    c.hideEvents = patch.hideEvents
    // Re-apply to existing calendar events for this course so the toggle is immediate.
    for (const i of store.items) {
      if (i.course === course && i.source === 'canvas' && i.kind === 'event') i.hidden = patch.hideEvents
    }
  }
  save(store)
  syncTasks()
  pushView()
}

// ---------------------------------------------------------------------------
// Sunday digest
// ---------------------------------------------------------------------------

function maybeSendDigest(): void {
  const now = new Date()
  if (now.getDay() !== 0 || now.getHours() < DIGEST_HOUR) return
  const store = load()
  const today = localDay()
  if (store.lastDigestAt && weekOf(localDay(store.lastDigestAt)) === weekOf(today)) return
  const nextMon = addDays(weekOf(today), 7)
  const nextSun = addDays(nextMon, 6)
  const upcoming = store.items.filter((i) => visible(store, i) && !i.done && i.kind !== 'event' && i.due >= nextMon && i.due <= nextSun)
  const byCourse = new Map<string, number>()
  for (const i of upcoming) byCourse.set(i.course, (byCourse.get(i.course) ?? 0) + 1)
  const flags = buildFlags(store, getSchoolConfig().feedConfigured).filter((f) => f.kind === 'expected-not-seen' || f.kind === 'quiet')
  const lines = [...byCourse.entries()].sort().map(([c, n]) => `${c}: ${n}`)
  const body = [
    upcoming.length ? `${upcoming.length} due — ${lines.join(', ')}` : 'Nothing due that briefly knows about.',
    flags.length ? `${flags.length} to check: ${flags.map((f) => f.course).join(', ')}` : null,
    'Anything missing? Add it in School.'
  ]
    .filter(Boolean)
    .join('\n')
  notify('Next week at school', body)
  store.lastDigestAt = now.toISOString()
  save(store)
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    const { pollMinutes, feedConfigured } = getSchoolConfig()
    const store = load()
    const due =
      feedConfigured && pollMinutes > 0 && (!store.lastPollAt || Date.now() - Date.parse(store.lastPollAt) >= pollMinutes * 60_000 - 60_000)
    if (due) await pollFeed()
    await syncLmsIfDue()
    expandRules()
    syncTasks()
    maybeSendDigest()
    pushView()
  } catch (err) {
    console.warn('[school] tick failed', err)
  } finally {
    running = false
  }
}

export function initSchoolScheduler(windowGetter: () => BrowserWindow | null, popoverOpener: () => void): void {
  getWindow = windowGetter
  openPopover = popoverOpener
  powerMonitor.on('resume', () => setTimeout(() => void tick(), 40_000))
  scheduleSchoolPoll()
  setTimeout(() => void tick(), 60_000)
}

/** Re-armed whenever Settings change; the tick itself re-reads the interval. */
export function scheduleSchoolPoll(): void {
  if (timer) clearInterval(timer)
  timer = null
  const { pollMinutes } = getSchoolConfig()
  // Check every 15 minutes regardless; the tick decides whether a poll is due. Keeps rule
  // expansion and task sync fresh even when the feed is off.
  timer = setInterval(() => void tick(), Math.min(15, pollMinutes || 15) * 60_000)
  // A new task horizon should show on the Tasks tab now, not at the next tick.
  if (!running) {
    syncTasks()
    pushView()
  }
}

/** Settings just saved a new feed URL: pull it right away so the tab fills in. */
export async function onFeedChanged(): Promise<void> {
  if (running) return
  running = true
  try {
    await pollFeed(true)
    expandRules()
    syncTasks()
    pushView()
  } finally {
    running = false
  }
}
