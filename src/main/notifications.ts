import { Notification, powerMonitor } from 'electron'
import { takeDueForNotification, takeTimedTaskReminders } from './taskStore'
import { getNotificationsEnabled } from './settings'
import { localDay } from '../shared/dates'
import type { Task } from '../shared/types'

let openPopover: (() => void) | null = null
let dailyTimer: NodeJS.Timeout | null = null

export function initNotifications(popoverOpener: () => void): void {
  openPopover = popoverOpener
  scheduleDailyCheck()
  // Booting after 9am would otherwise wait until tomorrow — check once shortly after launch.
  setTimeout(notifyDueTasks, 30_000)
  // Clock times (an OA at 9:42 PM, an interview at 2:00) use the same 3h / 1h / 15m stages as school.
  setInterval(notifyTimedTasks, 60_000)
  setTimeout(notifyTimedTasks, 20_000)
  // Timers freeze during sleep — re-check on wake (per-day dedup makes this spam-safe).
  powerMonitor.on('resume', () => {
    setTimeout(notifyDueTasks, 10_000)
    setTimeout(notifyTimedTasks, 10_000)
  })
}

/** Per-task countdown. Date-only deadlines stay on the 9am digest above. */
function notifyTimedTasks(): void {
  try {
    if (!getNotificationsEnabled() || !Notification.isSupported()) return
    for (const item of takeTimedTaskReminders()) {
      const notification = new Notification({ title: item.title, body: item.body, silent: false })
      notification.on('click', () => openPopover?.())
      notification.show()
    }
  } catch (err) {
    console.warn('[tasks] reminders', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Fire one grouped notification for overdue / due-today / due-tomorrow tasks.
 * Each task notifies at most once per day (dedup persisted in the task store).
 */
export function notifyDueTasks(): void {
  if (!getNotificationsEnabled() || !Notification.isSupported()) return
  const due = takeDueForNotification()
  if (due.length === 0) return

  const today = localDay()
  const overdue = due.filter((t) => (t.deadline as string) < today)
  const dueToday = due.filter((t) => t.deadline === today)
  const tomorrow = due.filter((t) => (t.deadline as string) > today)

  const parts: string[] = []
  if (overdue.length) parts.push(`${overdue.length} overdue`)
  if (dueToday.length) parts.push(`${dueToday.length} due today`)
  if (tomorrow.length) parts.push(`${tomorrow.length} due tomorrow`)

  const preview = (tasks: Task[]): string[] => tasks.map((t) => t.text)
  const body = [...preview(overdue), ...preview(dueToday), ...preview(tomorrow)]
    .slice(0, 4)
    .join('\n')

  const notification = new Notification({
    title: `briefly — ${parts.join(', ')}`,
    body,
    silent: false
  })
  notification.on('click', () => openPopover?.())
  notification.show()
}

/** Self-rescheduling 9:00am local check. */
function scheduleDailyCheck(): void {
  if (dailyTimer) clearTimeout(dailyTimer)
  const now = new Date()
  const next = new Date(now)
  next.setHours(9, 0, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  dailyTimer = setTimeout(() => {
    notifyDueTasks()
    scheduleDailyCheck()
  }, next.getTime() - now.getTime())
}
