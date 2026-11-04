/**
 * Clock-time reminders for tasks that carry an instant (`dueAt`), not just a calendar day.
 * Same stages as the school reminders: 3 hours, 1 hour, and 15 minutes before. A stage that
 * was missed (the machine was asleep) is marked fired without a notification so it doesn't
 * announce "in 3 hours" after the fact. Date-only tasks have no `dueAt` and are left to the
 * daily deadline notification.
 */

export const REMINDER_STAGES: { key: string; minutes: number; say: string }[] = [
  { key: '3h', minutes: 180, say: 'in 3 hours' },
  { key: '1h', minutes: 60, say: 'in 1 hour' },
  { key: '15m', minutes: 15, say: 'in 15 minutes' }
]

export interface RemindableTask {
  id: string
  text: string
  state: string
  dueAt?: string | null
}

export interface TimedReminder {
  title: string
  body: string
}

export function timedReminders(
  tasks: RemindableTask[],
  firedIn: Readonly<Record<string, string>>,
  now: Date
): { notifications: TimedReminder[]; fired: Record<string, string> } {
  const fired: Record<string, string> = { ...firedIn }
  const notifications: TimedReminder[] = []
  const nowMs = now.getTime()
  const stamp = now.toISOString()
  for (const task of tasks) {
    if (task.state !== 'open' && task.state !== 'snoozed') continue
    if (!task.dueAt) continue
    const dueMs = Date.parse(task.dueAt)
    if (Number.isNaN(dueMs)) continue
    const left = (dueMs - nowMs) / 60_000
    for (let i = 0; i < REMINDER_STAGES.length; i++) {
      const stage = REMINDER_STAGES[i]
      const key = `${task.id}:${stage.key}`
      if (fired[key]) continue
      const nearer = REMINDER_STAGES[i + 1]
      const floor = nearer ? nearer.minutes : 0
      if (left <= stage.minutes && left > floor) {
        const kind = task.text.split(':')[0]?.trim() || 'Deadline'
        notifications.push({ title: `${kind} ${stage.say}`, body: task.text })
        fired[key] = stamp
      } else if (left <= floor) {
        fired[key] = stamp
      }
    }
  }
  return { notifications, fired }
}
