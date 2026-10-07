import type { JobRow } from '../../../shared/jobs'
import { applyNowReason, type ApplySignals } from '../../../shared/applyNow'
import { localDay } from '../../../shared/dates'
import { hourlyRateOf } from '../../../shared/pay'

export interface Pick {
  row: JobRow
  score: number
  /** Why it's in Apply now, first, then one more short reason shown under the title. */
  why: string[]
}

const DAY = 86_400_000

/**
 * Domain weight within a tier, from the title. Order: production AI agents/eval > full-stack/backend
 * > AI infra > security > embedded/flight > applied ML. Anything else gets 0.
 */
const DOMAIN_ORDER: [RegExp, number][] = [
  [/\b(agent|agentic|eval|llm|genai|generative)\b/i, 6],
  [/\b(full[- ]?stack|backend|back[- ]end|software engineer|swe|platform|distributed)\b/i, 5],
  [/\b(ml infra|ai infra|infrastructure|inference|training platform|compute)\b/i, 4],
  [/\b(security|appsec|offensive|red team|detection)\b/i, 3],
  [/\b(embedded|firmware|flight software|avionics|autonomy)\b/i, 2],
  [/\b(machine learning|applied scientist|data scien|ml|ai)\b/i, 1]
]

function domainWeight(title: string): number {
  for (const [re, w] of DOMAIN_ORDER) if (re.test(title)) return w
  return 0
}

const REASON_WEIGHT: Record<string, number> = { 'tier 1': 6, 'tier 2': 4, "you've applied here": 3, 'on your watchlist': 3, zero2sudo: 3 }

/**
 * Every untouched, active, apply-verdict posting that the Apply-now signal accepts. Ordered by the
 * day briefly first saw it (newest day on top: "what came in since I last looked"), then by score
 * within the day so today's tier-1 sits above today's watchlist hit. Score: the reason is the
 * headline; a referral route, stated pay, grounded verdict, freshness and a near deadline break
 * ties, and domain weight orders equals so agents/backend outrank applied ML.
 *
 * Arrival (seenAt), not the feed's posted date: aggregators lag company boards by up to a day, so a
 * posting can be new to you while its posted date reads "3d ago". The card still shows that date.
 */
export function rankApplyNow(rows: JobRow[], signals: ApplySignals, now = Date.now()): Pick[] {
  const picks: Pick[] = []
  for (const row of rows) {
    const it = row.item
    if (!it || !it.active || it.verdict?.decision !== 'apply') continue
    if (row.state && row.state.status !== 'new') continue
    const reason = applyNowReason(it, signals)
    if (!reason) continue
    const why: string[] = [reason]
    let score = REASON_WEIGHT[reason] ?? 4 // a pay reason is the "$60/hr" string itself
    if (it.dcLink) {
      score += 3
      why.push('referral route')
    }
    const hr = hourlyRateOf(it.pay)
    if (hr !== null) {
      score += hr >= signals.payFloor ? 2 : 1
      if (reason !== it.pay) why.push(it.pay as string)
    }
    if (it.descriptionAvailable) score += 1
    const ageDays = (now - new Date(it.postedAt ?? it.seenAt).getTime()) / DAY
    if (ageDays <= 2) {
      score += 2
      // Jobright's date is when Jobright listed the role, not when the company posted it.
      why.push((it.source === 'jobright' ? 'listed ' : 'posted ') + (ageDays > 1 ? 'yesterday' : 'today'))
    } else if (ageDays <= 7) score += 1
    if (it.deadline) {
      const left = (new Date(it.deadline + 'T23:59:59').getTime() - now) / DAY
      if (left >= 0 && left <= 7) {
        score += 1
        why.push(it.kind === 'event' ? (left < 1 ? 'today' : `in ${Math.ceil(left)}d`) : `due in ${Math.ceil(left)}d`)
      }
    }
    if ((it.verdict.matched?.length ?? 0) >= 3) score += 1
    picks.push({ row, score, why: why.slice(0, 2) })
  }
  picks.sort(
    (a, b) =>
      localDay(b.row.item!.seenAt).localeCompare(localDay(a.row.item!.seenAt)) ||
      b.score - a.score ||
      domainWeight(b.row.item!.title) - domainWeight(a.row.item!.title) ||
      (b.row.item!.postedAt ?? b.row.item!.seenAt).localeCompare(a.row.item!.postedAt ?? a.row.item!.seenAt)
  )
  return picks
}
