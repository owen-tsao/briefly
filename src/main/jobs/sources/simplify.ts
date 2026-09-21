import type { JobItem } from '../../../shared/jobs'
import { FEED_MAX_BODY_BYTES, getJson } from '../extract'
import { titleLooksRelevant } from '../normalize'
import { toItem, withinDays } from './common'

const URL =
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json'

interface Row {
  id: string
  company_name: string
  title: string
  url: string
  active: boolean
  is_visible: boolean
  terms?: string[]
  date_posted: number
  date_updated: number
  locations?: string[]
  category?: string
  sponsorship?: string
}

const TERM_OK = /2027|fall 2026|autumn 2026/i

/**
 * SimplifyJobs listings.json is ~13 MB and includes every past season. Filter to
 * visible, active, 2027-ish, recent, relevant-title rows before doing anything else.
 */
export async function fetchSimplify(maxAgeDays: number): Promise<JobItem[]> {
  const rows = await getJson<Row[]>(URL, {}, FEED_MAX_BODY_BYTES)
  if (!rows) throw new Error('Simplify feed unavailable')
  const out: JobItem[] = []
  for (const r of rows) {
    if (!r.active || !r.is_visible || !r.url || !r.title) continue
    if (!(r.terms ?? []).some((t) => TERM_OK.test(t))) continue
    if (!titleLooksRelevant(r.title)) continue
    const postedAt = r.date_posted ? new Date(r.date_posted * 1000).toISOString() : null
    if (!withinDays(postedAt, maxAgeDays)) continue
    // Simplify appends ?embed=true to Ashby/Greenhouse links; normalizeUrl strips it with the other tracking params.
    const url = r.url
    out.push(
      toItem({
        source: 'simplify',
        company: r.company_name,
        title: r.title,
        url,
        location: r.locations?.[0] ?? null,
        postedAt,
        termHint: (r.terms ?? []).join(' '),
        active: r.active,
        sourceRef: `simplify:${r.id}`
      })
    )
  }
  return out
}
