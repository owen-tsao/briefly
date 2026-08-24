import { useEffect, useRef, useState } from 'react'
import { AlarmClock, ChevronRight, Plus, Repeat, X } from 'lucide-react'
import type { AppState, Horizon, Task, TaskState, Track } from '../../../shared/types'
import { TRACKS, TRACK_LABELS } from '../../../shared/types'
import { localDay, localDayOffset } from '../../../shared/dates'
import { cn } from '@/lib/utils'
import { ConfettiOverlay } from '@/components/ui/confetti'

interface Props {
  state: AppState
  allDone: boolean
  refreshing: boolean
  onRefresh: () => void
  onTaskState: (id: string, taskState: TaskState, snoozedUntil?: string) => void
  onTaskEdit: (id: string, text: string) => void
  onTaskAdd: (text: string) => void
  onTaskRecurrence: (id: string, recurrence: 'daily' | null) => void
  onTaskHorizon: (id: string, horizon: Horizon) => void
  onOpenNote: (title: string) => void
  onTodayDismiss: (section: 'priorities' | 'changes', text: string) => void
  onOpenSettings: () => void
}

const TRACK_DOT: Record<Track, string> = {
  work: 'bg-indigo-500',
  leetcode: 'bg-amber-500',
  'job-apps': 'bg-emerald-500',
  resume: 'bg-pink-500',
  personal: 'bg-sky-500',
  other: 'bg-gray-400 dark:bg-zinc-500'
}

type Zone = 'today' | 'soon' | 'someday'

const ZONE_LABELS: Record<Zone, string> = { today: 'Today', soon: 'Soon', someday: 'Someday' }

/** Where a task renders. Deadlines due by tomorrow promote into Today without mutating anything. */
function zoneOf(task: Task): Zone {
  if (task.state === 'done') {
    const h = task.horizon ?? 'soon'
    return h === 'now' ? 'today' : h
  }
  if (task.deadline && task.deadline <= localDayOffset(1)) return 'today'
  if (task.recurrence === 'daily') return 'today'
  const h = task.horizon ?? 'soon'
  return h === 'now' ? 'today' : h
}

export function TasksView({
  state,
  allDone,
  refreshing,
  onRefresh,
  onTaskState,
  onTaskEdit,
  onTaskAdd,
  onTaskRecurrence,
  onTaskHorizon,
  onOpenNote,
  onTodayDismiss,
  onOpenSettings
}: Props): React.JSX.Element {
  const [celebrating, setCelebrating] = useState(false)
  const wasAllDoneRef = useRef(false)

  useEffect(() => {
    if (allDone && !wasAllDoneRef.current) {
      setCelebrating(true)
      wasAllDoneRef.current = true
      const t = setTimeout(() => setCelebrating(false), 4000)
      return () => clearTimeout(t)
    }
    if (!allDone) {
      wasAllDoneRef.current = false
      setCelebrating(false)
    }
    return undefined
  }, [allDone])

  if (!state.hasApiKey) {
    return (
      <EmptyState
        title="Welcome to briefly"
        sub="Add a free API key to start organizing your notes — no credit card needed."
        action={{ label: 'Open Settings', onClick: onOpenSettings }}
      />
    )
  }

  if (!state.lastRefreshed) {
    return (
      <EmptyState
        title="Ready when you are"
        sub="Scan your Apple Notes and I'll turn the mess into an organized task board. Your notes are never modified."
        action={{
          label: refreshing ? 'Scanning notes…' : 'Scan my notes',
          onClick: onRefresh,
          disabled: refreshing
        }}
      />
    )
  }

  const today = localDay()
  const visible = state.tasks.filter(
    (t) => t.state === 'open' || (t.state === 'done' && localDay(t.updatedAt) === today)
  )

  if (allDone) {
    return (
      <div className="space-y-5">
        <div className="relative flex flex-col items-center justify-center gap-2 py-14 text-center">
          <h3 className="text-lg font-bold tracking-tight">You crushed it today</h3>
          <p className="text-sm font-medium text-gray-600 dark:text-zinc-400">
            Take a breather and celebrate!
          </p>
          {celebrating && <ConfettiOverlay />}
        </div>
        <QuickAdd onAdd={onTaskAdd} />
        <DoneThisWeek tasks={state.tasks} />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {state.today &&
        (() => {
          const priorityTasks = state.today.priorityIds
            .map((id) => state.tasks.find((t) => t.id === id))
            .filter((t): t is Task => Boolean(t) && t!.state !== 'dismissed' && t!.state !== 'archived')
          if (priorityTasks.length === 0 && state.today.changes.length === 0) return null
          return (
            <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white/90 shadow-[0_1px_3px_rgba(0,0,0,0.04)] backdrop-blur dark:border-white/[0.08] dark:bg-ink-900/90">
              {priorityTasks.length > 0 && (
                <div className="border-l-2 border-l-indigo-500 px-3.5 py-3">
                  <h4 className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-indigo-600 dark:text-indigo-400">
                    Today
                  </h4>
                  <ul className="space-y-1">
                    {priorityTasks.map((task) => (
                      <TodayTaskItem
                        key={task.id}
                        task={task}
                        onToggle={() =>
                          onTaskState(task.id, task.state === 'done' ? 'open' : 'done')
                        }
                        onDismiss={() => onTodayDismiss('priorities', task.id)}
                      />
                    ))}
                  </ul>
                </div>
              )}
              {state.today.changes.length > 0 && (
                <div className="border-t border-slate-100 border-l-2 border-l-amber-500 px-3.5 py-3 dark:border-t-white/[0.06]">
                  <h4 className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-amber-600 dark:text-amber-400">
                    What changed
                  </h4>
                  <ul className="space-y-1">
                    {state.today.changes.map((c, i) => (
                      <TodayItem key={i} text={c} onDismiss={() => onTodayDismiss('changes', c)} />
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )
        })()}

      <QuickAdd onAdd={onTaskAdd} />

      {visible.length === 0 ? (
        <EmptyState title="Nothing here" sub="No open tasks. On top of everything — or time to rescan." />
      ) : (
        (['today', 'soon', 'someday'] as Zone[]).map((zone) => (
          <ZoneSection
            key={zone}
            zone={zone}
            tasks={visible.filter((t) => zoneOf(t) === zone).sort(byOrder)}
            onTaskState={onTaskState}
            onTaskEdit={onTaskEdit}
            onTaskRecurrence={onTaskRecurrence}
            onTaskHorizon={onTaskHorizon}
            onOpenNote={onOpenNote}
          />
        ))
      )}

      <DoneThisWeek tasks={state.tasks} />

      <p className="pt-1 text-center text-[11px] font-medium text-gray-400 dark:text-zinc-600">
        Keep up the great work today!
      </p>
    </div>
  )
}

const ZONE_ACCENT: Record<Zone, string> = {
  today: 'text-indigo-600 dark:text-indigo-400',
  soon: 'text-gray-500 dark:text-zinc-400',
  someday: 'text-gray-400 dark:text-zinc-500'
}

function ZoneSection({
  zone,
  tasks,
  onTaskState,
  onTaskEdit,
  onTaskRecurrence,
  onTaskHorizon,
  onOpenNote
}: {
  zone: Zone
  tasks: Task[]
  onTaskState: (id: string, taskState: TaskState, snoozedUntil?: string) => void
  onTaskEdit: (id: string, text: string) => void
  onTaskRecurrence: (id: string, recurrence: 'daily' | null) => void
  onTaskHorizon: (id: string, horizon: Horizon) => void
  onOpenNote: (title: string) => void
}): React.JSX.Element | null {
  // Someday is a parking lot — start collapsed, remember the user's preference.
  const [open, setOpen] = useState(
    () => zone !== 'someday' || localStorage.getItem('briefly-someday-open') === '1'
  )
  if (tasks.length === 0) return null
  const openCount = tasks.filter((t) => t.state === 'open').length

  const toggle = (): void => {
    if (zone !== 'someday') return
    setOpen((v) => {
      localStorage.setItem('briefly-someday-open', v ? '0' : '1')
      return !v
    })
  }

  return (
    <section>
      <button
        onClick={toggle}
        className={cn(
          'mb-1.5 flex w-full items-center gap-1.5 px-1 text-[10px] font-bold uppercase tracking-[0.08em]',
          ZONE_ACCENT[zone],
          zone === 'someday' ? 'cursor-pointer' : 'cursor-default'
        )}
      >
        {zone === 'someday' && (
          <ChevronRight
            size={11}
            className={cn('transition-transform duration-150', open && 'rotate-90')}
          />
        )}
        {ZONE_LABELS[zone]}
        <span className="font-semibold text-gray-400 dark:text-zinc-600">{openCount}</span>
      </button>
      {open && (
        <ul className="space-y-0.5">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onTaskState={onTaskState}
              onTaskEdit={onTaskEdit}
              onTaskRecurrence={onTaskRecurrence}
              onTaskHorizon={onTaskHorizon}
              onOpenNote={onOpenNote}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/** Instant local task entry — Enter adds and keeps focus for rapid capture. */
function QuickAdd({ onAdd }: { onAdd: (text: string) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white/60 px-2.5 py-1.5 transition-colors focus-within:border-slate-400 focus-within:bg-white dark:border-white/[0.12] dark:bg-ink-900/40 dark:focus-within:border-white/25 dark:focus-within:bg-ink-900">
      <Plus size={13} className="shrink-0 text-gray-400 dark:text-zinc-500" />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) {
            onAdd(text)
            setText('')
          }
        }}
        placeholder="Add a task…"
        maxLength={500}
        className="w-full bg-transparent text-[13px] outline-none placeholder:text-gray-400 dark:placeholder:text-zinc-600"
      />
    </div>
  )
}

/** Collapsed weekly recap of completed tasks, grouped by day. */
function DoneThisWeek({ tasks }: { tasks: Task[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const weekAgo = localDayOffset(-6)
  const done = tasks
    .filter((t) => t.state === 'done' && localDay(t.updatedAt) >= weekAgo)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  if (done.length === 0) return null

  const byDay = new Map<string, Task[]>()
  for (const t of done) {
    const day = localDay(t.updatedAt)
    byDay.set(day, [...(byDay.get(day) ?? []), t])
  }

  return (
    <section className="pt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-1 text-[10px] font-bold uppercase tracking-[0.08em] text-gray-400 dark:text-zinc-500"
      >
        <ChevronRight
          size={11}
          className={cn('transition-transform duration-150', open && 'rotate-90')}
        />
        Done this week
        <span className="font-semibold text-gray-400 dark:text-zinc-600">{done.length}</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-2.5 px-1">
          {[...byDay.entries()].map(([day, dayTasks]) => (
            <div key={day}>
              <p className="mb-0.5 text-[10px] font-semibold text-gray-400 dark:text-zinc-500">
                {formatDay(day)}
              </p>
              <ul className="space-y-0.5">
                {dayTasks.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center gap-1.5 text-[12px] text-gray-500 line-through dark:text-zinc-500"
                  >
                    <span className={cn('h-1 w-1 shrink-0 rounded-full', TRACK_DOT[t.track])} />
                    <span className="min-w-0 truncate">{t.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function formatDay(day: string): string {
  if (day === localDay()) return 'Today'
  if (day === localDayOffset(-1)) return 'Yesterday'
  return new Date(day + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
}

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 }

/** Today-strip line with a dismiss ✕ that fades in on hover — no layout shift. */
function TodayItem({ text, onDismiss }: { text: string; onDismiss: () => void }): React.JSX.Element {
  return (
    <li className="group/today flex items-start gap-1.5 text-[13px] leading-relaxed text-gray-800 dark:text-zinc-200">
      <span className="min-w-0 flex-1">{text}</span>
      <button
        title="Dismiss for today"
        onClick={onDismiss}
        className="pointer-events-none mt-0.5 shrink-0 rounded p-0.5 text-gray-400 opacity-0 transition-all hover:text-gray-700 active:scale-90 group-hover/today:pointer-events-auto group-hover/today:opacity-100 dark:text-zinc-500 dark:hover:text-zinc-200"
      >
        <X size={12} />
      </button>
    </li>
  )
}

/** Live task reference in the Today strip: checkbox + current text, synced with the board. */
function TodayTaskItem({
  task,
  onToggle,
  onDismiss
}: {
  task: Task
  onToggle: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const done = task.state === 'done'
  return (
    <li className="group/today flex items-start gap-2 text-[13px] leading-relaxed">
      <label className="relative mt-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          checked={done}
          onChange={onToggle}
          className="peer absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
        />
        <span
          className={cn(
            'flex h-3.5 w-3.5 items-center justify-center rounded border transition-all duration-200',
            done
              ? 'border-gray-900 bg-gray-900 dark:border-accent dark:bg-accent'
              : 'border-gray-300 bg-white peer-hover:border-gray-400 dark:border-white/20 dark:bg-ink-800 dark:peer-hover:border-white/40'
          )}
        >
          <svg
            className={cn('h-2 w-2 text-white transition-opacity', done ? 'opacity-100' : 'opacity-0')}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            viewBox="0 0 12 9"
          >
            <path d="M1 4.2L4 7L11 1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </label>
      <span
        className={cn(
          'min-w-0 flex-1 text-gray-800 transition-all duration-200 dark:text-zinc-200',
          done && 'text-gray-400 line-through dark:text-zinc-500'
        )}
      >
        {task.text}
      </span>
      <button
        title="Remove from today"
        onClick={onDismiss}
        className="pointer-events-none mt-0.5 shrink-0 rounded p-0.5 text-gray-400 opacity-0 transition-all hover:text-gray-700 active:scale-90 group-hover/today:pointer-events-auto group-hover/today:opacity-100 dark:text-zinc-500 dark:hover:text-zinc-200"
      >
        <X size={12} />
      </button>
    </li>
  )
}

function byOrder(a: Task, b: Task): number {
  if (a.state !== b.state) return a.state === 'open' ? -1 : 1
  const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
  if (p !== 0) return p
  if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline)
  if (a.deadline) return -1
  if (b.deadline) return 1
  // Zones mix tracks — keep same-track tasks adjacent so the color dots read as clusters.
  return TRACKS.indexOf(a.track) - TRACKS.indexOf(b.track)
}

const PRIORITY_DOT = {
  high: 'bg-red-500',
  medium: 'bg-amber-400',
  low: 'bg-slate-300 dark:bg-zinc-600'
}

function snoozeOptions(): { label: string; until: string }[] {
  const now = new Date()
  const later = new Date(now.getTime() + 3 * 3_600_000)
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const nextWeek = new Date(now)
  nextWeek.setDate(now.getDate() + (((8 - now.getDay()) % 7) || 7))
  nextWeek.setHours(9, 0, 0, 0)
  return [
    { label: 'Later today', until: later.toISOString() },
    { label: 'Tomorrow', until: tomorrow.toISOString() },
    { label: 'Next week', until: nextWeek.toISOString() }
  ]
}

function TaskRow({
  task,
  onTaskState,
  onTaskEdit,
  onTaskRecurrence,
  onTaskHorizon,
  onOpenNote
}: {
  task: Task
  onTaskState: (id: string, taskState: TaskState, snoozedUntil?: string) => void
  onTaskEdit: (id: string, text: string) => void
  onTaskRecurrence: (id: string, recurrence: 'daily' | null) => void
  onTaskHorizon: (id: string, horizon: Horizon) => void
  onOpenNote: (title: string) => void
}): React.JSX.Element {
  const done = task.state === 'done'
  const deadline = task.deadline ? formatDeadline(task.deadline) : null
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const recurring = task.recurrence === 'daily'
  const horizon = task.horizon ?? 'soon'
  const nextHorizon: Horizon = horizon === 'now' ? 'soon' : horizon === 'soon' ? 'someday' : 'now'
  const hasSourceNote = Boolean(task.sourceNote) && !['quick add', 'unknown'].includes(task.sourceNote)

  return (
    <li
      className={cn(
        'group flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors',
        done ? 'bg-slate-100/80 dark:bg-ink-900/80' : 'hover:bg-slate-50 dark:hover:bg-ink-900/60'
      )}
    >
      {/* Animated checkbox — TodoCard design language */}
      <label className="relative mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          checked={done}
          onChange={() => onTaskState(task.id, done ? 'open' : 'done')}
          className="peer absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
        />
        <span
          className={cn(
            'flex h-5 w-5 transform items-center justify-center rounded-md border transition-all duration-200 ease-out',
            done
              ? 'scale-95 border-gray-900 bg-gray-900 dark:border-accent dark:bg-accent'
              : 'scale-100 border-gray-300 bg-white peer-hover:border-gray-400 dark:border-white/20 dark:bg-ink-800 dark:peer-hover:border-white/40'
          )}
        >
          <svg
            className={cn(
              'h-3 w-3 text-white transition-opacity duration-200 dark:text-white',
              done ? 'opacity-100' : 'opacity-0'
            )}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 12 9"
          >
            <path d="M1 4.2L4 7L11 1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </label>

      <div className="min-w-0 flex-1">
        {/* Edit-in-place: the text itself is editable — no input swap, no visual change. */}
        <span
          contentEditable={!done}
          suppressContentEditableWarning
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
            if (e.key === 'Escape') {
              e.currentTarget.innerText = task.text
              e.currentTarget.blur()
            }
          }}
          onPaste={(e) => {
            // contentEditable pastes rich HTML by default — force plain text.
            e.preventDefault()
            const text = e.clipboardData.getData('text/plain')
            const sel = window.getSelection()
            if (!sel || sel.rangeCount === 0) return
            sel.deleteFromDocument()
            sel.getRangeAt(0).insertNode(document.createTextNode(text))
            sel.collapseToEnd()
          }}
          onBlur={(e) => {
            const text = e.currentTarget.innerText.replace(/\s+/g, ' ').trim()
            if (text && text !== task.text) onTaskEdit(task.id, text)
            else e.currentTarget.innerText = task.text
          }}
          className={cn(
            'block select-text text-[13px] leading-snug outline-none transition-colors duration-200',
            done
              ? 'translate-x-[2px] text-gray-400 line-through dark:text-zinc-500'
              : 'cursor-text'
          )}
        >
          {task.text}
        </span>
        {!done && (
          <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            <span
              className="flex items-center gap-1 text-[11px] font-medium text-gray-500 dark:text-zinc-400"
              title={TRACK_LABELS[task.track]}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', TRACK_DOT[task.track])} />
              {TRACK_LABELS[task.track].split(' ')[0]}
            </span>
            <span className="flex items-center gap-1 text-[11px] font-medium capitalize text-gray-500 dark:text-zinc-400">
              <span className={cn('h-1.5 w-1.5 rounded-full', PRIORITY_DOT[task.priority])} />
              {task.priority}
            </span>
            <button
              title="Cycle horizon (Now → Soon → Someday)"
              onClick={() => onTaskHorizon(task.id, nextHorizon)}
              className="rounded bg-slate-200/70 px-1 py-px text-[10px] font-semibold capitalize text-gray-500 transition-colors hover:bg-slate-300/70 hover:text-gray-700 active:scale-95 dark:bg-white/[0.07] dark:text-zinc-400 dark:hover:bg-white/[0.12] dark:hover:text-zinc-200"
            >
              {horizon === 'now' ? 'today' : horizon}
            </button>
            {recurring && (
              <span
                title="Repeats daily"
                className="flex items-center gap-0.5 text-[11px] font-medium text-teal-600 dark:text-teal-400"
              >
                <Repeat size={10} /> daily
              </span>
            )}
            {deadline && (
              <span
                className={cn(
                  'text-[11px] font-medium',
                  deadline.urgent
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-gray-500 dark:text-zinc-400'
                )}
              >
                {deadline.label}
              </span>
            )}
            {hasSourceNote && (
              <button
                title={`Open "${task.sourceNote}" in Apple Notes`}
                onClick={() => onOpenNote(task.sourceNote)}
                className="max-w-[110px] truncate text-[11px] font-medium text-gray-400 underline decoration-dotted underline-offset-2 transition-colors hover:text-gray-700 dark:text-zinc-500 dark:hover:text-zinc-300"
              >
                {task.sourceNote}
              </button>
            )}
          </span>
        )}
      </div>

      {/*
        Actions reserve their width permanently and fade in —
        the row never shifts on hover.
      */}
      {!done && (
        <span
          className={cn(
            'relative flex w-[68px] shrink-0 justify-end gap-1 transition-opacity duration-150',
            snoozeOpen
              ? 'pointer-events-auto opacity-100'
              : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
          )}
        >
          <ActionButton
            title={recurring ? 'Stop repeating daily' : 'Repeat daily'}
            active={recurring}
            onClick={() => onTaskRecurrence(task.id, recurring ? null : 'daily')}
          >
            <Repeat size={12} />
          </ActionButton>
          <ActionButton title="Snooze…" onClick={() => setSnoozeOpen((v) => !v)}>
            <AlarmClock size={12} />
          </ActionButton>
          <ActionButton title="Dismiss forever" onClick={() => onTaskState(task.id, 'dismissed')}>
            <X size={12} />
          </ActionButton>
          {snoozeOpen && (
            <>
              <span className="fixed inset-0 z-10" onClick={() => setSnoozeOpen(false)} />
              <span className="absolute right-0 top-full z-20 mt-1 flex w-32 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-white/[0.1] dark:bg-ink-800">
                {snoozeOptions().map((opt) => (
                  <button
                    key={opt.label}
                    onClick={() => {
                      setSnoozeOpen(false)
                      onTaskState(task.id, 'snoozed', opt.until)
                    }}
                    className="px-3 py-1.5 text-left text-xs font-medium text-gray-700 transition-colors hover:bg-slate-50 hover:text-gray-900 dark:text-zinc-300 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100"
                  >
                    {opt.label}
                  </button>
                ))}
              </span>
            </>
          )}
        </span>
      )}
    </li>
  )
}

function ActionButton({
  title,
  onClick,
  active,
  children
}: {
  title: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        'rounded-md border p-1 shadow-sm transition-all active:scale-90',
        active
          ? 'border-teal-300 bg-teal-50 text-teal-600 hover:border-teal-400 dark:border-teal-500/40 dark:bg-teal-500/10 dark:text-teal-400 dark:hover:border-teal-500/60'
          : 'border-slate-200 bg-white text-gray-400 hover:border-slate-300 hover:text-gray-700 dark:border-white/[0.1] dark:bg-ink-800 dark:text-zinc-500 dark:hover:border-white/20 dark:hover:text-zinc-300'
      )}
    >
      {children}
    </button>
  )
}

function formatDeadline(iso: string): { label: string; urgent: boolean } {
  const date = new Date(iso + 'T23:59:59')
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000)
  if (days < 0) return { label: `overdue ${Math.abs(days)}d`, urgent: true }
  if (days === 0) return { label: 'due today', urgent: true }
  if (days === 1) return { label: 'due tomorrow', urgent: true }
  if (days <= 7) return { label: `due in ${days}d`, urgent: days <= 3 }
  return {
    label: date.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    urgent: false
  }
}

export function EmptyState({
  title,
  sub,
  action
}: {
  title: string
  sub: string
  action?: { label: string; onClick: () => void; disabled?: boolean }
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 px-6 py-14 text-center">
      <h3 className="text-base font-bold tracking-tight">{title}</h3>
      <p className="max-w-[280px] text-[13px] leading-relaxed text-gray-500 dark:text-zinc-400">
        {sub}
      </p>
      {action && (
        <button
          onClick={action.onClick}
          disabled={action.disabled}
          className="mt-1.5 rounded-lg bg-gray-900 px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition hover:bg-gray-700 disabled:opacity-60 dark:bg-accent dark:text-white dark:shadow-[0_0_16px_rgba(94,106,210,0.35)] dark:hover:bg-accent-hover"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
