import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  JobItem,
  JobRow,
  JobSnapshot,
  JobStatus,
  JobUserState,
  JobsView
} from '../../shared/jobs'
import { JOB_STATUSES } from '../../shared/jobs'
import { canonicalId } from './normalize'
import { profileDir, profileFiles, profileVersion, readWatchlist } from './profile'

const STORE_VERSION = 2
const PRUNE_INACTIVE_DAYS = 60
/** A posting no feed has listed for this long is treated as closed. */
const UNSEEN_INACTIVE_DAYS = 21

export interface SourceCursor {
  lastRun: string | null
  lastError: string | null
}

interface StoreFile {
  version: number
  profileVersion: string | null
  lastScanAt: string | null
  lastErrors: string[]
  sources: Record<string, SourceCursor>
  items: JobItem[]
  state: Record<string, JobUserState>
  events: unknown[]
}

function empty(): StoreFile {
  return {
    version: STORE_VERSION,
    profileVersion: null,
    lastScanAt: null,
    lastErrors: [],
    sources: {},
    items: [],
    state: {},
    events: []
  }
}

function storePath(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'jobs.json')
}

export function load(): StoreFile {
  const path = storePath()
  if (!existsSync(path)) return empty()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreFile>
    if (typeof raw.version === 'number' && raw.version > STORE_VERSION) {
      // Newer than this build understands: keep what we can read, never rewrite it.
      console.warn(`[jobs] store version ${raw.version} > ${STORE_VERSION}; running read-only`)
    }
    const store: StoreFile = {
      ...empty(),
      ...raw,
      items: Array.isArray(raw.items) ? raw.items : [],
      lastErrors: Array.isArray(raw.lastErrors) ? raw.lastErrors : [],
      state: raw.state && typeof raw.state === 'object' ? raw.state : {},
      sources: raw.sources && typeof raw.sources === 'object' ? raw.sources : {},
      events: Array.isArray(raw.events) ? raw.events : []
    }
    if ((raw.version ?? 1) < 2) {
      migrateIdsV2(store)
      store.version = STORE_VERSION
      save(store)
    }
    return store
  } catch {
    return empty()
  }
}

/**
 * v1 keyed Greenhouse/Lever/Ashby ids by board slug, so the board URL and the company-site
 * embed of one posting were two rows. v2 keys by the ATS's global job id. Recompute every id
 * from its URL, fold rows that now collide, and carry user state across.
 */
function migrateIdsV2(store: StoreFile): void {
  const merged = new Map<string, JobItem>()
  const idMap = new Map<string, string>()
  for (const it of store.items) {
    const { id, sourceRef } = canonicalId(it.url)
    idMap.set(it.id, id)
    const cur = merged.get(id)
    if (!cur) {
      merged.set(id, { ...it, id, sourceRef: sourceRef ?? it.sourceRef })
      continue
    }
    if (cur.source !== it.source && !cur.alsoSeenIn.includes(it.source)) cur.alsoSeenIn.push(it.source)
    cur.verdict = cur.verdict ?? it.verdict
    cur.scoredWithProfileVersion = cur.scoredWithProfileVersion ?? it.scoredWithProfileVersion
    cur.descriptionAvailable = cur.descriptionAvailable || it.descriptionAvailable
    cur.pay = cur.pay ?? it.pay
    cur.deadline = cur.deadline ?? it.deadline
    cur.location = cur.location ?? it.location
    cur.dcLink = cur.dcLink || it.dcLink
    cur.referralNote = cur.referralNote ?? it.referralNote
    cur.active = cur.active || it.active
    if ((it.lastSeenAt ?? '') > (cur.lastSeenAt ?? '')) cur.lastSeenAt = it.lastSeenAt
  }
  store.items = [...merged.values()]
  const state: Record<string, JobUserState> = {}
  for (const [oldId, st] of Object.entries(store.state)) {
    const newId = idMap.get(oldId) ?? (st.snapshot?.url ? canonicalId(st.snapshot.url).id : oldId)
    // Two old rows folding into one: keep whichever the user touched most recently.
    if (!state[newId] || st.updatedAt > state[newId].updatedAt) state[newId] = st
  }
  store.state = state
}

export function save(store: StoreFile): void {
  const path = storePath()
  writeFileSync(path + '.tmp', JSON.stringify(store, null, 2))
  renameSync(path + '.tmp', path)
}

function snapshotOf(item: JobItem): JobSnapshot {
  return {
    company: item.company,
    title: item.title,
    url: item.url,
    term: item.term,
    source: item.source
  }
}

/** Drop items inactive for a long time. Safe: acted-on items live on via their snapshot. */
function prune(store: StoreFile): void {
  const cutoff = Date.now() - PRUNE_INACTIVE_DAYS * 86_400_000
  store.items = store.items.filter((it) => {
    if (it.active) return true
    return new Date(it.lastSeenAt ?? it.seenAt).getTime() > cutoff
  })
}

/** Feeds only list open postings, so "not seen for a while" is the closed signal. */
function expireUnseen(store: StoreFile): void {
  const cutoff = Date.now() - UNSEEN_INACTIVE_DAYS * 86_400_000
  for (const it of store.items) {
    if (it.active && new Date(it.lastSeenAt ?? it.seenAt).getTime() < cutoff) it.active = false
  }
}

export function getView(): JobsView {
  const store = load()
  const byId = new Map(store.items.map((it) => [it.id, it]))
  const rows: JobRow[] = []
  const seen = new Set<string>()
  for (const item of store.items) {
    rows.push({ id: item.id, item, state: store.state[item.id] ?? null })
    seen.add(item.id)
  }
  // Acted-on items that were pruned still render from their snapshot.
  for (const [id, state] of Object.entries(store.state)) {
    if (!seen.has(id) && state.status !== 'new' && state.snapshot) {
      rows.push({ id, item: byId.get(id) ?? null, state })
    }
  }
  return {
    rows,
    profileDir: profileDir(),
    profile: profileFiles(),
    lastScanAt: store.lastScanAt,
    lastErrors: store.lastErrors,
    unscored: getUnscoredCount(profileVersion()),
    sources: store.sources,
    watchlist: readWatchlist().map((w) => w.company)
  }
}

function touch(store: StoreFile, id: string): JobUserState | null {
  const item = store.items.find((it) => it.id === id)
  const existing = store.state[id]
  if (!existing && !item) return null
  const state: JobUserState = existing ?? {
    status: 'new',
    note: '',
    promotedTaskId: null,
    openedInAsideAt: null,
    snapshot: snapshotOf(item as JobItem),
    updatedAt: new Date().toISOString()
  }
  // Refresh the snapshot while the live item still exists so it tracks title edits.
  if (item) state.snapshot = snapshotOf(item)
  state.updatedAt = new Date().toISOString()
  store.state[id] = state
  return state
}

/** User state always wins: this is the only place status changes. */
export function setStatus(id: string, status: JobStatus): void {
  if (!JOB_STATUSES.includes(status)) return
  const store = load()
  const state = touch(store, id)
  if (!state) return
  state.status = status
  if (status === 'applying') state.openedInAsideAt = new Date().toISOString()
  save(store)
}

export function setNote(id: string, note: string): void {
  const store = load()
  const state = touch(store, id)
  if (!state) return
  state.note = note.slice(0, 2000)
  save(store)
}

export function setPromotedTask(id: string, taskId: string | null): void {
  const store = load()
  const state = touch(store, id)
  if (!state) return
  state.promotedTaskId = taskId
  save(store)
}

/** Untouched postings that are plainly outside the US: retire them so they stop costing tokens and attention. */
export function retireNonUS(isNonUS: (location: string | null) => boolean): number {
  const store = load()
  let n = 0
  for (const it of store.items) {
    if (it.active && !store.state[it.id] && isNonUS(it.location)) {
      it.active = false
      n++
    }
  }
  if (n > 0) save(store)
  return n
}

export function getItem(id: string): JobItem | undefined {
  return load().items.find((it) => it.id === id)
}

export function getUserState(id: string): JobUserState | undefined {
  return load().state[id]
}

/**
 * Merge freshly fetched items into the store. Items are matched by id; fields merge
 * first-non-null except `pay` (speedyapply wins) and `dcLink`/`referralNote` (instagram wins).
 * Returns the ids that are new to the store so the caller can score and notify.
 */
export function upsertItems(incoming: JobItem[]): { added: string[]; changed: string[] } {
  const store = load()
  const byId = new Map(store.items.map((it) => [it.id, it]))
  const added: string[] = []
  const changed: string[] = []
  const now = new Date().toISOString()
  for (const inc of incoming) {
    const cur = byId.get(inc.id)
    if (!cur) {
      inc.lastSeenAt = now
      store.items.push(inc)
      byId.set(inc.id, inc)
      added.push(inc.id)
      continue
    }
    cur.lastSeenAt = now
    if (cur.source !== inc.source && !cur.alsoSeenIn.includes(inc.source)) {
      cur.alsoSeenIn.push(inc.source)
    }
    const before = JSON.stringify([cur.title, cur.url, cur.deadline, cur.pay, cur.descriptionAvailable])
    cur.company = cur.company || inc.company
    cur.title = cur.title || inc.title
    cur.url = cur.url || inc.url
    cur.postedAt = cur.postedAt ?? inc.postedAt
    cur.deadline = cur.deadline ?? inc.deadline
    cur.location = cur.location ?? inc.location
    if (inc.source === 'speedyapply' && inc.pay) cur.pay = inc.pay
    else cur.pay = cur.pay ?? inc.pay
    if (inc.source === 'instagram') {
      cur.dcLink = cur.dcLink || inc.dcLink
      cur.referralNote = inc.referralNote ?? cur.referralNote
    }
    if (cur.term === 'unknown' && inc.term !== 'unknown') cur.term = inc.term
    if (!cur.descriptionAvailable && inc.descriptionAvailable) cur.descriptionAvailable = true
    // Feeds only carry open postings, so being listed again means it's still active.
    cur.active = true
    cur.seenAt = cur.seenAt || inc.seenAt
    const after = JSON.stringify([cur.title, cur.url, cur.deadline, cur.pay, cur.descriptionAvailable])
    if (before !== after) changed.push(cur.id)
  }
  expireUnseen(store)
  prune(store)
  save(store)
  return { added, changed }
}

/** Unscored postings older than this are not worth LLM budget — they're the initial backfill, not inflow. */
const SCORE_MAX_AGE_DAYS = 10

function scoreEligible(it: JobItem, profileVersion: string, now = Date.now()): boolean {
  if (!it.active) return false
  if (it.verdict && it.scoredWithProfileVersion === profileVersion) return false
  // Already scored under an older profile: always worth re-scoring. Never scored: only if recent.
  if (it.verdict) return true
  return now - new Date(it.postedAt ?? it.seenAt).getTime() <= SCORE_MAX_AGE_DAYS * 86_400_000
}

/** Items that still need a verdict for the current profile version. Watchlist companies first, then newest. */
export function itemsNeedingScore(profileVersion: string, limit: number, priorityCompanies: string[] = []): JobItem[] {
  const store = load()
  const prio = new Set(priorityCompanies.map((c) => c.toLowerCase()))
  const rank = (it: JobItem): number => (it.source === 'ats' || prio.has(it.company.toLowerCase()) ? 0 : it.pay ? 1 : 2)
  return store.items
    .filter((it) => scoreEligible(it, profileVersion))
    .sort((a, b) => rank(a) - rank(b) || (b.postedAt ?? b.seenAt).localeCompare(a.postedAt ?? a.seenAt))
    .slice(0, limit)
}

/** How many active items are still waiting for a verdict. */
export function getUnscoredCount(profileVersion: string): number {
  return load().items.filter((it) => scoreEligible(it, profileVersion)).length
}

export function setVerdict(
  id: string,
  verdict: JobItem['verdict'],
  profileVersion: string,
  facts: { descriptionAvailable?: boolean; location?: string | null; postedAt?: string | null } = {}
): void {
  const store = load()
  const item = store.items.find((it) => it.id === id)
  if (!item) return
  item.verdict = verdict
  item.scoredWithProfileVersion = profileVersion
  if (facts.descriptionAvailable !== undefined) item.descriptionAvailable = facts.descriptionAvailable
  item.location = item.location ?? facts.location ?? null
  item.postedAt = item.postedAt ?? facts.postedAt ?? null
  save(store)
}

export function setSourceCursor(name: string, cursor: SourceCursor): void {
  const store = load()
  store.sources[name] = cursor
  save(store)
}

export function getSourceCursor(name: string): SourceCursor {
  return load().sources[name] ?? { lastRun: null, lastError: null }
}

export function markScan(profileVersion: string, errors: string[] = []): void {
  const store = load()
  store.lastScanAt = new Date().toISOString()
  store.profileVersion = profileVersion
  store.lastErrors = errors.slice(0, 10)
  save(store)
}

/** Count of postings in the New section, for the optional menu bar badge. */
export function getNewCount(): number {
  const store = load()
  return store.items.filter((it) => {
    const st = store.state[it.id]
    const isNew = !st || st.status === 'new'
    return it.active && isNew && it.verdict && it.verdict.decision !== 'skip'
  }).length
}

/** Dev-only: replace items with a fixture set so the tab can be built before sources exist. */
export function loadFixture(items: JobItem[]): void {
  const store = load()
  store.items = items
  save(store)
}
