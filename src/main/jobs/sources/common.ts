import type { JobItem, JobSource as JobSourceName } from '../../../shared/jobs'
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
}

/** Build a store item from a source's raw posting. Ids are canonical so feeds dedupe. */
export function toItem(raw: RawPosting): JobItem {
  const { id, sourceRef } = canonicalId(raw.url)
  return {
    id,
    source: raw.source,
    alsoSeenIn: [],
    sourceRef: sourceRef ?? raw.sourceRef ?? null,
    company: raw.company.trim(),
    title: raw.title.trim(),
    url: normalizeUrl(raw.url),
    dcLink: raw.dcLink ?? false,
    referralNote: raw.referralNote ?? null,
    postedAt: raw.postedAt ?? null,
    deadline: raw.deadline ?? null,
    location: raw.location ?? null,
    pay: raw.pay ?? null,
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
