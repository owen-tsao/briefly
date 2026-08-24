/** Calendar day (YYYY-MM-DD) in the user's local timezone — never UTC. */
export function localDay(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Local day N days from now. */
export function localDayOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return localDay(d.toISOString())
}
