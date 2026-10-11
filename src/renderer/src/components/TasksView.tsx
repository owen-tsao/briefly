import { useEffect, useRef, useState } from 'react'
import { AlarmClock, ChevronRight, Pin, PinOff, Plus, Repeat, Sunset, X } from 'lucide-react'
import type { AppState, Horizon, Priority, Task, TaskState, Track } from '../../../shared/types'
import { TRACKS, TRACK_LABELS } from '../../../shared/types'
import {
  addDays,
  currentWorkDay,
  localDay,
  localDayOffset,
  workDayOf,
  type DayConfig
} from '../../../shared/dates'
import { cn } from '@/lib/utils'
import { ConfettiOverlay } from '@/components/ui/confetti'
import { ActionButton, MetaMenu } from '@/components/primitives'

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
  onTaskTrack: (id: string, track: Track) => void
  onTaskPriority: (id: string, priority: Priority) => void
  onTaskPin: (id: string, pinned: boolean) => void
  /** Drag-ranked order of pinned tasks, top first. */
  onReorderPinned: (ids: string[]) => void
  onOpenNote: (title: string) => void
  onEndDay: () => void
  onOpenSettings: () => void
}

const TRACK_DOT: Record<Track, string> = {
  work: 'bg-indigo-500',
  leetcode: 'bg-amber-500',
  'job-apps': 'bg-emerald-500',
  resume: 'bg-pink-500',
  school: 'bg-violet-500',
  personal: 'bg-sky-500',
  other: 'bg-gray-400 dark:bg-zinc-500'
}

type Zone = 'today' | 'soon' | 'someday'

const ZONE_LABELS: Record<Zone, string> = { today: 'Today', soon: 'Soon', someday: 'Someday' }

/**
 * Where a task renders. Deadlines due by tomorrow promote into Today without mutating
 * anything. Done tasks use the same rules so checking one never jumps it between zones.
 */
function zoneOf(task: Task): Zone {
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
  onTaskTrack,
  onTaskPriority,
  onTaskPin,
  onReorderPinned,
  onOpenNote,
  onEndDay,
  onOpenSettings
}: Props): React.JSX.Element {
  const [celebrating, setCelebrating] = useState(false)
  const wasAllDoneRef = useRef(false)
  // Drag state for ranking pinned tasks: the id being dragged and the id it is currently over.
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

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

  const today = currentWorkDay(state.day)
  const visible = state.tasks.filter(
    (t) => t.state === 'open' || (t.state === 'done' && workDayOf(t.updatedAt, state.day) === today)
  )
  // Pinned = must-finish. Stays until done or unpinned; done ones sit struck through until the day ends.
  // Your drag order first (0 = focus on this now); pins you have not ranked follow in the order pinned.
  const pinned = visible
    .filter((t) => t.pinned)
    .sort((a, b) => (a.pinOrder ?? Number.MAX_SAFE_INTEGER) - (b.pinOrder ?? Number.MAX_SAFE_INTEGER) || (a.pinnedAt ?? '').localeCompare(b.pinnedAt ?? ''))
  const focusId = pinned.find((t) => t.state !== 'done')?.id ?? null
  const dropOn = (targetId: string): void => {
    if (!dragId || dragId === targetId) return
    const ids = pinned.map((t) => t.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(from, 1)
    ids.splice(to, 0, dragId)
    onReorderPinned(ids)
  }

  const strip = visible.length > 0 && (
    <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white/90 shadow-[0_1px_3px_rgba(0,0,0,0.04)] backdrop-blur dark:border-white/[0.08] dark:bg-ink-900/90">
      <DayPulse tasks={state.tasks} day={state.day} onEndDay={onEndDay} />
      <div className="border-t border-slate-100 border-l-2 border-l-amber-500 px-3.5 py-3 dark:border-t-white/[0.06]">
        <h4 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-amber-600 dark:text-amber-400">
          <Pin size={10} />
          Pinned
          {pinned.length > 0 && (
            <span className="font-semibold text-gray-400 dark:text-zinc-600">
              {pinned.filter((t) => t.state === 'done').length}/{pinned.length}
            </span>
          )}
        </h4>
        {pinned.length === 0 ? (
          <p className="text-[12px] leading-relaxed text-gray-400 dark:text-zinc-500">
            Pin the tasks you must finish — hover a task and press the pin. They stay here until done.
          </p>
        ) : (
          <ul className="space-y-1" title={pinned.length > 1 ? 'Drag to rank — the top one is what to do now' : undefined}>
            {pinned.map((t) => (
              <PinnedItem
                key={t.id}
                task={t}
                focus={t.id === focusId}
                dragging={t.id === dragId}
                over={t.id === overId && dragId !== null && dragId !== t.id}
                draggable={pinned.length > 1}
                onDragStart={() => setDragId(t.id)}
                onDragOver={() => setOverId(t.id)}
                onDrop={() => {
                  dropOn(t.id)
                  setDragId(null)
                  setOverId(null)
                }}
                onDragEnd={() => {
                  setDragId(null)
                  setOverId(null)
                }}
                onToggle={() => onTaskState(t.id, t.state === 'done' ? 'open' : 'done')}
                onUnpin={() => onTaskPin(t.id, false)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )

  if (allDone) {
    return (
      <div className="space-y-5">
        {strip}
        <div className="relative flex flex-col items-center justify-center gap-2 py-14 text-center">
          <h3 className="text-lg font-bold tracking-tight">You crushed it today</h3>
          <p className="text-sm font-medium text-gray-600 dark:text-zinc-400">
            Take a breather and celebrate!
          </p>
          {celebrating && <ConfettiOverlay />}
        </div>
        <QuickAdd onAdd={onTaskAdd} />
        <DoneThisWeek tasks={state.tasks} day={state.day} />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {strip}

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
            onTaskTrack={onTaskTrack}
            onTaskPriority={onTaskPriority}
            onTaskPin={onTaskPin}
            onOpenNote={onOpenNote}
          />
        ))
      )}

      <DoneThisWeek tasks={state.tasks} day={state.day} />

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
  onTaskTrack,
  onTaskPriority,
  onTaskPin,
  onOpenNote
}: {
  zone: Zone
  tasks: Task[]
  onTaskState: (id: string, taskState: TaskState, snoozedUntil?: string) => void
  onTaskEdit: (id: string, text: string) => void
  onTaskRecurrence: (id: string, recurrence: 'daily' | null) => void
  onTaskHorizon: (id: string, horizon: Horizon) => void
  onTaskTrack: (id: string, track: Track) => void
  onTaskPriority: (id: string, priority: Priority) => void
  onTaskPin: (id: string, pinned: boolean) => void
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
              onTaskTrack={onTaskTrack}
              onTaskPriority={onTaskPriority}
              onTaskPin={onTaskPin}
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

/** Collapsed weekly recap of completed tasks, grouped by work day. */
function DoneThisWeek({ tasks, day }: { tasks: Task[]; day: DayConfig }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const today = currentWorkDay(day)
  const weekAgo = addDays(today, -6)
  const done = tasks
    .filter((t) => t.state === 'done' && workDayOf(t.updatedAt, day) >= weekAgo)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  if (done.length === 0) return null

  const byDay = new Map<string, Task[]>()
  for (const t of done) {
    const d = workDayOf(t.updatedAt, day)
    byDay.set(d, [...(byDay.get(d) ?? []), t])
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
          {[...byDay.entries()].map(([d, dayTasks]) => (
            <div key={d}>
              <p className="mb-0.5 text-[10px] font-semibold text-gray-400 dark:text-zinc-500">
                {formatDay(d, today)}
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

function formatDay(day: string, today: string): string {
  if (day === today) return 'Today'
  if (day === addDays(today, -1)) return 'Yesterday'
  return new Date(day + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
}

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 }

/** One line in the pinned box: checkbox, text, and an unpin that fades in on hover — no layout shift. */
function PinnedItem({
  task,
  focus,
  dragging,
  over,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onToggle,
  onUnpin
}: {
  task: Task
  /** The one to do now: the top-ranked open pin. */
  focus: boolean
  dragging: boolean
  over: boolean
  draggable: boolean
  onDragStart: () => void
  onDragOver: () => void
  onDrop: () => void
  onDragEnd: () => void
  onToggle: () => void
  onUnpin: () => void
}): React.JSX.Element {
  const done = task.state === 'done'
  return (
    <li
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        onDragOver()
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'group/pin -mx-1.5 flex items-start gap-2 rounded-md px-1.5 text-[13px] leading-relaxed transition-[background-color,opacity,box-shadow] duration-150',
        draggable && 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-40',
        over && 'shadow-[inset_0_2px_0_0_theme(colors.amber.500)]',
        focus && !done && 'bg-amber-50/70 dark:bg-amber-400/[0.08]'
      )}
    >
      <button
        onClick={onToggle}
        title={done ? 'Mark open' : 'Mark done'}
        className={cn(
          'mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-all duration-200',
          done
            ? 'border-gray-900 bg-gray-900 dark:border-accent dark:bg-accent'
            : 'border-gray-300 bg-white hover:border-gray-400 dark:border-white/20 dark:bg-ink-800 dark:hover:border-white/40'
        )}
      >
        <svg
          className={cn('h-2.5 w-2.5 text-white transition-opacity duration-200', done ? 'opacity-100' : 'opacity-0')}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          viewBox="0 0 12 9"
        >
          <path d="M1 4.2L4 7L11 1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <span
        className={cn(
          'min-w-0 flex-1 line-through decoration-[1.2px] transition-[color,text-decoration-color] duration-300',
          done
            ? 'text-gray-400 decoration-gray-400/90 dark:text-zinc-500 dark:decoration-zinc-500/90'
            : 'text-gray-800 decoration-transparent dark:text-zinc-200'
        )}
      >
        {focus && !done && <span className="mr-1.5 rounded bg-amber-500 px-1 text-[9px] font-bold uppercase tracking-wide text-white align-middle">now</span>}
        {task.text}
      </span>
      <button
        title="Unpin"
        onClick={onUnpin}
        className="pointer-events-none mt-0.5 shrink-0 rounded p-0.5 text-gray-400 opacity-0 transition-all hover:text-gray-700 active:scale-90 group-hover/pin:pointer-events-auto group-hover/pin:opacity-100 dark:text-zinc-500 dark:hover:text-zinc-200"
      >
        <PinOff size={12} />
      </button>
    </li>
  )
}

/**
 * Renderer-only day summary scoped to today's workload (Today zone + this work day's
 * completions). Due/overdue stay on the calendar clock — a deadline is a date.
 */
function DayPulse({
  tasks,
  day,
  onEndDay
}: {
  tasks: Task[]
  day: DayConfig
  onEndDay: () => void
}): React.JSX.Element | null {
  const workToday = currentWorkDay(day)
  const calToday = localDay()
  const todayOpen = tasks.filter((t) => t.state === 'open' && zoneOf(t) === 'today')
  const doneToday = tasks.filter(
    (t) => t.state === 'done' && workDayOf(t.updatedAt, day) === workToday
  )
  const total = todayOpen.length + doneToday.length
  if (total === 0) return null
  const dueToday = todayOpen.filter((t) => t.deadline === calToday).length
  const overdue = todayOpen.filter((t) => t.deadline && t.deadline < calToday).length
  const pct = Math.round((doneToday.length / total) * 100)

  return (
    <div className="border-l-2 border-l-indigo-500 px-3.5 py-3">
      <div className="flex items-baseline justify-between">
        <h4 className="text-[10px] font-bold uppercase tracking-[0.08em] text-indigo-600 dark:text-indigo-400">
          Today
        </h4>
        <span className="flex items-center gap-2.5 text-[11px] font-medium">
          {overdue > 0 && (
            <span className="text-red-600 dark:text-red-400">
              {overdue} overdue
            </span>
          )}
          {dueToday > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              {dueToday} due today
            </span>
          )}
          <span className="tabular-nums text-gray-500 dark:text-zinc-400">
            {doneToday.length} of {total} done
          </span>
          <button
            title="End my day — clears today's done tasks and resets daily repeats"
            onClick={onEndDay}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-gray-400 transition-all hover:bg-slate-100 hover:text-gray-800 active:scale-95 dark:text-zinc-500 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
          >
            <Sunset size={11} />
            End day
          </button>
        </span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.07]">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            pct === 100 ? 'bg-emerald-500' : 'bg-indigo-500 dark:bg-accent'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function byOrder(a: Task, b: Task): number {
  // Done tasks keep their slot — checking one must not make it jump within the zone.
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
  onTaskTrack,
  onTaskPriority,
  onTaskPin,
  onOpenNote
}: {
  task: Task
  onTaskState: (id: string, taskState: TaskState, snoozedUntil?: string) => void
  onTaskEdit: (id: string, text: string) => void
  onTaskRecurrence: (id: string, recurrence: 'daily' | null) => void
  onTaskHorizon: (id: string, horizon: Horizon) => void
  onTaskTrack: (id: string, track: Track) => void
  onTaskPriority: (id: string, priority: Priority) => void
  onTaskPin: (id: string, pinned: boolean) => void
  onOpenNote: (title: string) => void
}): React.JSX.Element {
  const done = task.state === 'done'
  const deadline = task.deadline ? formatDeadline(task.deadline) : null
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const recurring = task.recurrence === 'daily'
  const horizon = task.horizon ?? 'soon'
  const hasSourceNote = Boolean(task.sourceNote) && !['quick add', 'unknown', 'jobs', 'school'].includes(task.sourceNote)

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
            'block select-text text-[13px] leading-snug outline-none',
            // Always line-through with an animated decoration color: the strike fades
            // in smoothly and renders correctly even when the text wraps.
            'line-through decoration-[1.3px] transition-[color,text-decoration-color] duration-300 ease-out',
            done
              ? 'text-gray-400 decoration-gray-400/90 dark:text-zinc-500 dark:decoration-zinc-500/90'
              : 'cursor-text decoration-transparent'
          )}
        >
          {task.text}
        </span>
        {/* Stays mounted when done (dimmed, inert) so the row height never jumps. */}
        <span
          className={cn(
            'mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 transition-opacity duration-300',
            done && 'pointer-events-none opacity-40'
          )}
        >
          <MetaMenu
              title="Change track"
              display={
                <>
                  <span className={cn('h-1.5 w-1.5 rounded-full', TRACK_DOT[task.track] ?? 'bg-gray-400')} />
                  {(TRACK_LABELS[task.track] ?? task.track).split(' ')[0]}
                </>
              }
              options={TRACKS.map((tr) => ({ id: tr, label: TRACK_LABELS[tr], dot: TRACK_DOT[tr] }))}
              selected={task.track}
              onSelect={(id) => onTaskTrack(task.id, id as Track)}
            />
            <MetaMenu
              title="Change urgency"
              display={
                <>
                  <span className={cn('h-1.5 w-1.5 rounded-full', PRIORITY_DOT[task.priority])} />
                  <span className="capitalize">{task.priority}</span>
                </>
              }
              options={(['high', 'medium', 'low'] as Priority[]).map((p) => ({
                id: p,
                label: p[0].toUpperCase() + p.slice(1),
                dot: PRIORITY_DOT[p]
              }))}
              selected={task.priority}
              onSelect={(id) => onTaskPriority(task.id, id as Priority)}
            />
            <MetaMenu
              title="Move to zone"
              display={<>{horizon === 'now' ? 'Today' : horizon === 'soon' ? 'Soon' : 'Someday'}</>}
              options={[
                { id: 'now', label: 'Today' },
                { id: 'soon', label: 'Soon' },
                { id: 'someday', label: 'Someday' }
              ]}
              selected={horizon}
              onSelect={(id) => onTaskHorizon(task.id, id as Horizon)}
            />
            {recurring && (
              <span
                title="Repeats daily"
                className="flex items-center gap-0.5 text-[11px] font-medium text-teal-600 dark:text-teal-400"
              >
                <Repeat size={10} /> daily
              </span>
            )}
            {task.pinned && (
              <span
                title="Pinned as a must-finish today"
                className="flex items-center gap-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
              >
                <Pin size={10} /> pinned
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
      </div>

      {/*
        Actions reserve their width permanently and fade in —
        the row never shifts on hover or completion.
      */}
      <span
        className={cn(
          'relative flex w-[90px] shrink-0 justify-end gap-1 transition-opacity duration-150',
          done || !snoozeOpen ? 'pointer-events-none opacity-0' : 'pointer-events-auto opacity-100',
          !done && !snoozeOpen && 'group-hover:pointer-events-auto group-hover:opacity-100'
        )}
      >
          <ActionButton
            title={task.pinned ? 'Unpin from today' : 'Pin as a must-finish today'}
            active={Boolean(task.pinned)}
            onClick={() => onTaskPin(task.id, !task.pinned)}
          >
            <Pin size={12} />
          </ActionButton>
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
    </li>
  )
}

function formatDeadline(iso: string): { label: string; urgent: boolean } {
  // Calendar-day difference, not elapsed hours: at 4 PM, tomorrow's end of day is 1.3 days away
  // and used to round up to "due in 2d".
  const date = new Date(iso + 'T12:00:00')
  const todayNoon = new Date(localDay() + 'T12:00:00')
  const days = Math.round((date.getTime() - todayNoon.getTime()) / 86_400_000)
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
