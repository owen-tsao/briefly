import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppState, Horizon, Priority, Task, TaskState, TodayStrip, Track } from '../shared/types'
import { HORIZONS, TRACKS } from '../shared/types'
import { localDay, localDayOffset } from '../shared/dates'

interface StoreFile {
  tasks: Task[]
  today: TodayStrip | null
  lastRefreshed: string | null
  /** Today-strip items the user dismissed; suppressed from regenerated strips on the same day. */
  dismissedToday?: { date: string; texts: string[] }
  /** taskId → local day it was last included in a deadline notification. */
  notified?: Record<string, string>
}

export interface LlmTask {
  id: string | null
  text: string
  track: string
  priority: string
  deadline: string | null
  sourceNote: string
  horizon?: string
  recurring?: boolean
}

export interface MergeResponse {
  tasks: LlmTask[]
  removedIds: string[]
  today: { priorities: string[]; changes: string[] }
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
    // Migrate pre-task-linked strips (freeform "priorities" prose): keep changes, regenerate on next scan.
    if (store.today && !Array.isArray(store.today.priorityIds)) {
      store.today = {
        priorityIds: [],
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

/** Reopen daily-recurring tasks completed on a previous (local) day. */
function resetRecurring(store: StoreFile): void {
  const today = localDay()
  for (const task of store.tasks) {
    if (task.recurrence === 'daily' && task.state === 'done' && localDay(task.updatedAt) < today) {
      task.state = 'open'
      task.updatedAt = new Date().toISOString()
    }
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
  wakeSnoozed(store)
  resetRecurring(store)
  pruneOld(store)
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
  return { tasks: store.tasks, today: store.today, lastRefreshed: store.lastRefreshed, hasApiKey }
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
  return load().tasks.filter((t) => t.state === 'open').length
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

/** Instant local task creation (quick-add) — no LLM involved, text is sticky. */
export function addTask(text: string): void {
  const trimmed = text.trim().slice(0, 500)
  if (!trimmed) return
  const store = load()
  const now = new Date().toISOString()
  store.tasks.push({
    id: randomUUID(),
    text: trimmed,
    track: 'other',
    priority: 'medium',
    deadline: null,
    sourceNote: 'quick add',
    state: 'open',
    snoozedUntil: null,
    editedByUser: true,
    horizon: 'now',
    createdAt: now,
    updatedAt: now
  })
  save(store)
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

/** Remove one item from the Today strip and keep it suppressed for the rest of the day. */
export function dismissTodayItem(section: 'priorities' | 'changes', value: string): void {
  const store = load()
  if (!store.today) return
  const items = section === 'priorities' ? store.today.priorityIds : store.today.changes
  const idx = items.indexOf(value)
  if (idx === -1) return
  items.splice(idx, 1)
  const today = localDay()
  if (!store.dismissedToday || store.dismissedToday.date !== today) {
    store.dismissedToday = { date: today, texts: [] }
  }
  store.dismissedToday.texts.push(value)
  save(store)
}

/** Case-insensitive filter of strip items against today's dismissals. */
function filterDismissedToday(items: string[], store: StoreFile): string[] {
  const today = localDay()
  if (!store.dismissedToday || store.dismissedToday.date !== today) return items
  const dismissed = new Set(store.dismissedToday.texts.map((t) => t.toLowerCase().trim()))
  return items.filter((item) => !dismissed.has(item.toLowerCase().trim()))
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
    const existing = item.id ? byId.get(item.id) : undefined
    if (existing) {
      if (existing.state === 'done' || existing.state === 'dismissed') continue
      // Sticky manual edits: the user's wording always wins over the LLM's.
      const { text: _text, ...withoutText } = normalized
      Object.assign(existing, existing.editedByUser ? withoutText : normalized, { updatedAt: now })
      // Horizon follows the notes unless the user pinned it. Recurrence is user-owned after creation.
      if (!existing.horizonPinned && item.horizon) existing.horizon = normalizeHorizon(item.horizon)
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
    // Resolve the LLM's task references (existing id or exact text of a new task) to real ids.
    const idsNow = new Map(store.tasks.map((t) => [t.id, t]))
    const byText = new Map(
      store.tasks
        .filter((t) => t.state === 'open' || t.state === 'snoozed')
        .map((t) => [t.text.toLowerCase(), t])
    )
    const priorityIds: string[] = []
    for (const entry of response.today?.priorities ?? []) {
      if (typeof entry !== 'string') continue
      const task = idsNow.get(entry) ?? byText.get(entry.toLowerCase().trim())
      if (
        task &&
        (task.state === 'open' || task.state === 'snoozed') &&
        !priorityIds.includes(task.id)
      ) {
        priorityIds.push(task.id)
      }
    }
    store.today = {
      priorityIds: filterDismissedToday(priorityIds, store).slice(0, 5),
      changes: filterDismissedToday((response.today?.changes ?? []).slice(0, 5), store),
      generatedAt: now
    }
    store.lastRefreshed = now
  }
  save(store)
  return { tasks: store.tasks, today: store.today, lastRefreshed: store.lastRefreshed, hasApiKey: true }
}
