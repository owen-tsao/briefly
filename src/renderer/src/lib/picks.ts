import type { JobRow } from '../../../shared/jobs'

export interface Pick {
  row: JobRow
  score: number
  /** Short, human reasons shown under the title — the top two only. */
  why: string[]
}

const DAY = 86_400_000

/** "$55/hr", "$40 - $60/hr", "$8,000/mo" → hourly-ish number, or null. */
function hourly(pay: string | null): number | null {
  if (!pay) return null
  const nums = [...pay.matchAll(/\$\s?(\d[\d,]*)(?:\.\d+)?/g)].map((m) => Number(m[1].replace(/,/g, '')))
  if (nums.length === 0) return null
  const n = Math.max(...nums)
  if (/\/\s?(hr|hour)/i.test(pay) || n < 300) return n
  if (/\/\s?(mo|month)/i.test(pay) || (n >= 3000 && n < 30_000)) return Math.round(n / 160)
  if (/\/\s?(yr|year)/i.test(pay) || n >= 30_000) return Math.round(n / 2080)
  return null
}

/**
 * Rank untouched, active, apply-verdict postings for the Top picks box. Signals that matter to a
 * quick "should I apply right now" glance, roughly in order: a referral/DC route, a company you
 * chose to watch, pay, a verdict grounded in real posting text, freshness, and a near deadline.
 */
export function rankPicks(rows: JobRow[], watchlist: string[], limit = 3, now = Date.now()): Pick[] {
  const watched = new Set(watchlist.map((w) => w.trim().toLowerCase()).filter(Boolean))
  const picks: Pick[] = []
  for (const row of rows) {
    const it = row.item
    if (!it || !it.active || it.verdict?.decision !== 'apply') continue
    if (row.state && row.state.status !== 'new') continue
    let score = 0
    const why: string[] = []
    if (it.dcLink) {
      score += 4
      why.push('referral route')
    }
    if (watched.has(it.company.toLowerCase())) {
      score += 3
      why.push('on your watchlist')
    }
    const hr = hourly(it.pay)
    if (hr !== null) {
      score += hr >= 50 ? 3 : hr >= 40 ? 2 : 1
      why.push(it.pay as string)
    }
    if (it.descriptionAvailable) score += 1
    else why.push('text unread')
    const ageDays = (now - new Date(it.postedAt ?? it.seenAt).getTime()) / DAY
    if (ageDays <= 2) {
      score += 2
      why.push('posted today' + (ageDays > 1 ? '/yesterday' : ''))
    } else if (ageDays <= 7) score += 1
    if (it.deadline) {
      const left = (new Date(it.deadline + 'T23:59:59').getTime() - now) / DAY
      if (left >= 0 && left <= 7) {
        score += 1
        why.push(`due in ${Math.ceil(left)}d`)
      }
    }
    if (it.verdict.matched.length >= 3) score += 1
    picks.push({ row, score, why: why.slice(0, 2) })
  }
  picks.sort(
    (a, b) =>
      b.score - a.score ||
      (b.row.item!.postedAt ?? b.row.item!.seenAt).localeCompare(a.row.item!.postedAt ?? a.row.item!.seenAt)
  )
  return picks.slice(0, limit)
}
