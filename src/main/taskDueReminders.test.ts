import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { timedReminders, type RemindableTask } from './taskDueReminders'

const task = (dueAt: string, state = 'open'): RemindableTask => ({
  id: 'task-1',
  text: 'OA: Stripe — Software Engineer Intern (Nov 4, 9:00 PM UTC)',
  state,
  dueAt
})

describe('timed task reminders', () => {
  const due = new Date('2026-11-04T21:00:00Z')

  it('says in 3 hours inside that window and does not repeat', () => {
    const now = new Date(due.getTime() - 3 * 60 * 60_000 + 60_000)
    const first = timedReminders([task(due.toISOString())], {}, now)
    assert.equal(first.notifications.length, 1)
    assert.match(first.notifications[0].title, /in 3 hours/)
    const again = timedReminders([task(due.toISOString())], first.fired, new Date(now.getTime() + 60_000))
    assert.equal(again.notifications.length, 0)
  })

  it('fires the nearer stage and marks the ones already missed', () => {
    const now = new Date(due.getTime() - 30 * 60_000)
    const result = timedReminders([task(due.toISOString())], {}, now)
    assert.deepEqual(
      result.notifications.map((n) => n.title),
      ['OA in 1 hour']
    )
    assert.ok(result.fired['task-1:3h'])
    assert.ok(result.fired['task-1:1h'])
    assert.equal(result.fired['task-1:15m'], undefined)
  })

  it('fires 15 minutes out', () => {
    const now = new Date(due.getTime() - 10 * 60_000)
    const result = timedReminders([task(due.toISOString())], {}, now)
    assert.match(result.notifications[0]?.title ?? '', /in 15 minutes/)
  })

  it('does not notify a finished task, a date-only task, or a deadline already past', () => {
    const now = new Date(due.getTime() - 2 * 60 * 60_000)
    const done = timedReminders([task(due.toISOString(), 'done')], {}, now)
    assert.equal(done.notifications.length, 0)
    const dateless = timedReminders([{ id: 't', text: 'OA: Stripe', state: 'open', dueAt: null }], {}, now)
    assert.equal(dateless.notifications.length, 0)
    const past = timedReminders([task(due.toISOString())], {}, new Date(due.getTime() + 5 * 60_000))
    assert.equal(past.notifications.length, 0)
    assert.ok(past.fired['task-1:3h'])
  })
})
