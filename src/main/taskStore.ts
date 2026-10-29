import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppState, Horizon, Priority, Task, TaskState, TodayStrip, Track } from '../shared/types'
import { HORIZONS, TRACKS } from '../shared/types'
import {
  addDays,
  currentWorkDay,
  localDay,
  localDayOffset,
  naturalWorkDay,
  workDayOf,
  type DayConfig
} from '../shared/dates'
import { getDayStartHour } from './settings'
import type { Note } from './notes'

interface StoreFile {
  tasks: Task[]
  today: TodayStrip | null
  lastRefreshed: string | null
  /** What-changed items the user dismissed; suppressed from regenerated strips on the same work day. */
  dismissedToday?: { date: string; texts: string[] }
  /** taskId → local day it was last included in a deadline notification. */
  notified?: Record<string, string>
  /** Manual End-day marker; expires once the natural work-day boundary passes. */
  dayClosed?: {
    day: string
    at: string
    /** Recurring tasks the close reopened, with their prior completion time — for exact undo. */
    reopened: { id: string; updatedAt: string }[]
  } | null
  /** Notes seen at the last reconcile; a sharp drop means a partial read, not mass deletion. */
  notesCountAtReconcile?: number
  /** Set once unlinkDriftedSources has run against this store. */
  driftRepairedAt?: string
}

export interface LlmTask {
  id: string | null
  text: string
  track: string
  priority: string
  deadline: string | null
  sourceNote: string
  sourceExcerpt?: string
  horizon?: string
  recurring?: boolean
}

export interface MergeResponse {
  tasks: LlmTask[]
  removedIds: string[]
  /** priorities is legacy — older prompts/models may still emit it; ignored. */
  today: { changes: string[]; priorities?: string[] }
}

function storePath(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'tasks.json')
}

function load(): StoreFile {
  const path = storePath()
  if (!existsSync(path)) return { tasks: [], today: null, lastRefreshed: null }
  try {
    const store = JSON.parse(readFileSync(path, 'utf8')) as StoreFile
    // Migrate older strip shapes (freeform priorities, then task-linked priorityIds):
    // only the changes list survives — the pulse line replaced curated priorities.
    if (store.today) {
      store.today = {
        changes: Array.isArray(store.today.changes) ? store.today.changes : [],
        generatedAt: store.today.generatedAt ?? new Date().toISOString()
      }
    }
    for (const t of store.tasks) {
      if (!t.horizon || !HORIZONS.includes(t.horizon)) t.horizon = 'soon'
    }
    return store
  } catch {
    return { tasks: [], today: null, lastRefreshed: null }
  }
}

function save(store: StoreFile): void {
  // Atomic write: a crash mid-write can never corrupt the store.
  const path = storePath()
  writeFileSync(path + '.tmp', JSON.stringify(store, null, 2))
  renameSync(path + '.tmp', path)
}

/** Wake snoozed tasks whose snooze period has elapsed. */
function wakeSnoozed(store: StoreFile): void {
  const now = new Date().toISOString()
  for (const task of store.tasks) {
    if (task.state === 'snoozed' && task.snoozedUntil && task.snoozedUntil <= now) {
      task.state = 'open'
      task.snoozedUntil = null
      task.updatedAt = now
    }
  }
}

/** Reopen daily-recurring tasks completed on a previous work day. Returns what it flipped. */
function resetRecurring(store: StoreFile, now = new Date().toISOString()): { id: string; updatedAt: string }[] {
  const cfg = dayConfig(store)
  const today = currentWorkDay(cfg)
  const flipped: { id: string; updatedAt: string }[] = []
  for (const task of store.tasks) {
    if (task.recurrence === 'daily' && task.state === 'done' && workDayOf(task.updatedAt, cfg) < today) {
      flipped.push({ id: task.id, updatedAt: task.updatedAt })
      task.state = 'open'
      task.updatedAt = now
    }
  }
  return flipped
}

/** Drop the End-day marker once the natural boundary has passed it. */
function expireDayClose(store: StoreFile): void {
  if (!store.dayClosed) return
  if (naturalWorkDay(new Date().toISOString(), getDayStartHour()) > store.dayClosed.day) {
    store.dayClosed = null
  }
}

function dayConfig(store: StoreFile): DayConfig {
  const c = store.dayClosed
  return { startHour: getDayStartHour(), closed: c ? { day: c.day, at: c.at } : null }
}

function toState(store: StoreFile, hasApiKey: boolean): AppState {
  return {
    tasks: store.tasks,
    today: store.today,
    lastRefreshed: store.lastRefreshed,
    hasApiKey,
    day: dayConfig(store)
  }
}

/** Cap store growth: done/archived tasks older than 90 days age out. Dismissed are kept (suppression). */
function pruneOld(store: StoreFile): void {
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
  store.tasks = store.tasks.filter(
    (t) =>
      !((t.state === 'done' || t.state === 'archived') && new Date(t.updatedAt).getTime() < cutoff)
  )
}

/** All load-time maintenance in one place. */
function sweep(store: StoreFile): void {
  expireDayClose(store)
  wakeSnoozed(store)
  resetRecurring(store)
  expirePins(store)
  pruneOld(store)
  unlinkDriftedSources(store)
}

/**
 * One-time repair for the drift bug: earlier builds let the merge LLM re-home existing tasks onto
 * guessed notes and let fuzzy reconcile hits become the task's anchor, so user-typed tasks ended up
 * "from" unrelated notes ("Prep Stripe" → Shopping / "Rotisserie chicken"). For user-owned live tasks
 * whose remembered line shares under half its words with the task, drop the link back to quick add.
 * Links that still resemble the task are kept — they're at worst a related line the user renamed.
 */
function unlinkDriftedSources(store: StoreFile): void {
  if (store.driftRepairedAt) return
  for (const t of store.tasks) {
    if (t.state !== 'open' && t.state !== 'snoozed') continue
    if (!t.editedByUser || !t.sourceNote || t.sourceNote === 'quick add' || t.sourceNote === 'unknown') continue
    if (APP_SOURCES.has(t.sourceNote)) continue
    const text = tokenize(normalizeLine(t.text))
    if (text.size === 0) continue
    const anchors = [t.sourceExcerpt ?? '', t.sourceNote]
      .map((a) => tokenize(normalizeLine(a)))
      .filter((a) => a.size > 0)
    // A link is real when the anchor is wholly inside the task ("Sentinel" → "Work on Sentinel") or
    // the two share at least two words and half the task's wording. A single shared word is not
    // evidence: "Prep Stripe" shared only "prep" with a rotisserie-chicken shopping line.
    const vouches = (a: Set<string>): boolean => {
      const common = [...text].filter((w) => a.has(w)).length
      return common === a.size || (common >= 2 && common / text.size >= 0.5)
    }
    if (anchors.some(vouches)) continue
    t.sourceNote = 'quick add'
    delete t.sourceExcerpt
    delete t.sourceVerifiedAt
  }
  store.driftRepairedAt = new Date().toISOString()
}

function normalizeTrack(value: string): Track {
  return (TRACKS as string[]).includes(value) ? (value as Track) : 'other'
}

function normalizePriority(value: string): Priority {
  return value === 'high' || value === 'low' ? value : 'medium'
}

function normalizeHorizon(value: string | undefined): Horizon {
  return HORIZONS.includes(value as Horizon) ? (value as Horizon) : 'soon'
}

export function getState(hasApiKey: boolean): AppState {
  const store = load()
  sweep(store)
  save(store)
  return toState(store, hasApiKey)
}

export function getLastRefreshed(): string | null {
  return load().lastRefreshed
}

export function getOpenTasks(): Task[] {
  const store = load()
  sweep(store)
  return store.tasks.filter((t) => t.state === 'open' || t.state === 'snoozed')
}

export function getOpenCount(): number {
  // Sweep first so the tray badge reflects overnight recurrence resets and expired snoozes.
  const store = load()
  sweep(store)
  return store.tasks.filter((t) => t.state === 'open').length
}

/** Texts the LLM must not recreate: dismissed = forever, done = recent window. */
export function getSuppressedTexts(doneDays = 30): string[] {
  const cutoff = Date.now() - doneDays * 24 * 60 * 60 * 1000
  return load()
    .tasks.filter(
      (t) =>
        t.state === 'dismissed' ||
        // Recurring tasks reopen daily by design — completing one must not suppress it.
        (t.state === 'done' && !t.recurrence && new Date(t.updatedAt).getTime() >= cutoff)
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 150) // Cap prompt size — ancient dismissals are stale enough to age out.
    .map((t) => `${t.text} [source note: ${t.sourceNote}]`)
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'all', 'his', 'her',
  'out', 'get', 'new', 'your', 'our', 'their'
])

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  )
}

/** True when the smaller text shares at least half its meaningful words with the other. */
function similarText(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false
  let common = 0
  for (const w of a) if (b.has(w)) common++
  return common / Math.min(a.size, b.size) >= 0.5
}

export function setTaskState(id: string, state: TaskState, snoozedUntil?: string): void {
  const store = load()
  const task = store.tasks.find((t) => t.id === id)
  if (!task) return
  // Unchecking something Notes had closed is a verdict: the task outlives its note line. Drop the
  // verification so the next scan can't re-complete it from the same missing line (it would, every
  // scan, forever). If the line turns up again the scan re-verifies and the link is live once more.
  if (state === 'open' && task.state === 'done' && task.completedVia === 'notes') {
    delete task.completedVia
    delete task.sourceVerifiedAt
  }
  task.state = state
  task.snoozedUntil = state === 'snoozed' ? (snoozedUntil ?? defaultSnooze()) : null
  task.updatedAt = new Date().toISOString()
  save(store)
}

export function updateTaskText(id: string, text: string): void {
  const trimmed = text.trim().slice(0, 500)
  if (!trimmed) return
  const store = load()
  const task = store.tasks.find((t) => t.id === id)
  if (!task || task.text === trimmed) return
  task.text = trimmed
  task.editedByUser = true
  task.updatedAt = new Date().toISOString()
  save(store)
}

export function setTaskRecurrence(id: string, recurrence: 'daily' | null): void {
  const store = load()
  const task = store.tasks.find((t) => t.id === id)
  if (!task) return
  task.recurrence = recurrence
  task.updatedAt = new Date().toISOString()
  save(store)
}

export function setTaskHorizon(id: string, horizon: Horizon): void {
  const store = load()
  const task = store.tasks.find((t) => t.id === id)
  if (!task) return
  task.horizon = horizon
  task.horizonPinned = true
  task.updatedAt = new Date().toISOString()
  save(store)
}

export function setTaskTrack(id: string, track: Track): void {
  const store = load()
  const task = store.tasks.find((t) => t.id === id)
  if (!task) return
  task.track = track
  task.trackPinned = true
  task.updatedAt = new Date().toISOString()
  save(store)
}

export function setTaskPriority(id: string, priority: Priority): void {
  const store = load()
  const task = store.tasks.find((t) => t.id === id)
  if (!task) return
  task.priority = priority
  task.priorityPinned = true
  task.updatedAt = new Date().toISOString()
  save(store)
}

/** Pin a task as a must-finish for the current work day. Does not touch updatedAt: pinning isn't editing. */
export function setTaskPinned(id: string, pinned: boolean): void {
  const store = load()
  const task = store.tasks.find((t) => t.id === id)
  if (!task) return
  task.pinned = pinned
  task.pinnedAt = pinned ? new Date().toISOString() : null
  if (!pinned) delete task.pinOrder
  save(store)
}

/** Rank pinned tasks by dragging: ids in the order you want them, top first. Unknown or unpinned ids are ignored. */
export function reorderPinned(ids: string[]): void {
  const store = load()
  let rank = 0
  for (const id of ids) {
    const task = store.tasks.find((t) => t.id === id && t.pinned)
    if (task) task.pinOrder = rank++
  }
  save(store)
}

/**
 * A pin lasts until the task is completed or unpinned. Once completed, it stays in the box
 * (struck through) for the rest of that work day, then falls off so finished work doesn't linger.
 */
function expirePins(store: StoreFile): void {
  const cfg = dayConfig(store)
  const today = currentWorkDay(cfg)
  for (const t of store.tasks) {
    if (!t.pinned) continue
    const finished = t.state === 'done' || t.state === 'dismissed' || t.state === 'archived'
    if (finished && workDayOf(t.updatedAt, cfg) < today) {
      t.pinned = false
      t.pinnedAt = null
    }
  }
}

/** Instant local task creation (quick-add) — no LLM involved, text is sticky. */
export function addTask(
  text: string,
  opts: { sourceNote?: string; track?: Track; deadline?: string | null; priority?: Priority } = {}
): string | null {
  const trimmed = text.trim().slice(0, 500)
  if (!trimmed) return null
  const store = load()
  const now = new Date().toISOString()
  const id = randomUUID()
  store.tasks.push({
    id,
    text: trimmed,
    track: opts.track ?? 'other',
    // Typing a task by hand means it matters now; extracted tasks get their priority from the LLM.
    priority: opts.priority ?? 'high',
    deadline: opts.deadline ?? null,
    sourceNote: opts.sourceNote ?? 'quick add',
    state: 'open',
    snoozedUntil: null,
    editedByUser: true,
    horizon: 'now',
    createdAt: now,
    updatedAt: now
  })
  save(store)
  return id
}

/**
 * Delete a task outright. Only for tasks the app itself created (a job promoted to the board, a
 * School deadline), and only while still untouched: once the user has completed, snoozed, or
 * renamed it, keep it.
 */
export function removeTask(id: string, opts: { sourceText?: string } = {}): boolean {
  const store = load()
  const idx = store.tasks.findIndex((t) => t.id === id)
  if (idx === -1) return false
  const t = store.tasks[idx]
  if (!APP_SOURCES.has(t.sourceNote) || t.state !== 'open' || t.snoozedUntil) return false
  // "Untouched" is normally createdAt === updatedAt. Mirrored tasks written before syncTaskFromSource
  // existed had updatedAt bumped by the mirror itself; if the text is still exactly what the source
  // would write, nobody renamed it, so it is fair game.
  const untouched = t.updatedAt === t.createdAt || (opts.sourceText !== undefined && t.text === opts.sourceText)
  if (!untouched) return false
  store.tasks.splice(idx, 1)
  save(store)
  return true
}

/** sourceNote values that mean "created by the app, not extracted from a note". */
export const APP_SOURCES = new Set(['jobs', 'school'])

/** Read one task without the renderer projection; used by School to mirror done-state back. */
export function getTask(id: string): Task | null {
  return load().tasks.find((t) => t.id === id) ?? null
}

/** Every stored task, one file read. For callers that need to look up many ids at once. */
export function listTasks(): Task[] {
  return load().tasks
}

/**
 * Move a deadline (and keep the task's own fields). Used when a Canvas due date changes; the
 * task keeps whatever the user did to it otherwise.
 */
export function setTaskDeadline(id: string, deadline: string | null): void {
  const store = load()
  const t = store.tasks.find((x) => x.id === id)
  if (!t || t.deadline === deadline) return
  t.deadline = deadline
  t.updatedAt = new Date().toISOString()
  save(store)
}

/**
 * The School mirror keeping a task in step with its source (new due date, renamed assignment).
 * Deliberately leaves `updatedAt` and `editedByUser` alone: both mean "the user did something",
 * and the mirror's own upkeep must not make a task look hand-edited, or it can never be cleaned
 * up again when the deadline leaves the window.
 */
export function syncTaskFromSource(id: string, fields: { text?: string; deadline?: string | null; sourceNote?: string }): void {
  const store = load()
  const t = store.tasks.find((x) => x.id === id)
  if (!t) return
  let changed = false
  const text = fields.text?.trim().slice(0, 500)
  if (text && t.text !== text) {
    t.text = text
    changed = true
  }
  if (fields.deadline !== undefined && t.deadline !== fields.deadline) {
    t.deadline = fields.deadline
    changed = true
  }
  // Reclaim a mirrored task that an older build's Notes reconcile relabelled as coming from a
  // note; left alone, that pass would later mark it done when the "note line" disappears.
  if (fields.sourceNote !== undefined && t.sourceNote !== fields.sourceNote) {
    t.sourceNote = fields.sourceNote
    t.sourceExcerpt = undefined
    t.sourceVerifiedAt = undefined
    changed = true
  }
  if (changed) save(store)
}

/**
 * Open tasks due by tomorrow (incl. overdue) not yet notified today.
 * Marks them notified as a side effect — callers should notify or drop the result.
 */
export function takeDueForNotification(): Task[] {
  const store = load()
  sweep(store)
  const today = localDay()
  const tomorrow = localDayOffset(1)
  const due = store.tasks.filter(
    (t) =>
      t.state === 'open' && t.deadline && t.deadline <= tomorrow && store.notified?.[t.id] !== today
  )
  if (due.length > 0) {
    const alive = new Set(store.tasks.map((t) => t.id))
    const next: Record<string, string> = {}
    // Rebuild the map so entries for deleted tasks don't accumulate.
    for (const [id, day] of Object.entries(store.notified ?? {})) {
      if (alive.has(id)) next[id] = day
    }
    for (const t of due) next[t.id] = today
    store.notified = next
    save(store)
  }
  return due
}

/** Remove one item from the What-changed list and keep it suppressed for the rest of the work day. */
export function dismissTodayItem(value: string): void {
  const store = load()
  if (!store.today) return
  const idx = store.today.changes.indexOf(value)
  if (idx === -1) return
  store.today.changes.splice(idx, 1)
  const today = currentWorkDay(dayConfig(store))
  if (!store.dismissedToday || store.dismissedToday.date !== today) {
    store.dismissedToday = { date: today, texts: [] }
  }
  store.dismissedToday.texts.push(value)
  save(store)
}

/** Case-insensitive filter of strip items against this work day's dismissals. */
function filterDismissedToday(items: string[], store: StoreFile): string[] {
  const today = currentWorkDay(dayConfig(store))
  if (!store.dismissedToday || store.dismissedToday.date !== today) return items
  const dismissed = new Set(store.dismissedToday.texts.map((t) => t.toLowerCase().trim()))
  return items.filter((item) => !dismissed.has(item.toLowerCase().trim()))
}

/** Close the current work day now: done tasks roll off, recurring tasks reopen, pulse resets. */
export function endDay(): void {
  const store = load()
  sweep(store)
  const now = new Date().toISOString()
  store.dayClosed = { day: currentWorkDay(dayConfig(store)), at: now, reopened: [] }
  store.dayClosed.reopened = resetRecurring(store, now)
  // Ending the day retires finished pins; open pins carry over — they're still not done.
  for (const t of store.tasks) {
    if (t.pinned && t.state !== 'open' && t.state !== 'snoozed') {
      t.pinned = false
      t.pinnedAt = null
    }
  }
  save(store)
}

/** Undo End-day, restoring any recurring tasks the close had reopened. */
export function reopenDay(): void {
  const store = load()
  const closed = store.dayClosed
  if (!closed) return
  for (const { id, updatedAt } of closed.reopened ?? []) {
    const task = store.tasks.find((t) => t.id === id)
    // Only revert if untouched since — the user may have legitimately re-done it.
    if (task && task.state === 'open' && task.updatedAt === closed.at) {
      task.state = 'done'
      task.updatedAt = updatedAt
    }
  }
  store.dayClosed = null
  save(store)
}

function defaultSnooze(): string {
  // Tomorrow, 9:00 local time.
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d.toISOString()
}

/**
 * Apply an LLM merge response. Contract:
 * - returned task with existing id → update fields (user state untouched)
 * - returned task with null id → create new open task
 * - removedIds → archive
 * - tasks omitted from the response → unchanged (guards against truncation)
 * User state always wins: done/dismissed tasks are never reopened or edited.
 */
export function applyMerge(response: MergeResponse, options: { updateToday?: boolean } = {}): AppState {
  const { updateToday = true } = options
  const store = load()
  sweep(store)
  const now = new Date().toISOString()
  const byId = new Map(store.tasks.map((t) => [t.id, t]))
  // Fuzzy backstop for the prompt's suppression rule: the LLM sometimes re-mines
  // a dismissed task's note line into a reworded variant. Block anything whose
  // wording substantially overlaps a dismissed task.
  const dismissedTokens = store.tasks
    .filter((t) => t.state === 'dismissed')
    .map((t) => tokenize(t.text))

  for (const item of response.tasks ?? []) {
    if (!item?.text?.trim()) continue
    const normalized = {
      text: item.text.trim(),
      track: normalizeTrack(item.track),
      priority: normalizePriority(item.priority),
      deadline: item.deadline || null,
      sourceNote: item.sourceNote || 'unknown'
    }
    const excerpt =
      typeof item.sourceExcerpt === 'string' ? item.sourceExcerpt.trim().slice(0, 500) : ''
    const existing = item.id ? byId.get(item.id) : undefined
    // An id we don't know is not a new task: the model is updating something that was removed while
    // its call was in flight (the School mirror retired "STAT 390: Week 4 Lab Quiz" the moment Canvas
    // published the real quiz; the model, mid-call, bumped its priority and it came back as a twin).
    // Only a null id means "create".
    if (item.id && !existing) continue
    if (existing) {
      if (existing.state === 'done' || existing.state === 'dismissed') continue
      // Anything the user set by hand is pinned — the LLM never overrides it.
      if (!existing.editedByUser) existing.text = normalized.text
      if (!existing.trackPinned) existing.track = normalized.track
      if (!existing.priorityPinned) existing.priority = normalized.priority
      if (!existing.horizonPinned && item.horizon) existing.horizon = normalizeHorizon(item.horizon)
      existing.deadline = normalized.deadline
      // Provenance is fixed at creation. The model used to re-home existing tasks — including ones
      // typed into briefly — onto whichever note it guessed, and the Notes reconciler then treated
      // that guess as the task's source line (and completed the task when the unrelated line changed).
      // Only fill a missing excerpt, and only when the model agrees on the note it belongs to.
      if (excerpt && !existing.sourceExcerpt && existing.sourceNote === normalized.sourceNote) {
        existing.sourceExcerpt = excerpt
      }
      existing.updatedAt = now
    } else {
      // Guard against the model "recreating" something it was told about.
      const duplicate = store.tasks.some(
        (t) => t.text.toLowerCase() === normalized.text.toLowerCase() && t.state !== 'archived'
      )
      if (duplicate) continue
      const tokens = tokenize(normalized.text)
      if (dismissedTokens.some((d) => similarText(d, tokens))) continue
      store.tasks.push({
        id: randomUUID(),
        ...normalized,
        state: 'open',
        snoozedUntil: null,
        horizon: normalizeHorizon(item.horizon),
        recurrence: item.recurring === true ? 'daily' : null,
        ...(excerpt ? { sourceExcerpt: excerpt } : {}),
        createdAt: now,
        updatedAt: now
      })
    }
  }

  for (const id of response.removedIds ?? []) {
    const task = byId.get(id)
    // Edited tasks no longer match the notes verbatim, and recurring tasks are a
    // standing commitment — never let the LLM archive either.
    if (
      task &&
      !task.editedByUser &&
      !task.recurrence &&
      (task.state === 'open' || task.state === 'snoozed')
    ) {
      task.state = 'archived'
      task.updatedAt = now
    }
  }

  if (updateToday) {
    store.today = {
      changes: filterDismissedToday((response.today?.changes ?? []).slice(0, 5), store),
      generatedAt: now
    }
    store.lastRefreshed = now
  }
  save(store)
  return toState(store, true)
}

// ---------------------------------------------------------------------------
// Provenance reconcile: detect tasks whose source line (or whole note) the user
// deleted in Apple Notes, and complete them. Pure code — the LLM is bad at
// reasoning from absence, and deleted notes vanish from its view entirely.
// ---------------------------------------------------------------------------

const LINE_PREFIX = /^(?:[\s\-•*·▪◦☐☑✓✔]+|\[[ xX]\]\s*)+/

function normalizeLine(s: string): string {
  return s.replace(LINE_PREFIX, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

interface PreparedLine {
  raw: string
  norm: string
  tokens: Set<string>
}

const preparedCache = new WeakMap<Note, PreparedLine[]>()

function prepare(note: Note): PreparedLine[] {
  let lines = preparedCache.get(note)
  if (!lines) {
    lines = []
    for (const raw of note.body.split('\n')) {
      const norm = normalizeLine(raw)
      if (norm) lines.push({ raw: raw.trim(), norm, tokens: tokenize(norm) })
    }
    preparedCache.set(note, lines)
  }
  return lines
}

/**
 * Find the line a task came from: exact excerpt first, then ≥50% token overlap
 * with the excerpt or the task text. Errs toward "present" — a false match only
 * means we don't auto-complete, never that we wrongly do.
 */
function findLine(task: Task, note: Note): { line: PreparedLine; exact: boolean } | null {
  const lines = prepare(note)
  const excerpt = task.sourceExcerpt ? normalizeLine(task.sourceExcerpt) : ''
  if (excerpt) {
    const exact = lines.find(
      (l) => l.norm === excerpt || l.norm.includes(excerpt) || (l.norm.length >= 8 && excerpt.includes(l.norm))
    )
    if (exact) return { line: exact, exact: true }
  }
  const targets = [excerpt, normalizeLine(task.text)]
    .filter(Boolean)
    .map(tokenize)
    .filter((t) => t.size > 0)
  if (targets.length === 0) return null
  const fuzzy = lines.find((l) => targets.some((t) => similarText(t, l.tokens)))
  return fuzzy ? { line: fuzzy, exact: false } : null
}

function locate(task: Task, notes: Note[]): { note: Note; line: PreparedLine; exact: boolean } | null {
  for (const note of notes) {
    const found = findLine(task, note)
    if (found) return { note, ...found }
  }
  return null
}

/**
 * After a scan: verify each open task's source line still exists; complete tasks
 * whose line/note is gone. Only tasks that were verified at least once are
 * eligible — a garbled title or excerpt can never cause a phantom completion.
 * Renamed notes and moved lines re-point the task instead of completing it.
 */
export function reconcileWithNotes(notes: Note[]): AppState {
  const store = load()
  sweep(store)
  const now = new Date().toISOString()
  const byTitle = new Map<string, Note[]>()
  for (const n of notes) byTitle.set(n.title, [...(byTitle.get(n.title) ?? []), n])
  const completed: Task[] = []

  // The Notes read skips any folder that errors mid-scan, so a hiccup can hand us a partial
  // library. A sudden drop in note count is that signature: re-verify what we can, but do
  // not complete anything this pass. The baseline still advances so real deletions are
  // honored on the next pass.
  const prevCount = store.notesCountAtReconcile ?? null
  const partialRead = notes.length === 0 || (prevCount !== null && notes.length < prevCount * 0.75)
  if (partialRead) {
    console.warn(`[reconcile] notes count ${notes.length} vs baseline ${prevCount}; skipping completions`)
  }
  store.notesCountAtReconcile = notes.length

  for (const task of store.tasks) {
    if (task.state !== 'open' && task.state !== 'snoozed') continue
    if (task.recurrence === 'daily') continue
    if (!task.sourceNote || task.sourceNote === 'quick add' || task.sourceNote === 'unknown') continue
    if (APP_SOURCES.has(task.sourceNote)) continue
    // Once the user has retitled a task, briefly owns it: its wording no longer mirrors any note
    // line, so a line vanishing says nothing about whether the task is done. Only the user closes it.
    if (task.editedByUser) continue

    const sources = byTitle.get(task.sourceNote) ?? []
    const found =
      locate(task, sources) ?? locate(task, notes.filter((n) => !sources.includes(n)))

    if (found?.exact) {
      // The remembered line still exists (possibly in a renamed note): re-point and re-verify.
      task.sourceNote = found.note.title
      task.sourceExcerpt = found.line.raw.slice(0, 500)
      task.sourceVerifiedAt = now
    } else if (found) {
      // Fuzzy word overlap is enough to say "still around, don't complete" — not enough to adopt
      // that line as the task's source. Adopting fuzzy hits is how tasks drifted onto unrelated notes.
    } else if (task.sourceVerifiedAt && !partialRead) {
      task.state = 'done'
      task.completedVia = 'notes'
      task.updatedAt = now
      completed.push(task)
    }
    // Never verified and not found: inert. Nothing to conclude from.
  }

  if (completed.length > 0 && store.today) {
    const entries = completed.map((t) => `Done via Notes: ${t.text}`)
    store.today.changes = [...entries, ...store.today.changes].slice(0, 5)
  }

  save(store)
  return toState(store, true)
}
