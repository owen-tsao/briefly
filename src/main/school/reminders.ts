import { Notification } from 'electron'
import { load, save, type SchoolStore } from './store'
import { getNotificationsEnabled } from '../settings'
import { addDays, localDay } from '../../shared/dates'
import { clock12, type SchoolItem } from '../../shared/school'

/**
 * Deadline reminders that carry the clock time. A 9:10 PM homework and an 11:59 PM one are the
 * same row in a date-only list; the point here is to say "9:10 PM" out loud, several times:
 *
 *  - Morning (8:00): everything due today, each with its time.
 *  - Timed deadlines: 3 hours, 1 hour and 15 minutes before, by name.
 *  - End-of-day deadlines (no time, i.e. 11:59 PM): one nudge at 6 PM.
 *  - Evening (8:00 PM): tomorrow's deadlines with times, so an early one isn't a surprise.
 *
 * Each reminder fires once (persisted in school.json), is not silent, and opens the popover on
 * click. Sleeping through a stage doesn't replay it on wake unless the deadline is still ahead.
 */

const MORNING_HOUR = 8
const EVENING_HOUR = 20
const ALL_DAY_NUDGE_HOUR = 18
const STAGES: { key: string; minutes: number; say: string }[] = [
  { key: '3h', minutes: 180, say: 'in 3 hours' },
  { key: '1h', minutes: 60, say: 'in 1 hour' },
  { key: '15m', minutes: 15, say: 'in 15 minutes' }
]
/** Fire only while still before the deadline (a stage that passed during sleep is skipped, the next one still fires). */
const LATE_GRACE_MINUTES = 0

let openPopover: (() => void) | null = null
let visibleFn: ((store: SchoolStore, i: SchoolItem) => boolean) | null = null

export function initReminders(popoverOpener: () => void, visible: (store: SchoolStore, i: SchoolItem) => boolean): void {
  openPopover = popoverOpener
  visibleFn = visible
}

function notify(title: string, body: string): void {
  if (!getNotificationsEnabled() || !Notification.isSupported()) return
  const n = new Notification({ title, body, silent: false })
  n.on('click', () => openPopover?.())
  n.show()
}

const minutesOf = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1
}

const line = (i: SchoolItem): string => `${i.course} · ${i.title} — ${i.dueTime ? clock12(i.dueTime) : '11:59 PM'}`

/** Run once a minute. */
export function checkReminders(now = new Date()): void {
  if (!visibleFn) return
  const store = load()
  const today = localDay(now.toISOString())
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const fired = (store.reminders ??= {})
  let changed = false
  const mark = (key: string): void => {
    fired[key] = now.toISOString()
    changed = true
  }
  const open = (i: SchoolItem): boolean => Boolean(visibleFn?.(store, i)) && !i.done && i.kind !== 'event'
  const dueToday = store.items.filter((i) => open(i) && i.due === today).sort((a, b) => (a.dueTime ?? '23:59').localeCompare(b.dueTime ?? '23:59'))

  // Morning digest. Only in the morning — a first launch at 11 PM shouldn't announce the day.
  if (now.getHours() >= MORNING_HOUR && !fired[`morning:${today}`]) {
    if (dueToday.length && now.getHours() < 14) {
      const timed = dueToday.filter((i) => i.dueTime && minutesOf(i.dueTime) < 23 * 60)
      notify(
        `Today at school — ${dueToday.length} due${timed.length ? `, ${timed.length} before midnight` : ''}`,
        dueToday.slice(0, 5).map(line).join('\n')
      )
    }
    mark(`morning:${today}`)
  }

  // Per-deadline countdown for timed items.
  for (const i of dueToday) {
    if (!i.dueTime) continue
    const dueMin = minutesOf(i.dueTime)
    if (dueMin < 0) continue
    const left = dueMin - nowMin
    for (const st of STAGES) {
      const key = `${i.id}:${st.key}`
      if (fired[key]) continue
      // Fire when inside this stage's window but before the next, nearer stage's window begins.
      const next = STAGES.find((s) => s.minutes < st.minutes)
      if (left <= st.minutes && left > (next ? next.minutes : LATE_GRACE_MINUTES)) {
        notify(`${i.course} due ${st.say} — ${clock12(i.dueTime)}`, i.title)
        mark(key)
      } else if (left <= (next ? next.minutes : LATE_GRACE_MINUTES)) {
        // Missed (asleep); the nearer stage covers it.
        mark(key)
      }
    }
  }

  // End-of-day items: one evening nudge.
  if (now.getHours() >= ALL_DAY_NUDGE_HOUR && !fired[`eod:${today}`]) {
    const eod = dueToday.filter((i) => !i.dueTime || i.dueTime === '23:59')
    if (eod.length) notify(`Due tonight by 11:59 PM — ${eod.length}`, eod.slice(0, 5).map((i) => `${i.course} · ${i.title}`).join('\n'))
    mark(`eod:${today}`)
  }

  // Tomorrow, the evening before.
  if (now.getHours() >= EVENING_HOUR && !fired[`evening:${today}`]) {
    const tomorrow = addDays(today, 1)
    const next = store.items.filter((i) => open(i) && i.due === tomorrow).sort((a, b) => (a.dueTime ?? '23:59').localeCompare(b.dueTime ?? '23:59'))
    if (next.length) {
      const early = next.filter((i) => i.dueTime && minutesOf(i.dueTime) < 23 * 60)
      notify(`Tomorrow at school — ${next.length} due${early.length ? `, ${early.length} before midnight` : ''}`, next.slice(0, 5).map(line).join('\n'))
    }
    mark(`evening:${today}`)
  }

  // Keep the ledger small: anything from before yesterday is history.
  const cutoff = addDays(today, -2)
  for (const k of Object.keys(fired)) {
    const at = fired[k]
    if (localDay(at) < cutoff) {
      delete fired[k]
      changed = true
    }
  }
  if (changed) save(store)
}
