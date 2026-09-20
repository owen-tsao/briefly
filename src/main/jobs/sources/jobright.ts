import type { JobItem } from '../../../shared/jobs'
import { fetchText } from '../extract'
import { titleLooksRelevant } from '../normalize'
import { toItem } from './common'

// The repo is still named 2026 but carries 2027-season rows.
const URL = 'https://raw.githubusercontent.com/jobright-ai/2026-Software-Engineer-Internship/master/README.md'

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

/**
 * Jobright README: daily, ~100 rows, links go to jobright.ai (not the employer). Kept as a
 * backstop — rows whose company+title already exist from a direct source are dropped in the pipeline.
 * Row: | **[Company](site)** | **[Title](jobright url)** | Location | On Site | Sep 19 |
 */
export async function fetchJobright(maxAgeDays: number): Promise<JobItem[]> {
  const r = await fetchText(URL)
  if (!r.ok) throw new Error('Jobright README unavailable')
  const md = r.text
  const out: JobItem[] = []
  for (const line of md.split('\n')) {
    if (!line.startsWith('|') || !/jobright\.ai\/jobs/.test(line)) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 5) continue
    const company = cells[0].match(/\[([^\]]+)\]/)?.[1]
    const tm = cells[1].match(/\[([^\]]+)\]\(([^)]+)\)/)
    if (!company || !tm) continue
    const [, title, url] = tm
    if (!titleLooksRelevant(title)) continue
    const postedAt = parseMonthDay(cells[4])
    if (postedAt && Date.now() - new Date(postedAt).getTime() > maxAgeDays * 86_400_000) continue
    out.push(
      toItem({
        source: 'jobright',
        company,
        title,
        url: url.replace(/\?.*$/, ''),
        location: cells[2] || null,
        postedAt
      })
    )
  }
  return out
}

function parseMonthDay(s: string): string | null {
  const m = s.match(/([A-Za-z]{3})\s+(\d{1,2})/)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (month === undefined) return null
  const now = new Date()
  let d = new Date(now.getFullYear(), month, Number(m[2]), 12)
  if (d.getTime() > now.getTime() + 86_400_000) d = new Date(now.getFullYear() - 1, month, Number(m[2]), 12)
  return d.toISOString()
}
