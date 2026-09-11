/** Calendar day (YYYY-MM-DD) in the user's local timezone — never UTC. */
export function localDay(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Local calendar day N days from now. */
export function localDayOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return localDay(d.toISOString())
}

/** Shift a YYYY-MM-DD string by N days (local, DST-safe via noon anchor). */
export function addDays(day: string, days: number): string {
  const d = new Date(day + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return localDay(d.toISOString())
}

// ---------------------------------------------------------------------------
// Work-day clock. Deadlines use the calendar day above; everything that means
// "today's work" (done-today, recurrence reset, pulse) uses this instead, so a
// session that runs past midnight is still one day, and the user can end a day
// early with the End-day button.
// ---------------------------------------------------------------------------

export interface DayConfig {
  /** Hour (0–8) at which a new work day begins. Default 4. */
  startHour: number
  /** Manual End-day marker: `day` was closed at `at`; anything after `at` belongs to the next day. */
  closed: { day: string; at: string } | null
}

export const DEFAULT_DAY_CONFIG: DayConfig = { startHour: 4, closed: null }

/** Natural work day for a timestamp — ignores the manual marker. */
export function naturalWorkDay(iso: string, startHour: number): string {
  const shifted = new Date(new Date(iso).getTime() - startHour * 3_600_000)
  return localDay(shifted.toISOString())
}

/** Work day for a timestamp, honoring a manual End-day close. */
export function workDayOf(iso: string, cfg: DayConfig): string {
  const day = naturalWorkDay(iso, cfg.startHour)
  if (cfg.closed && iso >= cfg.closed.at && day <= cfg.closed.day) return addDays(cfg.closed.day, 1)
  return day
}

export function currentWorkDay(cfg: DayConfig): string {
  return workDayOf(new Date().toISOString(), cfg)
}
