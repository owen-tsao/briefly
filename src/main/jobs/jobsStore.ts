import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  JobItem,
  JobRow,
  JobSnapshot,
  JobStatus,
  JobUserState,
  JobVerdict,
  JobsView,
  PreparedInfo
} from '../../shared/jobs'
import { isPasted, JOB_STATUSES, OUTCOME_STATUSES } from '../../shared/jobs'
import type { ApplySignals } from '../../shared/applyNow'
import { canonicalId } from './normalize'
import { profileDir, profileFiles, profileVersion, readRules, readWatchlist } from './profile'

const STORE_VERSION = 2
const PRUNE_INACTIVE_DAYS = 60
/** A posting no feed has listed for this long is treated as closed. */
const UNSEEN_INACTIVE_DAYS = 21

export interface SourceCursor {
  lastRun: string | null
  lastError: string | null
  /** ETag from the last successful full fetch; sent back as If-None-Match so unchanged feeds cost a 304. */
  etag?: string | null
  /** When we last downloaded the whole body (conditional 304s don't count). */
  lastFullAt?: string | null
}

interface StoreFile {
  version: number
  profileVersion: string | null
  /** Hash of rules.md at the last scan; a change re-evaluates rule-made verdicts. */
  rulesVersion?: string | null
  lastScanAt: string | null
  lastErrors: string[]
  sources: Record<string, SourceCursor>
  items: JobItem[]
  state: Record<string, JobUserState>
  events: unknown[]
  /** Board handles ("greenhouse:acme") auto-watch has ever added; one it added that's gone from watchlist.md was removed on purpose. */
  autoWatched?: string[]
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
      // Newer than this build understands. We still read and write it (a refusal would make every
      // click a no-op), but nested fields this build doesn't know about may be dropped on save.
      console.warn(`[jobs] store version ${raw.version} > ${STORE_VERSION}; unknown fields may be lost`)
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
  } catch (err) {
    // Never let a parse failure turn into an empty store that the next save() writes over your history.
    // Set the broken file aside (it's still on disk) and start from the backup if there is one.
    const aside = `${path}.corrupt-${Date.now()}`
    try {
      renameSync(path, aside)
      console.warn(`[jobs] store unreadable (${err instanceof Error ? err.message : String(err)}); moved to ${aside}`)
      if (existsSync(path + '.bak')) {
        // Move (not copy) so a corrupt backup can't send us round this loop twice.
        renameSync(path + '.bak', path)
        return load()
      }
    } catch {
      // If even that fails, fall through to an empty store rather than crash the app.
    }
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
  // Keep the previous good file: with several unattended writers, one bad write shouldn't be the end of your tracker.
  if (existsSync(path)) copyFileSync(path, path + '.bak')
  renameSync(path + '.tmp', path)
}

function snapshotOf(item: JobItem): JobSnapshot {
  return {
    company: item.company,
    title: item.title,
    url: item.url,
    term: item.term,
    source: item.source,
    location: item.location
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
  const today = new Date().toISOString().slice(0, 10)
  for (const it of store.items) {
    // A pasted link is in no feed, so "unseen" means nothing for it; it stays until you act on it.
    if (it.active && !isPasted(it) && new Date(it.lastSeenAt ?? it.seenAt).getTime() < cutoff) it.active = false
    // An event is over once its date has passed, however recently the story linked it.
    if (it.active && it.kind === 'event' && it.deadline && it.deadline < today) it.active = false
  }
}

/** Everything the Apply-now signal reads, assembled once per call from rules.md, watchlist.md and the tracker. */
export function applySignals(store: StoreFile = load()): ApplySignals {
  const rules = readRules()
  const watch = readWatchlist()
  const applied = new Set<string>()
  for (const st of Object.values(store.state)) {
    if (OUTCOME_STATUSES.includes(st.status)) applied.add(st.snapshot.company.trim())
  }
  return {
    tier1: [...rules.tier1, ...watch.filter((w) => w.tier === 1).map((w) => w.company)],
    tier2: [...rules.tier2, ...watch.filter((w) => w.tier === 2).map((w) => w.company)],
    watchlist: watch.map((w) => w.company),
    appliedCompanies: [...applied],
    payFloor: rules.payFloor
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
    ...applySignals(store)
  }
}

/** Write several rule verdicts in one load/save; returns how many items were actually marked. */
export function setRuleVerdicts(
  entries: { id: string; verdict: JobVerdict; title?: string | null; company?: string | null }[],
  profileVersion: string
): number {
  if (entries.length === 0) return 0
  const store = load()
  const byId = new Map(store.items.map((it) => [it.id, it]))
  let n = 0
  for (const { id, verdict, title, company } of entries) {
    const item = byId.get(id)
    if (!item) continue
    item.verdict = verdict
    item.scoredWithProfileVersion = profileVersion
    item.rescore = false
    if (title) item.title = title.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (company) item.company = company.replace(/\s+/g, ' ').trim().slice(0, 120)
    n++
  }
  save(store)
  return n
}

/**
 * A link you pasted. Becomes a normal item (same screening, same Apply hand-off) under the
 * `manual` source, which no feed can expire. If the URL is already in the store, that row is
 * returned instead and brought back to active/untouched so it surfaces again.
 */
export function addManualItem(
  build: (url: string) => JobItem,
  url: string
): { id: string; existed: boolean; item: JobItem } {
  const store = load()
  const { id } = canonicalId(url)
  const cur = store.items.find((it) => it.id === id)
  if (cur) {
    let touched = false
    // A feed row you paste gets the pasted-row treatment from here on (visible while unscored,
    // Flagged rather than Hidden on a skip, never expired) without losing where it came from.
    if (cur.source !== 'manual' && !cur.alsoSeenIn.includes('manual')) {
      cur.alsoSeenIn.push('manual')
      touched = true
    }
    if (!cur.active) {
      cur.active = true
      cur.lastSeenAt = new Date().toISOString()
      touched = true
    }
    // You pasted it on purpose: an old "skipped" or an expired matcher verdict shouldn't keep it hidden.
    // Reset the status but keep the record, so a note you wrote survives.
    const st = store.state[id]
    if (st && st.status === 'skipped') {
      st.status = 'new'
      st.inherited = false
      st.updatedAt = new Date().toISOString()
      touched = true
    }
    // A rule skip is re-judged by the LLM: title rules don't apply to pasted rows. An LLM skip is
    // kept (it still holds, and the card now shows in Flagged with that reason instead of Hidden).
    if (cur.verdict?.decision === 'skip' && cur.verdict.rule) {
      cur.skipRules = true
      cur.verdict = null
      cur.scoredWithProfileVersion = null
      touched = true
    }
    // Never scored (too old for the automatic window when it arrived): pasting it is a request to score it.
    const untouched = !store.state[id] || store.state[id].status === 'new'
    if (!cur.verdict && !cur.rescore && untouched) {
      cur.rescore = true
      touched = true
    }
    if (touched) save(store)
    return { id, existed: true, item: cur }
  }
  const item = build(url)
  item.lastSeenAt = new Date().toISOString()
  store.items.push(item)
  save(store)
  return { id: item.id, existed: false, item }
}

/** "Score anyway": drop a rule verdict and let the LLM judge this posting from now on. */
export function requestLlmScore(id: string): boolean {
  const store = load()
  const item = store.items.find((it) => it.id === id)
  if (!item) return false
  item.skipRules = true
  item.verdict = null
  item.scoredWithProfileVersion = null
  save(store)
  return true
}

/**
 * When rules.md changes, forget every verdict a rule produced so those postings re-run the rules
 * (free) and reach the LLM only if they no longer match. LLM verdicts are untouched.
 */
export function resetRuleVerdictsIfRulesChanged(rulesVersion: string): number {
  const store = load()
  if (store.rulesVersion === rulesVersion) return 0
  let n = 0
  for (const it of store.items) {
    if (it.verdict?.rule) {
      it.verdict = null
      it.scoredWithProfileVersion = null
      it.rescore = true
      n++
    }
  }
  store.rulesVersion = rulesVersion
  save(store)
  return n
}

/**
 * Re-check every active, untouched row that currently says "apply" against the title rules. Free
 * (no network), so it runs each scan; this is how a tightened built-in rule reaches postings the
 * LLM already passed, instead of applying only to whatever arrives next.
 */
export function demoteApplyByTitleRules(
  rule: (item: JobItem) => JobVerdict | null,
  profileVersion: string
): { id: string; company: string; title: string }[] {
  const store = load()
  const demoted: { id: string; company: string; title: string }[] = []
  for (const it of store.items) {
    if (!it.active || it.kind === 'event' || it.skipRules || isPasted(it) || it.verdict?.decision !== 'apply') continue
    if (store.state[it.id] && store.state[it.id].status !== 'new') continue
    const v = rule(it)
    if (!v) continue
    it.verdict = v
    it.scoredWithProfileVersion = profileVersion
    demoted.push({ id: it.id, company: it.company, title: it.title })
  }
  if (demoted.length) save(store)
  return demoted
}

/** Applications (applied or later) per lower-cased company, for the F7 "already applied here" hint. */
export function appliedCountByCompany(): Map<string, number> {
  const store = load()
  const out = new Map<string, number>()
  for (const st of Object.values(store.state)) {
    if (!OUTCOME_STATUSES.includes(st.status)) continue
    const key = st.snapshot.company.trim().toLowerCase()
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

/** Active "apply" postings whose description hasn't been read for pay yet, newest first. */
export function itemsNeedingPay(limit: number): JobItem[] {
  return load()
    .items.filter((it) => it.active && it.kind !== 'event' && !it.pay && !it.payChecked && it.verdict?.decision === 'apply')
    .sort((a, b) => (b.postedAt ?? b.seenAt).localeCompare(a.postedAt ?? a.seenAt))
    .slice(0, limit)
}

/** Untouched apply rows not yet re-checked against the current built-in text rules, newest first. */
export function itemsNeedingTextAudit(rev: number, limit: number): JobItem[] {
  const store = load()
  return store.items
    .filter(
      (it) =>
        it.active &&
        it.kind !== 'event' &&
        !it.skipRules &&
        it.verdict?.decision === 'apply' &&
        (it.textAuditRev ?? 0) < rev &&
        (!store.state[it.id] || store.state[it.id].status === 'new')
    )
    .sort((a, b) => (b.postedAt ?? b.seenAt).localeCompare(a.postedAt ?? a.seenAt))
    .slice(0, limit)
}

/**
 * Apply the result of a text-rule re-check. A hit replaces the LLM's apply with the rule's skip;
 * a miss just stamps the revision. Unreadable pages are left unstamped so they get another look.
 */
export function setTextAudit(rev: number, entries: { id: string; verdict: JobVerdict | null; read: boolean }[]): number {
  if (entries.length === 0) return 0
  const store = load()
  const byId = new Map(store.items.map((it) => [it.id, it]))
  let demoted = 0
  for (const { id, verdict, read } of entries) {
    const item = byId.get(id)
    if (!item || item.verdict?.decision !== 'apply') continue
    if (verdict) {
      item.verdict = verdict
      demoted++
    }
    if (read || verdict) item.textAuditRev = rev
  }
  save(store)
  return demoted
}

/** Record the outcome of a pay read without touching the verdict. `read` false = text never arrived; try again later. */
export function setPayFacts(entries: { id: string; pay: string | null; read: boolean }[]): void {
  if (entries.length === 0) return
  const store = load()
  const byId = new Map(store.items.map((it) => [it.id, it]))
  for (const { id, pay, read } of entries) {
    const it = byId.get(id)
    if (!it) continue
    if (!it.pay && pay) it.pay = pay.slice(0, 60)
    if (read) it.payChecked = true
  }
  save(store)
}

/** Company + URL of every application in the tracker (applied or a later status). */
export function appliedPostings(): { company: string; url: string }[] {
  const store = load()
  return Object.values(store.state)
    .filter((st) => OUTCOME_STATUSES.includes(st.status) && st.snapshot?.url)
    .map((st) => ({ company: st.snapshot.company, url: st.snapshot.url }))
}

export function getAutoWatched(): string[] {
  return load().autoWatched ?? []
}

export function addAutoWatched(handles: string[]): void {
  if (handles.length === 0) return
  const store = load()
  store.autoWatched = [...new Set([...(store.autoWatched ?? []), ...handles])]
  save(store)
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
    appliedAt: null,
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
  // A status you set yourself is authoritative; it no longer counts as a guess.
  state.inherited = false
  if (status === 'applying') state.openedInAsideAt = new Date().toISOString()
  if (OUTCOME_STATUSES.includes(status) && !state.appliedAt) state.appliedAt = new Date().toISOString()
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

/** Record (or update) what briefly's browser did to this application's form. */
export function setPrepared(id: string, patch: Partial<PreparedInfo> | null): void {
  const store = load()
  const state = touch(store, id)
  if (!state) return
  if (patch === null) {
    state.prepared = null
  } else {
    const base: PreparedInfo = state.prepared ?? {
      at: new Date().toISOString(),
      finishedAt: null,
      ats: 'unknown',
      filled: 0,
      drafted: [],
      unfilled: [],
      resumeUploaded: false,
      submittedAt: null,
      closedAt: null,
      error: null
    }
    state.prepared = { ...base, ...patch }
  }
  save(store)
}

/** Remember the employer page a wrapper link (jobright) resolved to. */
export function setResolvedUrl(id: string, url: string | null): void {
  const store = load()
  const state = touch(store, id)
  if (!state) return
  state.resolvedUrl = url && /^https:\/\//i.test(url) ? url.slice(0, 2000) : null
  save(store)
}

/** Untouched postings that are plainly outside the US: retire them so they stop costing tokens and attention. */
export function retireNonUS(isNonUS: (location: string | null) => boolean): number {
  const store = load()
  let n = 0
  for (const it of store.items) {
    if (it.active && !isPasted(it) && !store.state[it.id] && isNonUS(it.location)) {
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
      inheritAppliedState(store, inc)
      continue
    }
    cur.lastSeenAt = now
    if (cur.source !== inc.source && !cur.alsoSeenIn.includes(inc.source)) {
      cur.alsoSeenIn.push(inc.source)
    }
    const before = JSON.stringify([cur.title, cur.url, cur.deadline, cur.pay, cur.descriptionAvailable])
    // A pasted row's company/title are URL guesses; a feed that carries the real ones wins.
    const guessed = cur.source === 'manual' && !cur.verdict
    cur.company = guessed && inc.company ? inc.company : cur.company || inc.company
    cur.title = guessed && inc.title ? inc.title : cur.title || inc.title
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
  // Inheritance at arrival misses the other order (the applied record lands after the row did), so
  // untouched rows get another look every upsert. Idempotent: a row with state is skipped.
  for (const it of store.items) if (it.active && !store.state[it.id]) inheritAppliedState(store, it)
  collapseIndirectDuplicates(store)
  prune(store)
  save(store)
  return { added, changed }
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** City-ish token: "Palo Alto, CA, USA" → "palo alto". Feeds format the rest differently. */
const cityOf = (loc: string | null | undefined): string => norm((loc ?? '').split(/[,·|]/)[0])

/**
 * The duplicate and inheritance passes compare every row against every other, so norm() ran
 * millions of times per scan (it was ~80% of the main thread's work, pegging a core for 15 s every
 * tick). Cache per object, revalidated against the strings in case a row was edited in place.
 */
type Keyed = { company: string; title: string; location?: string | null }
const keyCache = new WeakMap<object, { company: string; title: string; location: string | null | undefined; pair: string; city: string }>()
function keysOf(x: Keyed): { pair: string; city: string } {
  const hit = keyCache.get(x)
  if (hit && hit.company === x.company && hit.title === x.title && hit.location === x.location) return hit
  const fresh = { company: x.company, title: x.title, location: x.location, pair: `${norm(x.company)}|${norm(x.title)}`, city: cityOf(x.location) }
  keyCache.set(x, fresh)
  return fresh
}

/**
 * Identity for rows that can't share a URL-derived id. Location is included so "Software Engineer
 * Intern" in Austin and in Seattle stay separate; rows with no location match any location.
 */
export function pairKey(x: { company: string; title: string }): string {
  return keysOf(x).pair
}
export function samePosting(a: Keyed, b: Keyed): boolean {
  const ka = keysOf(a)
  const kb = keysOf(b)
  if (ka.pair !== kb.pair) return false
  return !ka.city || !kb.city || ka.city === kb.city
}

/**
 * A posting you've already applied to can resurface under a new id: Jobright relists it, or an
 * import recorded it without a URL. When the new row matches such a record, it inherits that status
 * instead of showing up as new.
 *
 * Deliberately narrow. A Jobright row inherits when it matches (its link can't disambiguate anyway).
 * A direct-link row inherits only from records that *couldn't* carry its id — URL-less imports and
 * Jobright records; an applied direct-link record with a different id is a different posting — and
 * only when no other active row shares its company+title. Rows that themselves inherited count as
 * competitors, so one location-less import can't sweep up RTX's title in a dozen cities one tick at
 * a time, while a unique "Figma · SWE Intern (Winter 2027)" still matches.
 */
function inheritAppliedState(store: StoreFile, inc: JobItem): void {
  if (store.state[inc.id]) return
  for (const [id, st] of Object.entries(store.state)) {
    if (!OUTCOME_STATUSES.includes(st.status) || st.inherited || !samePosting(st.snapshot, inc)) continue
    if (inc.source !== 'jobright') {
      // Only records that couldn't carry a URL-derived id: URL-less imports and Jobright. A pasted
      // link you applied to has a real URL; a different direct URL is a different posting.
      const urlLess = st.snapshot.source === 'manual' && !st.snapshot.url
      if (!urlLess && st.snapshot.source !== 'jobright') continue
      const liveDirect = store.items.some((it) => it.id === id && it.active && it.source !== 'jobright')
      if (liveDirect) continue
      // Any other active row with the same company+title makes the match ambiguous, unless it's one
      // you marked applied yourself (the Jobright copy of this very posting, typically).
      const ambiguous = store.items.some((it) => {
        if (it.id === inc.id || it.id === id || !it.active || pairKey(it) !== pairKey(inc)) return false
        const other = store.state[it.id]
        return !other || other.inherited || !OUTCOME_STATUSES.includes(other.status)
      })
      if (ambiguous) continue
    }
    store.state[inc.id] = {
      status: st.status,
      note: st.note || `Matched your ${st.status} record for this role`,
      promotedTaskId: null,
      openedInAsideAt: null,
      appliedAt: st.appliedAt ?? st.updatedAt,
      inherited: true,
      snapshot: snapshotOf(inc),
      updatedAt: new Date().toISOString()
    }
    return
  }
}

/**
 * Retire Jobright rows that duplicate a posting already represented by a direct-link row, or by an
 * earlier Jobright row (Jobright lists some postings twice). dropSoftDuplicates handles this at
 * arrival, but only when the Jobright row arrives second; this catches the other order and cleans
 * up rows that got in before either check existed. Rows the user has acted on are left alone.
 */
function collapseIndirectDuplicates(store: StoreFile): void {
  const active = store.items.filter((it) => it.active)
  // Candidates for "same posting" must share the company|title key, so bucket once instead of
  // scanning every active row for every Jobright row.
  const byPair = new Map<string, JobItem[]>()
  for (const it of active) {
    const k = pairKey(it)
    const list = byPair.get(k)
    if (list) list.push(it)
    else byPair.set(k, [it])
  }
  for (const it of active) {
    if (it.source !== 'jobright') continue
    const st = store.state[it.id]
    if (st && st.status !== 'new') continue
    const owner = (byPair.get(pairKey(it)) ?? []).find(
      (o) => o.id !== it.id && samePosting(o, it) && (o.source !== 'jobright' || o.seenAt < it.seenAt)
    )
    if (owner) it.active = false
  }
}

/** Unscored postings older than this are not worth LLM budget — they're the initial backfill, not inflow. */
const SCORE_MAX_AGE_DAYS = 10

function scoreEligible(it: JobItem, profileVersion: string, now = Date.now()): boolean {
  if (!it.active) return false
  if (it.verdict && it.scoredWithProfileVersion === profileVersion) return false
  // Already scored under an older profile, or explicitly asked for: always worth (re-)scoring.
  if (it.verdict || it.skipRules || it.rescore) return true
  // Never scored: only if recent.
  return now - new Date(it.postedAt ?? it.seenAt).getTime() <= SCORE_MAX_AGE_DAYS * 86_400_000
}

/**
 * Items that still need a verdict for the current profile version, in the order they should be
 * scored. The point of the pipeline is applying early, so arrival time wins: whatever a scan just
 * pulled in is scored before any backlog. Within the same arrival hour, "Score anyway" requests,
 * then Tier 1 / watchlist / ATS-board companies, then paid postings, then the rest.
 */
export function itemsNeedingScore(
  profileVersion: string,
  limit: number,
  priorityCompanies: string[] = [],
  exclude: Set<string> = new Set()
): JobItem[] {
  const store = load()
  const prio = new Set(priorityCompanies.map((c) => c.toLowerCase()))
  const hour = (it: JobItem): number => Math.floor(new Date(it.seenAt).getTime() / 3_600_000)
  const rank = (it: JobItem): number =>
    it.skipRules || isPasted(it) ? -1 : it.source === 'ats' || prio.has(it.company.toLowerCase()) ? 0 : it.pay ? 1 : 2
  return store.items
    .filter((it) => !exclude.has(it.id) && scoreEligible(it, profileVersion))
    .sort(
      (a, b) =>
        Number(b.skipRules ?? false) - Number(a.skipRules ?? false) ||
        hour(b) - hour(a) ||
        rank(a) - rank(b) ||
        (b.postedAt ?? b.seenAt).localeCompare(a.postedAt ?? a.seenAt)
    )
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
  facts: {
    descriptionAvailable?: boolean
    location?: string | null
    postedAt?: string | null
    pay?: string | null
    /** Company as the page states it. Replaces the placeholder on events and the URL guess on pasted links. */
    pageCompany?: string | null
    /** Title as the page states it; only pasted links have a guessed title worth replacing. */
    pageTitle?: string | null
    /** Event start (YYYY-MM-DD); stored as the deadline so it sorts, shows and expires like one. */
    eventDate?: string | null
  } = {}
): void {
  const store = load()
  const item = store.items.find((it) => it.id === id)
  if (!item) return
  item.verdict = verdict
  item.scoredWithProfileVersion = profileVersion
  item.rescore = false
  if (facts.descriptionAvailable !== undefined) item.descriptionAvailable = facts.descriptionAvailable
  // Page-derived facts are untrusted like feed fields: one bounded line, and only a parseable date.
  const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 120)
  const loc = facts.location ? oneLine(facts.location) : null
  const posted = facts.postedAt && !Number.isNaN(new Date(facts.postedAt).getTime()) ? facts.postedAt : null
  item.location = item.location ?? loc
  item.postedAt = item.postedAt ?? posted
  if (item.kind === 'event') {
    // The host only guesses the organiser ("Event", "Lu", a brand subdomain); a name read off the page wins.
    if (facts.pageCompany) item.company = oneLine(facts.pageCompany)
    if (facts.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(facts.eventDate)) item.deadline = item.deadline ?? facts.eventDate
  }
  if (item.source === 'manual') {
    // Both fields were guessed from the URL; what the page says is strictly better.
    if (facts.pageCompany) item.company = oneLine(facts.pageCompany)
    if (facts.pageTitle) item.title = oneLine(facts.pageTitle)
  }
  // A feed's pay (SpeedyApply) is kept; text-derived pay only fills a blank. Only a read description
  // counts as checked — an offline fetch shouldn't retire the posting from the backfill for good.
  if (!item.pay && facts.pay) item.pay = facts.pay.slice(0, 60)
  if (facts.descriptionAvailable) item.payChecked = true
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
