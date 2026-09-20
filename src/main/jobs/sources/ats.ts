import type { JobItem } from '../../../shared/jobs'
import { getJson } from '../extract'
import { titleLooksRelevant } from '../normalize'
import { readWatchlist, type WatchEntry } from '../profile'
import { toItem, withinDays } from './common'

type Board = WatchEntry & { ats: NonNullable<WatchEntry['ats']>; board: string }

async function greenhouse(b: Board, maxAgeDays: number): Promise<JobItem[]> {
  const j = await getJson<{ jobs?: { id: number; title: string; absolute_url: string; updated_at?: string; location?: { name?: string } }[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${b.board}/jobs`
  )
  if (!j?.jobs) throw new Error(`greenhouse:${b.board} unavailable`)
  return j.jobs
    .filter((x) => titleLooksRelevant(x.title) && withinDays(x.updated_at, maxAgeDays))
    .map((x) =>
      toItem({
        source: 'ats',
        company: b.company,
        title: x.title,
        url: x.absolute_url,
        location: x.location?.name ?? null,
        postedAt: x.updated_at ?? null
      })
    )
}

async function lever(b: Board, maxAgeDays: number): Promise<JobItem[]> {
  const j = await getJson<{ text: string; hostedUrl: string; createdAt?: number; categories?: { location?: string; commitment?: string } }[]>(
    `https://api.lever.co/v0/postings/${b.board}?mode=json`
  )
  if (!j) throw new Error(`lever:${b.board} unavailable`)
  return j
    .filter((x) => titleLooksRelevant(x.text) || /intern/i.test(x.categories?.commitment ?? ''))
    .map((x) => ({ x, postedAt: x.createdAt ? new Date(x.createdAt).toISOString() : null }))
    .filter(({ postedAt }) => withinDays(postedAt, maxAgeDays))
    .map(({ x, postedAt }) =>
      toItem({
        source: 'ats',
        company: b.company,
        title: x.text,
        url: x.hostedUrl,
        location: x.categories?.location ?? null,
        postedAt
      })
    )
}

async function ashby(b: Board, maxAgeDays: number): Promise<JobItem[]> {
  const j = await getJson<{ jobs?: { title: string; jobUrl: string; location?: string; publishedAt?: string; employmentType?: string }[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(b.board)}`
  )
  if (!j?.jobs) throw new Error(`ashby:${b.board} unavailable`)
  return j.jobs
    .filter((x) => (titleLooksRelevant(x.title) || /intern/i.test(x.employmentType ?? '')) && withinDays(x.publishedAt, maxAgeDays))
    .map((x) =>
      toItem({
        source: 'ats',
        company: b.company,
        title: x.title,
        url: x.jobUrl,
        location: x.location ?? null,
        postedAt: x.publishedAt ?? null
      })
    )
}

/** Workday board slug is "tenant/site" (and optionally "tenant/site@wd5"; default wd5→wd1 fallback). */
async function workday(b: Board, maxAgeDays: number): Promise<JobItem[]> {
  const [tenantSite, wdHint] = b.board.split('@')
  const [tenant, site] = tenantSite.split('/')
  if (!tenant || !site) throw new Error(`workday:${b.board} needs tenant/site`)
  const hosts = wdHint ? [wdHint] : ['wd5', 'wd1', 'wd3', 'wd12']
  for (const wd of hosts) {
    const base = `https://${tenant}.${wd}.myworkdayjobs.com`
    try {
      const r = await fetch(`${base}/wday/cxs/${tenant}/${site}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: 'intern' })
      })
      if (!r.ok) continue
      const j = (await r.json()) as { jobPostings?: { title: string; externalPath: string; locationsText?: string; postedOn?: string }[] }
      const out: JobItem[] = []
      for (const x of j.jobPostings ?? []) {
        if (!titleLooksRelevant(x.title)) continue
        // Workday's postedOn is relative text ("Posted 3 Days Ago"); the detail fetch fills the real date.
        out.push(
          toItem({
            source: 'ats',
            company: b.company,
            title: x.title,
            url: `${base}/${site}${x.externalPath}`,
            location: x.locationsText ?? null,
            postedAt: parsePostedOn(x.postedOn)
          })
        )
      }
      return out.filter((it) => withinDays(it.postedAt, maxAgeDays))
    } catch {
      // try next host
    }
  }
  throw new Error(`workday:${b.board} unavailable`)
}

function parsePostedOn(s?: string): string | null {
  if (!s) return null
  const m = s.match(/(\d+)\+?\s*day/i)
  if (m) return new Date(Date.now() - Number(m[1]) * 86_400_000).toISOString()
  if (/today|yesterday/i.test(s)) return new Date(Date.now() - (/yesterday/i.test(s) ? 86_400_000 : 0)).toISOString()
  return null
}

/** Poll every board pinned in watchlist.md. One request per board; failures are per-board. */
export async function fetchWatchlistBoards(maxAgeDays: number): Promise<{ items: JobItem[]; errors: string[] }> {
  const boards = readWatchlist().filter((w): w is Board => Boolean(w.ats && w.board))
  const items: JobItem[] = []
  const errors: string[] = []
  await Promise.all(
    boards.map(async (b) => {
      try {
        const fn = { greenhouse, lever, ashby, workday }[b.ats]
        items.push(...(await fn(b, maxAgeDays)))
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
    })
  )
  return { items, errors }
}
