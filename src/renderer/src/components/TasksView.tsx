import { useEffect, useRef, useState } from 'react'
import { AlarmClock, X } from 'lucide-react'
import type { AppState, Task, TaskState, Track } from '../../../shared/types'
import { TRACKS, TRACK_LABELS } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { ConfettiOverlay } from '@/components/ui/confetti'

interface Props {
  state: AppState
  allDone: boolean
  refreshing: boolean
  onRefresh: () => void
  onTaskState: (id: string, taskState: TaskState, snoozedUntil?: string) => void
  onTaskEdit: (id: string, text: string) => void
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

export function TasksView({
  state,
  allDone,
  refreshing,
  onRefresh,
  onTaskState,
  onTaskEdit,
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

  const today = new Date().toISOString().slice(0, 10)
  const visible = state.tasks.filter(
    (t) => t.state === 'open' || (t.state === 'done' && t.updatedAt.slice(0, 10) === today)
  )

  if (allDone) {
    return (
      <div className="relative flex flex-col items-center justify-center gap-2 py-16 text-center">
        <h3 className="text-lg font-bold tracking-tight">You crushed it today</h3>
        <p className="text-sm font-medium text-gray-600 dark:text-zinc-400">
          Take a breather and celebrate!
        </p>
        {celebrating && <ConfettiOverlay />}
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

      {visible.length === 0 ? (
        <EmptyState title="Nothing here" sub="No open tasks. On top of everything — or time to rescan." />
      ) : (
        TRACKS.map((track) => {
          const tasks = visible.filter((t) => t.track === track).sort(byOrder)
          if (tasks.length === 0) return null
          const openCount = tasks.filter((t) => t.state === 'open').length
          return (
            <section key={track}>
              <h4 className="mb-1.5 flex items-center gap-2 px-1 text-[10px] font-bold uppercase tracking-[0.08em] text-gray-500 dark:text-zinc-400">
                <span className={cn('h-1.5 w-1.5 rounded-full', TRACK_DOT[track])} />
                {TRACK_LABELS[track]}
                <span className="font-semibold text-gray-400 dark:text-zinc-600">{openCount}</span>
              </h4>
              <ul className="space-y-0.5">
                {tasks.map((task) => (
                  <TaskRow key={task.id} task={task} onTaskState={onTaskState} onTaskEdit={onTaskEdit} />
                ))}
              </ul>
            </section>
          )
        })
      )}
      <p className="pt-1 text-center text-[11px] font-medium text-gray-400 dark:text-zinc-600">
        Keep up the great work today!
      </p>
    </div>
  )
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
  return 0
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
  onTaskEdit
}: {
  task: Task
  onTaskState: (id: string, taskState: TaskState, snoozedUntil?: string) => void
  onTaskEdit: (id: string, text: string) => void
}): React.JSX.Element {
  const done = task.state === 'done'
  const deadline = task.deadline ? formatDeadline(task.deadline) : null
  const [snoozeOpen, setSnoozeOpen] = useState(false)

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
            <span className="flex items-center gap-1 text-[11px] font-medium capitalize text-gray-500 dark:text-zinc-400">
              <span className={cn('h-1.5 w-1.5 rounded-full', PRIORITY_DOT[task.priority])} />
              {task.priority}
            </span>
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
            'relative flex w-[46px] shrink-0 justify-end gap-1 transition-opacity duration-150',
            snoozeOpen
              ? 'pointer-events-auto opacity-100'
              : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
          )}
        >
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
  children
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded-md border border-slate-200 bg-white p-1 text-gray-400 shadow-sm transition-all hover:border-slate-300 hover:text-gray-700 active:scale-90 dark:border-white/[0.1] dark:bg-ink-800 dark:text-zinc-500 dark:hover:border-white/20 dark:hover:text-zinc-300"
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
