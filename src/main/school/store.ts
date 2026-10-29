import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SchoolCourse, SchoolItem, SchoolRule } from '../../shared/school'
import { courseKey } from '../../shared/school'

/**
 * school.json: items (every deadline ever seen, so vanished feed entries stay), rules, courses,
 * and poll bookkeeping. Same atomic-write + .bak discipline as jobs.json.
 */

export interface SchoolStore {
  version: 1
  items: SchoolItem[]
  rules: SchoolRule[]
  courses: SchoolCourse[]
  lastPollAt: string | null
  lastPollError: string | null
  lastPollNew: number
  lastDigestAt: string | null
  /** Items the user has explicitly deleted; their ids are refused if the feed re-sends them. */
  deletedIds: string[]
  feedEtag: string | null
  /** Reminder keys already fired (`<itemId>:1h`, `morning:<day>`), with when; pruned after two days. */
  reminders?: Record<string, string>
}

function empty(): SchoolStore {
  return {
    version: 1,
    items: [],
    rules: [],
    courses: [],
    lastPollAt: null,
    lastPollError: null,
    lastPollNew: 0,
    lastDigestAt: null,
    deletedIds: [],
    feedEtag: null,
    reminders: {}
  }
}

function storePath(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'school.json')
}

export function load(): SchoolStore {
  const path = storePath()
  if (!existsSync(path)) return empty()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SchoolStore>
    const base = empty()
    const store: SchoolStore = {
      ...base,
      ...raw,
      version: 1,
      items: Array.isArray(raw.items) ? raw.items : [],
      rules: Array.isArray(raw.rules) ? raw.rules : [],
      courses: Array.isArray(raw.courses) ? raw.courses : [],
      deletedIds: Array.isArray(raw.deletedIds) ? raw.deletedIds.filter((x): x is string => typeof x === 'string') : []
    }
    normaliseCourses(store)
    return store
  } catch (err) {
    console.warn('[school] store unreadable; starting from backup or empty', err)
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`)
      if (existsSync(path + '.bak')) {
        copyFileSync(path + '.bak', path)
        return load()
      }
    } catch {
      /* fall through */
    }
    return empty()
  }
}

export function save(store: SchoolStore): void {
  const path = storePath()
  writeFileSync(path + '.tmp', JSON.stringify(store, null, 2))
  if (existsSync(path)) copyFileSync(path, path + '.bak')
  renameSync(path + '.tmp', path)
}

/**
 * Course keys are derived from Canvas titles, and the derivation can improve between versions
 * (e.g. learning to drop "- AU26"). Re-key everything on load and merge courses that collapse to
 * the same key, so old data never shows up as a second course.
 */
function normaliseCourses(store: SchoolStore): void {
  for (const i of store.items) i.course = courseKey(i.course)
  for (const r of store.rules) r.course = courseKey(r.course)
  const merged = new Map<string, SchoolCourse>()
  for (const c of store.courses) {
    const key = courseKey(c.course)
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, { ...c, course: key, name: c.name === c.course ? key : c.name })
      continue
    }
    prev.canvasId = prev.canvasId ?? c.canvasId
    prev.hidden = prev.hidden && c.hidden
    prev.hideEvents = prev.hideEvents && c.hideEvents
    if ((c.lastNewItemAt ?? '') > (prev.lastNewItemAt ?? '')) prev.lastNewItemAt = c.lastNewItemAt
    if (prev.name === key && c.name !== c.course) prev.name = c.name
  }
  store.courses = [...merged.values()]
}

export function ensureCourse(store: SchoolStore, course: string, canvasId: string | null = null): SchoolCourse {
  let c = store.courses.find((x) => x.course === course)
  if (!c) {
    c = { course, name: course, canvasId, hidden: false, lastNewItemAt: null, hideEvents: true }
    store.courses.push(c)
  } else if (canvasId && !c.canvasId) {
    c.canvasId = canvasId
  }
  return c
}

export function newId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
