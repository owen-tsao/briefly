import type { JobItem } from '../../../shared/jobs'
import { fetchText } from '../extract'
import { stripHtml, titleLooksRelevant } from '../normalize'
import { toItem } from './common'

const URL = 'https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/README.md'

/**
 * SpeedyApply README: the only feed that lists hourly pay. Row shape:
 * | <a href=site><strong>Company</strong></a> | Title | Location | $55/hr | <a href=APPLY_URL>… | 4d |
 */
export async function fetchSpeedyApply(maxAgeDays: number): Promise<JobItem[]> {
  const r = await fetchText(URL)
  if (!r.ok) throw new Error('SpeedyApply README unavailable')
  const md = r.text
  const out: JobItem[] = []
  for (const line of md.split('\n')) {
    if (!line.startsWith('|') || !/https?:/.test(line)) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    // FAANG+/Quant tables carry a salary column; the "Other" table omits it.
    if (cells.length < 5) continue
    const hasPay = cells.length >= 6
    const company = stripHtml(cells[0])
    const title = stripHtml(cells[1])
    const location = stripHtml(cells[2]) || null
    const pay = hasPay && /\$\d/.test(cells[3]) ? stripHtml(cells[3]) : null
    const applyCell = cells[hasPay ? 4 : 3]
    const url = applyCell.match(/href="([^"]+)"/)?.[1]
    const ageDays = parseAge(cells[cells.length - 1])
    if (!company || !title || !url) continue
    if (!titleLooksRelevant(title)) continue
    if (ageDays !== null && ageDays > maxAgeDays) continue
    out.push(
      toItem({
        source: 'speedyapply',
        company,
        title,
        url,
        location,
        pay,
        postedAt: ageDays === null ? null : new Date(Date.now() - ageDays * 86_400_000).toISOString()
      })
    )
  }
  return out
}

function parseAge(s: string): number | null {
  const m = s.match(/(\d+)\s*([hdwmo])/i)
  if (!m) return null
  const n = Number(m[1])
  switch (m[2].toLowerCase()) {
    case 'h':
      return 0
    case 'd':
      return n
    case 'w':
      return n * 7
    default:
      return n * 30
  }
}
