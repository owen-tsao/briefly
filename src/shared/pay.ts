/**
 * Pay parsing shared by the main process (reads it out of posting text) and the renderer (ranks on it).
 *
 * Pay-transparency laws in NY, CA, WA and CO put a range in most descriptions, so the text briefly
 * already downloads for scoring carries the number the feeds usually lack.
 */

const NUM = String.raw`\$\s?(\d{2,3}(?:\.\d{1,2})?)`
const HOURLY_UNIT = String.raw`\s*(?:\/|per|an|each)?\s*(?:hr|hour|hourly)\b`
const SEP = String.raw`\s*(?:-|–|—|to)\s*`
const RANGE = new RegExp(String.raw`${NUM}${SEP}\$?\s?(\d{2,3}(?:\.\d{1,2})?)${HOURLY_UNIT}`, 'i')
// "$25/hr - $35/hr": unit on both ends.
const RANGE_BOTH = new RegExp(String.raw`${NUM}${HOURLY_UNIT}${SEP}\$?\s?(\d{2,3}(?:\.\d{1,2})?)${HOURLY_UNIT}`, 'i')
const SINGLE = new RegExp(String.raw`${NUM}${HOURLY_UNIT}`, 'i')
// "$55 - $65" followed by "hourly" a few words later ("... per hour, depending on ...") is common.
const LOOSE_RANGE = new RegExp(String.raw`${NUM}${SEP}\$?\s?(\d{2,3}(?:\.\d{1,2})?)(?:[^.\n$]{0,40}?)\b(?:hourly|per hour|an hour|\/hour|\/hr)\b`, 'i')

const plausible = (n: number): boolean => n >= 15 && n <= 200

/**
 * Hourly pay quoted in posting text, normalised to "$55/hr" or "$45–60/hr". Null when nothing
 * plausible is stated; monthly/annual figures are left alone (interns are quoted hourly in the US).
 */
export function parseHourlyPay(text: string): string | null {
  const t = text.slice(0, 60_000)
  const range = t.match(RANGE_BOTH) ?? t.match(RANGE) ?? t.match(LOOSE_RANGE)
  if (range) {
    const lo = Number(range[1])
    const hi = Number(range[2])
    if (plausible(lo) && plausible(hi) && lo <= hi) return lo === hi ? `$${fmt(lo)}/hr` : `$${fmt(lo)}–${fmt(hi)}/hr`
  }
  const single = t.match(SINGLE)
  if (single) {
    const n = Number(single[1])
    if (plausible(n)) return `$${fmt(n)}/hr`
  }
  return null
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/**
 * Best-case hourly number in a pay string, for ranking: the top of a range, or the single figure.
 * Handles the feeds' own formats too ("$55/hr", "$50 - $60 / hour", "$45–60/hr"). Only `$`-prefixed
 * numbers count, so "$1,500/week (40 hours)" doesn't read as $40/hr. Null if not hourly.
 */
export function hourlyRateOf(pay: string | null | undefined): number | null {
  if (!pay) return null
  if (!/hr|hour/i.test(pay)) return null
  const nums = [...pay.matchAll(/(?:\$\s?|(?<=[–-]\s?))(\d{2,3}(?:\.\d{1,2})?)\b/g)].map((m) => Number(m[1])).filter(plausible)
  return nums.length ? Math.max(...nums) : null
}
