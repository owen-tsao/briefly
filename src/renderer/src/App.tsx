import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Moon, Sun, RefreshCw, Power, Undo2 } from 'lucide-react'
import type { AppState, Horizon, TaskState } from '../../shared/types'
import { localDay } from '../../shared/dates'
import { cn } from '@/lib/utils'
import { useTheme } from '@/lib/theme'
import { TasksView } from '@/components/TasksView'
import { AskView } from '@/components/AskView'
import { NotesView } from '@/components/NotesView'
import { SettingsView } from '@/components/SettingsView'

type Tab = 'tasks' | 'notes' | 'ask' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'notes', label: 'Notes' },
  { id: 'ask', label: 'Ask' },
  { id: 'settings', label: 'Settings' }
]

export function App(): React.JSX.Element {
  const { theme, toggle } = useTheme()
  const [tab, setTab] = useState<Tab>('tasks')
  const [state, setState] = useState<AppState | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dateInfo, setDateInfo] = useState({ date: '', time: '' })
  const [undo, setUndo] = useState<{ id: string; label: string } | null>(null)
  const undoTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    const updateTime = (): void => {
      const now = new Date()
      setDateInfo({
        date: now.toLocaleDateString('en-US', {
          weekday: 'short',
          day: 'numeric',
          month: 'short'
        }),
        time: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      })
    }
    updateTime()
    const interval = setInterval(updateTime, 60000)
    return () => clearInterval(interval)
  }, [])

  const loadState = useCallback(async () => {
    setState(await window.briefly.getState())
  }, [])

  useEffect(() => {
    loadState()
  }, [loadState])

  // Pick up auto-rescan results from the main process.
  useEffect(() => window.briefly.onStateChanged(setState), [])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    const result = await window.briefly.refresh()
    if (result.ok && result.state) setState(result.state)
    else setError(result.error ?? 'Something went wrong.')
    setRefreshing(false)
  }, [])

  const handleTaskState = useCallback(
    async (id: string, taskState: TaskState, snoozedUntil?: string) => {
      setState(await window.briefly.setTaskState(id, taskState, snoozedUntil))
      if (taskState === 'dismissed' || taskState === 'snoozed') {
        setUndo({ id, label: taskState === 'dismissed' ? 'Task dismissed' : 'Task snoozed' })
        window.clearTimeout(undoTimer.current)
        undoTimer.current = window.setTimeout(() => setUndo(null), 5000)
      }
    },
    []
  )

  const handleUndo = useCallback(async () => {
    if (!undo) return
    window.clearTimeout(undoTimer.current)
    setState(await window.briefly.setTaskState(undo.id, 'open'))
    setUndo(null)
  }, [undo])

  const handleTaskEdit = useCallback(async (id: string, text: string) => {
    setState(await window.briefly.updateTaskText(id, text))
  }, [])

  const handleTaskAdd = useCallback(async (text: string) => {
    setState(await window.briefly.addTask(text))
  }, [])

  const handleTaskRecurrence = useCallback(async (id: string, recurrence: 'daily' | null) => {
    setState(await window.briefly.setTaskRecurrence(id, recurrence))
  }, [])

  const handleTaskHorizon = useCallback(async (id: string, horizon: Horizon) => {
    setState(await window.briefly.setTaskHorizon(id, horizon))
  }, [])

  const handleOpenNote = useCallback((title: string) => {
    void window.briefly.openNote(title)
  }, [])

  const handleTodayDismiss = useCallback(async (section: 'priorities' | 'changes', text: string) => {
    setState(await window.briefly.dismissTodayItem(section, text))
  }, [])

  const allDone = useMemo(() => {
    if (!state || !state.lastRefreshed) return false
    const open = state.tasks.filter((t) => t.state === 'open')
    const doneToday = state.tasks.filter(
      (t) => t.state === 'done' && localDay(t.updatedAt) === localDay()
    )
    return open.length === 0 && doneToday.length > 0
  }, [state])

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-slate-50 text-slate-900 transition-colors dark:bg-ink-950 dark:text-zinc-100">
      {/*
        Header — TodoCard yellow identity in light mode;
        layered ink surface with hairline border in dark mode.
      */}
      <header
        className={cn(
          'flex items-center justify-between px-4 py-3 transition-colors duration-500',
          allDone
            ? 'bg-gradient-to-b from-emerald-400 to-emerald-300 dark:border-b dark:border-emerald-500/20 dark:from-emerald-950/60 dark:to-ink-950'
            : 'bg-gradient-to-b from-yellow-300 to-yellow-200 dark:border-b dark:border-white/[0.08] dark:from-ink-900 dark:to-ink-950'
        )}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-bold tracking-tight text-gray-900 dark:text-zinc-100">
            <span
              className={cn(
                'mr-1',
                allDone ? 'text-emerald-900 dark:text-emerald-400' : 'text-gray-900 dark:text-accent'
              )}
            >
              ✓
            </span>
            briefly
          </span>
          <span className="rounded-md bg-black/10 px-1.5 py-0.5 text-[11px] font-medium text-gray-800 dark:bg-white/[0.07] dark:text-zinc-400">
            {dateInfo.date}
          </span>
          <span className="rounded-md bg-black/10 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-gray-800 dark:bg-white/[0.07] dark:text-zinc-400">
            {dateInfo.time}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <HeaderButton title="Rescan notes" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </HeaderButton>
          <HeaderButton
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={toggle}
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </HeaderButton>
          <HeaderButton title="Quit briefly" onClick={() => window.briefly.quit()}>
            <Power size={14} />
          </HeaderButton>
        </div>
      </header>

      {/* Segmented control */}
      <nav className="px-3 pt-2.5">
        <div className="flex rounded-lg bg-slate-200/60 p-0.5 dark:bg-ink-800">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex-1 rounded-md py-1 text-xs font-semibold transition-all duration-150 active:scale-[0.98]',
                tab === t.id
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-ink-700 dark:text-zinc-100'
                  : 'text-slate-500 hover:text-slate-800 dark:text-zinc-500 dark:hover:text-zinc-300'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {error && (
        <div className="mx-3 mt-2 flex items-start justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 dark:border-red-500/25 dark:bg-red-950/30 dark:text-red-400">
          <span className="select-text">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 font-bold opacity-70 hover:opacity-100">
            ✕
          </button>
        </div>
      )}

      {/* Dotted content background */}
      <main
        className={cn(
          'flex-1 overflow-y-auto p-4 [background-size:10px_10px]',
          allDone
            ? 'bg-[radial-gradient(circle,rgba(16,185,129,0.08)_1px,transparent_1px)] dark:bg-[radial-gradient(circle,rgba(16,185,129,0.05)_1px,transparent_1px)]'
            : 'bg-[radial-gradient(circle,rgba(0,0,0,0.05)_1px,transparent_1px)] dark:bg-[radial-gradient(circle,rgba(255,255,255,0.03)_1px,transparent_1px)]'
        )}
      >
        {tab === 'tasks' && state && (
          <TasksView
            state={state}
            allDone={allDone}
            refreshing={refreshing}
            onRefresh={handleRefresh}
            onTaskState={handleTaskState}
            onTaskEdit={handleTaskEdit}
            onTaskAdd={handleTaskAdd}
            onTaskRecurrence={handleTaskRecurrence}
            onTaskHorizon={handleTaskHorizon}
            onOpenNote={handleOpenNote}
            onTodayDismiss={handleTodayDismiss}
            onOpenSettings={() => setTab('settings')}
          />
        )}
        {tab === 'notes' && <NotesView onTasksChanged={loadState} />}
        {tab === 'ask' && <AskView hasApiKey={state?.hasApiKey ?? false} />}
        {tab === 'settings' && <SettingsView onSaved={loadState} />}
      </main>

      {undo && (
        <div className="pointer-events-none absolute bottom-3 left-0 right-0 z-40 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-slate-200 bg-white py-1.5 pl-4 pr-1.5 text-xs font-medium shadow-lg dark:border-white/[0.1] dark:bg-ink-800 dark:text-zinc-200">
            {undo.label}
            <button
              onClick={handleUndo}
              className="flex items-center gap-1 rounded-full bg-gray-900 px-2.5 py-1 font-semibold text-white transition hover:bg-gray-700 active:scale-95 dark:bg-accent dark:hover:bg-accent-hover"
            >
              <Undo2 size={11} /> Undo
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function HeaderButton({
  title,
  onClick,
  disabled,
  children
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md p-1.5 text-gray-800 transition-all duration-150 hover:bg-white/40 active:scale-95 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-white/[0.07] dark:hover:text-zinc-200"
    >
      {children}
    </button>
  )
}
