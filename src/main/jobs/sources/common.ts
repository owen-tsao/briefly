import type { JobItem, JobSource as JobSourceName } from '../../../shared/jobs'
import { fetchText } from '../extract'
import { getSourceCursor, setSourceCursor } from '../jobsStore'
import { canonicalId, detectTerm, normalizeUrl } from '../normalize'

export interface RawPosting {
  source: JobSourceName
  company: string
  title: string
  url: string
  location?: string | null
  postedAt?: string | null
  deadline?: string | null
  pay?: string | null
  termHint?: string | null
  dcLink?: boolean
  referralNote?: string | null
  active?: boolean
  sourceRef?: string | null
  kind?: JobItem['kind']
  sourceUpdatedAt?: string | null
}

/** Feed text is untrusted: one line, bounded, so it can't smuggle instructions into prompts or overflow the UI. */
const line = (s: string | null | undefined, max = 200): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/** Build a store item from a source's raw posting. Ids are canonical so feeds dedupe. */
export function toItem(raw: RawPosting): JobItem {
  const { id, sourceRef } = canonicalId(raw.url)
  return {
    id,
    source: raw.source,
    ...(raw.kind && raw.kind !== 'posting' ? { kind: raw.kind } : {}),
    alsoSeenIn: [],
    sourceRef: sourceRef ?? raw.sourceRef ?? null,
    company: line(raw.company, 120),
    title: line(raw.title),
    url: normalizeUrl(raw.url),
    dcLink: raw.dcLink ?? false,
    referralNote: raw.referralNote ? line(raw.referralNote, 300) : null,
    postedAt: raw.postedAt ?? null,
    ...(raw.sourceUpdatedAt ? { sourceUpdatedAt: raw.sourceUpdatedAt } : {}),
    deadline: raw.deadline ? line(raw.deadline, 60) : null,
    location: raw.location ? line(raw.location, 120) : null,
    pay: raw.pay ? line(raw.pay, 60) : null,
    term: detectTerm(raw.title, raw.termHint),
    descriptionAvailable: false,
    verdict: null,
    seenAt: new Date().toISOString(),
    active: raw.active ?? true,
    scoredWithProfileVersion: null
  }
}

/** Only postings from the last N days on first run, so a fresh install isn't flooded. */
export function withinDays(iso: string | null | undefined, days: number): boolean {
  if (!iso) return true
  const t = new Date(iso).getTime()
  return Number.isNaN(t) || Date.now() - t <= days * 86_400_000
}

/** A full re-download at least this often, so "still listed" timestamps keep refreshing even if the ETag never changes. */
const FULL_FETCH_EVERY_MS = 24 * 3_600_000

export interface FeedFetch {
  /** Body text, or null when the server said 304 Not Modified. */
  text: string | null
  unchanged: boolean
  ok: boolean
  status: number
}

/**
 * Fetch a feed politely: send the ETag we saw last time so an unchanged file costs a 304 and zero
 * bytes on both ends. That is what makes polling every few minutes acceptable to the host.
 * `force` (Scan now) and the daily full refresh skip the conditional header.
 */
export async function fetchFeed(url: string, source: string, force = false, maxBytes?: number): Promise<FeedFetch> {
  const cur = getSourceCursor(source)
  const lastFull = cur.lastFullAt ? new Date(cur.lastFullAt).getTime() : 0
  const conditional = !force && cur.etag && Date.now() - lastFull < FULL_FETCH_EVERY_MS
  const r = await fetchText(url, conditional ? { headers: { 'if-none-match': cur.etag! } } : {}, maxBytes)
  if (r.status === 304) return { text: null, unchanged: true, ok: true, status: 304 }
  if (r.ok) {
    setSourceCursor(source, { ...getSourceCursor(source), etag: r.etag, lastFullAt: new Date().toISOString() })
  }
  return { text: r.ok ? r.text : null, unchanged: false, ok: r.ok, status: r.status }
}
