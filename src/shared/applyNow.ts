import type { JobItem } from './jobs'
import { hourlyRateOf } from './pay'

/**
 * The lists that decide whether an *eligible* posting is worth applying to right now. Every input
 * here is user-owned (rules.md, watchlist.md, the tracker); none of it bypasses the LLM screen.
 */
export interface ApplySignals {
  tier1: string[]
  tier2: string[]
  /** Companies from watchlist.md, whatever heading they sit under. */
  watchlist: string[]
  /** Companies with at least one application in the tracker. */
  appliedCompanies: string[]
  /** Hourly pay at or above which a posting qualifies on its own. */
  payFloor: number
}

/** Whole-word prefix match so "DoorDash USA" and "Five Rings LLC - Careers" hit "DoorDash" / "Five Rings". */
export function companyIn(company: string, list: Iterable<string>): boolean {
  const c = company.trim().toLowerCase()
  if (!c) return false
  for (const raw of list) {
    const l = raw.trim().toLowerCase()
    if (!l) continue
    if (c === l || c.startsWith(l + ' ') || c.startsWith(l + ',')) return true
  }
  return false
}

/**
 * Why this posting belongs in Apply now, or null if it's merely eligible. Requires an "apply"
 * verdict first: sources like zero2sudo are ranking evidence, not a way around screening.
 */
export function applyNowReason(item: JobItem, s: ApplySignals): string | null {
  if (item.verdict?.decision !== 'apply') return null
  if (companyIn(item.company, s.tier1)) return 'tier 1'
  if (companyIn(item.company, s.tier2)) return 'tier 2'
  const hr = hourlyRateOf(item.pay)
  if (hr !== null && hr >= s.payFloor) return `${item.pay}`
  if (companyIn(item.company, s.appliedCompanies)) return "you've applied here"
  if (companyIn(item.company, s.watchlist)) return 'on your watchlist'
  if (item.source === 'instagram') return 'zero2sudo'
  return null
}
