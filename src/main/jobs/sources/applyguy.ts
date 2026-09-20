import type { JobItem } from '../../../shared/jobs'
import { getJson } from '../extract'
import { titleLooksRelevant } from '../normalize'
import { toItem, withinDays } from './common'

const URL = 'https://raw.githubusercontent.com/ApplyGuy/2027-Internships/main/data/internships.json'

interface Row {
  id: string
  company: string
  title: string
  category?: string
  location?: string
  season?: string
  posted?: string
  listingUrl?: string
  url?: string
}

/** ApplyGuy: updated hourly, direct ATS links, `posted` is YYYY-MM-DD. */
export async function fetchApplyGuy(maxAgeDays: number): Promise<JobItem[]> {
  const data = await getJson<Row[] | Record<string, unknown>>(URL)
  if (!data) throw new Error('ApplyGuy feed unavailable')
  const rows = (Array.isArray(data) ? data : (Object.values(data).find(Array.isArray) as Row[] | undefined)) ?? []
  const out: JobItem[] = []
  for (const r of rows) {
    const url = r.listingUrl || r.url
    if (!url || !r.title || !r.company) continue
    if (!titleLooksRelevant(r.title) && !/^software engineering$/i.test(r.category ?? '')) continue
    const postedAt = r.posted ? `${r.posted}T12:00:00Z` : null
    if (!withinDays(postedAt, maxAgeDays)) continue
    out.push(
      toItem({
        source: 'applyguy',
        company: r.company,
        title: r.title,
        url,
        location: r.location ?? null,
        postedAt,
        termHint: r.season ?? null,
        sourceRef: `applyguy:${r.id}`
      })
    )
  }
  return out
}
