import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronRight, ExternalLink, EyeOff, FileText, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react'
import type { AnnouncementSuggestion, LmsKind, LmsStatus, SchoolCourse, SchoolFlag, SchoolItem, SchoolKind, SchoolRule, SchoolView as View, SyllabusParseResult, SyllabusSuggestion, Weekday } from '../../../shared/school'
import { SCHOOL_KINDS, WEEKDAY_LABELS, clock12, weekOf } from '../../../shared/school'
import { addDays, localDay } from '../../../shared/dates'
import { cn } from '@/lib/utils'
import { EmptyState } from './TasksView'

/**
 * School tab: a time-grouped ledger of every deadline briefly knows about. Reading surface with
 * one primary action (Add); rules, courses, and the syllabus importer live behind the gear.
 */

type Panel = 'none' | 'add' | 'syllabus' | 'manage'

const KIND_LABEL: Record<SchoolKind, string> = {
  assignment: 'HW',
  quiz: 'Quiz',
  exam: 'Exam',
  project: 'Project',
  event: 'Event',
  study: 'Study',
  other: 'Other'
}

const SOURCE_LABEL: Record<SchoolItem['source'], string> = {
  canvas: 'Canvas',
  rule: 'rule',
  syllabus: 'syllabus',
  manual: 'you',
  gradescope: 'Gradescope'
}

export function SchoolView({ onOpenSettings, onTasksChanged }: { onOpenSettings: () => void; onTasksChanged: () => void }): React.JSX.Element {
  const [data, setData] = useState<View | null>(null)
  const [panel, setPanel] = useState<Panel>('none')
  const [course, setCourse] = useState<string | null>(null)
  const [laterOpen, setLaterOpen] = useState(false)
  const [polling, setPolling] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    void window.briefly.getSchool().then(setData)
    return window.briefly.onSchoolChanged(setData)
  }, [])

  const apply = useCallback(
    (v: View) => {
      setData(v)
      onTasksChanged()
    },
    [onTasksChanged]
  )

  const flash = (msg: string): void => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 3500)
  }

  const pollNow = async (): Promise<void> => {
    setPolling(true)
    const r = await window.briefly.pollSchoolNow()
    // Also refresh any connected LMS, so one button means "sync everything".
    const connected = data?.lms.filter((l) => l.connected && !l.needsLogin) ?? []
    const extra: string[] = []
    for (const l of connected) {
      const x = await window.briefly.syncLms(l.kind)
      if (x.ok) {
        if (x.added || x.updated || x.suggested) extra.push(`${l.kind === 'canvas' ? 'Canvas login' : 'Gradescope'}: ${x.added} new${x.updated ? `, ${x.updated} changed` : ''}${x.suggested ? `, ${x.suggested} to confirm` : ''}`)
      } else extra.push(`${l.kind}: ${x.error}`)
    }
    const latest = await window.briefly.getSchool()
    apply(latest)
    setPolling(false)
    const first = r.ok ? (r.added ? `${r.added} new from Canvas` : 'Canvas feed is up to date') : r.error
    flash([first, ...extra].join(' · '))
  }

  const connected = data?.lms.filter((l) => l.connected) ?? []

  const today = localDay()
  const thisWeek = weekOf(today)
  const nextWeek = addDays(thisWeek, 7)
  const weekAfter = addDays(thisWeek, 14)

  const courses = useMemo(() => (data?.courses ?? []).filter((c) => !c.hidden).sort((a, b) => a.course.localeCompare(b.course)), [data])

  const groups = useMemo(() => {
    if (!data) return null
    const hiddenCourses = new Set(data.courses.filter((c) => c.hidden).map((c) => c.course))
    const rows = data.items.filter((i) => !i.hidden && !i.satisfiedBy && !hiddenCourses.has(i.course) && (!course || i.course === course))
    const sort = (a: SchoolItem, b: SchoolItem): number => a.due.localeCompare(b.due) || (a.dueTime ?? '99').localeCompare(b.dueTime ?? '99') || a.course.localeCompare(b.course)
    const open = rows.filter((i) => !i.done)
    return {
      overdue: open.filter((i) => i.due < today).sort(sort),
      thisWeek: rows.filter((i) => i.due >= today && i.due < nextWeek && (!i.done || i.due >= thisWeek)).sort(sort),
      nextWeek: open.filter((i) => i.due >= nextWeek && i.due < weekAfter).sort(sort),
      later: open.filter((i) => i.due >= weekAfter).sort(sort),
      dueThisWeek: open.filter((i) => i.due >= today && i.due < nextWeek && i.kind !== 'event').length
    }
  }, [data, course, today, thisWeek, nextWeek, weekAfter])

  if (!data || !groups) return <div className="py-10 text-center text-xs text-gray-400">Loading…</div>

  const nothingYet = data.items.length === 0 && data.rules.length === 0
  if (nothingYet && panel === 'none' && connected.length === 0) {
    return (
      <div className="space-y-2">
        <EmptyState
          title="School"
          sub={
            data.status.feedConfigured
              ? 'Your Canvas feed is set; the first poll runs within a minute. You can also add a deadline or import a syllabus now.'
              : 'Paste your Canvas calendar feed in Settings to pull every dated assignment, then import each syllabus so exams and weekly homework show up too.'
          }
          action={data.status.feedConfigured ? { label: 'Add a deadline', onClick: () => setPanel('add') } : { label: 'Open Settings', onClick: onOpenSettings }}
        />
        <p className="text-center text-[11px] text-gray-400 dark:text-zinc-600">
          Coursework on Gradescope?{' '}
          <button onClick={() => setPanel('manage')} className="font-semibold text-gray-600 underline-offset-2 hover:underline dark:text-zinc-300">
            Connect it
          </button>
        </p>
      </div>
    )
  }

  const topFlags = data.flags.filter((f) => f.kind !== 'expected-not-seen')
  const weekFlags = (week: string): SchoolFlag[] => data.flags.filter((f) => f.kind === 'expected-not-seen' && f.week === week && (!course || f.course === course))

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold tracking-tight">
            {courses.length} {courses.length === 1 ? 'course' : 'courses'}
            <span className="text-gray-400 dark:text-zinc-500"> · </span>
            {groups.overdue.length > 0 && (
              <>
                <span className="text-rose-600 dark:text-rose-400">{groups.overdue.length} overdue</span>
                <span className="text-gray-400 dark:text-zinc-500"> · </span>
              </>
            )}
            {groups.dueThisWeek} {groups.overdue.length > 0 ? 'this week' : 'due this week'}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-500 dark:text-zinc-500">
            {data.status.feedConfigured || connected.length ? (
              <>
                {[data.status.feedConfigured ? 'Canvas' : null, ...connected.map((l) => (l.kind === 'gradescope' ? 'Gradescope' : 'Canvas login'))]
                  .filter(Boolean)
                  .join(' · ')}
                {' · '}
                {data.status.lastPollAt ? `synced ${ago(data.status.lastPollAt)}` : 'first sync pending'}
              </>
            ) : (
              <button onClick={onOpenSettings} className="underline-offset-2 hover:underline">
                No Canvas feed — add in Settings
              </button>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton title="Sync everything now" onClick={pollNow} disabled={polling || (!data.status.feedConfigured && connected.length === 0)}>
            <RefreshCw size={13} className={polling ? 'animate-spin' : ''} />
          </IconButton>
          <IconButton title="Import a syllabus" onClick={() => setPanel(panel === 'syllabus' ? 'none' : 'syllabus')} active={panel === 'syllabus'}>
            <FileText size={13} />
          </IconButton>
          <IconButton title="Rules and courses" onClick={() => setPanel(panel === 'manage' ? 'none' : 'manage')} active={panel === 'manage'}>
            <Settings2 size={13} />
          </IconButton>
          <button
            onClick={() => setPanel(panel === 'add' ? 'none' : 'add')}
            className="ml-1 flex items-center gap-1 rounded-lg bg-gray-900 px-2.5 py-1.5 text-[12px] font-semibold text-white transition hover:bg-gray-700 active:scale-95 dark:bg-accent dark:hover:bg-accent-hover"
          >
            <Plus size={12} /> Add
          </button>
        </div>
      </div>

      {toast && <div className="rounded-lg bg-slate-100 px-3 py-1.5 text-[11.5px] text-gray-700 dark:bg-white/[0.06] dark:text-zinc-300">{toast}</div>}

      {panel === 'add' && <AddPanel courses={courses} defaultCourse={course} onDone={(v, msg) => { apply(v); setPanel('none'); if (msg) flash(msg) }} onCancel={() => setPanel('none')} />}
      {panel === 'syllabus' && <SyllabusPanel courses={courses} llmConfigured={data.llmConfigured} onOpenSettings={onOpenSettings} onDone={(v, msg) => { apply(v); setPanel('none'); flash(msg) }} onCancel={() => setPanel('none')} />}
      {panel === 'manage' && <ManagePanel data={data} onChange={apply} />}

      {courses.length > 1 && (
        <div className="flex flex-wrap gap-1">
          <Pill active={course === null} onClick={() => setCourse(null)}>
            All
          </Pill>
          {courses.map((c) => (
            <Pill key={c.course} active={course === c.course} onClick={() => setCourse(course === c.course ? null : c.course)}>
              {c.course}
            </Pill>
          ))}
        </div>
      )}

      {topFlags.map((f, i) => (
        <FlagRow key={i} flag={f} onOpenSettings={onOpenSettings} onOpenManage={() => setPanel('manage')} />
      ))}

      {data.announcementSuggestions.length > 0 && (
        <AnnouncementSuggestions items={data.announcementSuggestions.filter((s) => !course || s.course === course)} onChange={apply} onFlash={flash} />
      )}

      {groups.overdue.length > 0 && <Group label="Overdue" tone="text-red-600 dark:text-red-400" items={groups.overdue} onChange={apply} />}
      <Group label="This week" tone="text-indigo-600 dark:text-indigo-400" items={groups.thisWeek} flags={weekFlags(thisWeek)} onChange={apply} emptyText={course ? `Nothing for ${course} this week` : 'Nothing due this week'} />
      <Group label="Next week" tone="text-gray-500 dark:text-zinc-400" items={groups.nextWeek} flags={weekFlags(nextWeek)} onChange={apply} />
      {groups.later.length > 0 && (
        <section>
          <button onClick={() => setLaterOpen(!laterOpen)} className="group mb-1.5 flex w-full items-center gap-1.5 text-left">
            <ChevronRight size={12} className={cn('text-gray-400 transition-transform', laterOpen && 'rotate-90')} />
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-gray-500 dark:text-zinc-400">Later</span>
            <span className="text-[11px] tabular-nums text-gray-400 dark:text-zinc-600">{groups.later.length}</span>
          </button>
          {laterOpen && (
            <ul className="space-y-0.5">
              {groups.later.map((i) => (
                <Row key={i.id} item={i} onChange={apply} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  if (m < 2) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

function Group({
  label,
  tone,
  items,
  flags = [],
  emptyText,
  onChange
}: {
  label: string
  tone: string
  items: SchoolItem[]
  flags?: SchoolFlag[]
  emptyText?: string
  onChange: (v: View) => void
}): React.JSX.Element | null {
  if (items.length === 0 && flags.length === 0 && !emptyText) return null
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className={cn('text-[10px] font-bold uppercase tracking-[0.08em]', tone)}>{label}</span>
        <span className="text-[11px] tabular-nums text-gray-400 dark:text-zinc-600">{items.filter((i) => !i.done).length}</span>
      </div>
      {items.length === 0 && flags.length === 0 ? (
        <p className="px-1 text-[11.5px] text-gray-400 dark:text-zinc-600">{emptyText}</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((i) => (
            <Row key={i.id} item={i} onChange={onChange} />
          ))}
          {flags.map((f, i) => (
            <li key={`f${i}`} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-[11.5px] text-amber-700 dark:text-amber-300">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{f.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * How close a deadline is, for the row tint. "Today" also covers a due time that has already passed
 * today (the grouping only moves items to Overdue at midnight); "soon" is tomorrow.
 */
type Urgency = 'none' | 'soon' | 'today' | 'passed'

function urgencyOf(item: SchoolItem, today: string, nowHHMM: string): Urgency {
  if (item.done) return 'none'
  if (item.due === today) return item.dueTime && item.dueTime < nowHHMM ? 'passed' : 'today'
  if (item.due === addDays(today, 1)) return 'soon'
  return 'none'
}

function Row({ item, onChange }: { item: SchoolItem; onChange: (v: View) => void }): React.JSX.Element {
  const d = new Date(item.due + 'T12:00:00')
  const day = d.toLocaleDateString(undefined, { weekday: 'short' })
  const num = d.getDate()
  const isEvent = item.kind === 'event'
  const now = new Date()
  const urgency = urgencyOf(item, localDay(), `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`)
  const hot = urgency === 'today' || urgency === 'passed'
  const time = clock12(item.dueTime)
  return (
    <li
      className={cn(
        'group flex items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
        urgency === 'passed' && 'bg-rose-50/80 hover:bg-rose-50 dark:bg-rose-500/[0.08] dark:hover:bg-rose-500/[0.12]',
        urgency === 'today' && 'bg-amber-50/80 hover:bg-amber-50 dark:bg-amber-500/[0.08] dark:hover:bg-amber-500/[0.12]'
      )}
    >
      {!isEvent ? (
        <button
          title={item.done ? 'Mark not done' : 'Mark done'}
          onClick={() => void window.briefly.setSchoolDone(item.id, !item.done).then(onChange)}
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition',
            item.done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-gray-300 hover:border-gray-500 dark:border-zinc-600 dark:hover:border-zinc-400'
          )}
        >
          {item.done && <span className="text-[9px] leading-none">✓</span>}
        </button>
      ) : (
        <span className="h-4 w-4 shrink-0" />
      )}
      <span
        className={cn(
          'w-[42px] shrink-0 text-[11px] tabular-nums',
          urgency === 'passed' ? 'font-semibold text-rose-700 dark:text-rose-300' : hot ? 'font-semibold text-amber-700 dark:text-amber-300' : urgency === 'soon' ? 'font-semibold text-gray-700 dark:text-zinc-300' : 'text-gray-500 dark:text-zinc-500'
        )}
        title={urgency === 'soon' ? 'Due tomorrow' : urgency === 'today' ? 'Due today' : urgency === 'passed' ? 'Due time has passed' : undefined}
      >
        {hot ? 'Today' : urgency === 'soon' ? 'Tmrw' : `${day} ${num}`}
      </span>
      <span className="w-[58px] shrink-0 truncate text-[10.5px] font-semibold text-gray-600 dark:text-zinc-400" title={item.course}>
        {item.course}
      </span>
      <span className={cn('min-w-0 flex-1 truncate text-[12px]', item.done && 'line-through text-gray-400 dark:text-zinc-600')} title={item.title}>
        {item.kind === 'exam' && !item.done && <span className="mr-1 rounded bg-rose-50 px-1 text-[9.5px] font-bold text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">EXAM</span>}
        {item.title}
      </span>
      <span
        className={cn('shrink-0 text-[10px] tabular-nums', hot ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-gray-400 dark:text-zinc-600')}
        title={`From ${SOURCE_LABEL[item.source]}${time ? ` · ${time}` : ''}`}
      >
        {time || SOURCE_LABEL[item.source]}
      </span>
      <span className="flex w-0 shrink-0 items-center gap-0.5 overflow-hidden transition-all group-hover:w-[58px]">
        {item.url && (
          <IconButton title="Open in Canvas" onClick={() => void window.briefly.openSchoolUrl(item.url!)} small>
            <ExternalLink size={11} />
          </IconButton>
        )}
        <IconButton title="Hide" onClick={() => void window.briefly.setSchoolHidden(item.id, true).then(onChange)} small>
          <EyeOff size={11} />
        </IconButton>
        <IconButton title="Delete" onClick={() => void window.briefly.deleteSchoolItem(item.id).then(onChange)} small>
          <Trash2 size={11} />
        </IconButton>
      </span>
    </li>
  )
}

function FlagRow({ flag, onOpenSettings, onOpenManage }: { flag: SchoolFlag; onOpenSettings: () => void; onOpenManage: () => void }): React.JSX.Element {
  const isFeed = flag.kind === 'feed-error' || flag.kind === 'feed-missing'
  const isLms = flag.kind === 'lms-login' || flag.kind === 'lms-error'
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed',
        flag.kind === 'feed-error' || flag.kind === 'lms-error'
          ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/25 dark:bg-red-950/30 dark:text-red-400'
          : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/20 dark:bg-amber-950/20 dark:text-amber-300'
      )}
    >
      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      <span className="flex-1 select-text">{flag.message}</span>
      {isFeed && (
        <button onClick={onOpenSettings} className="shrink-0 font-semibold underline-offset-2 hover:underline">
          Settings
        </button>
      )}
      {isLms && (
        <button onClick={onOpenManage} className="shrink-0 font-semibold underline-offset-2 hover:underline">
          Connections
        </button>
      )}
    </div>
  )
}

/**
 * Dates the model read in recent Canvas announcements. Each is a yes/no: yes puts it on the
 * ledger as a Canvas item, no remembers the dismissal so it never comes back.
 */
function AnnouncementSuggestions({ items, onChange, onFlash }: { items: AnnouncementSuggestion[]; onChange: (v: View) => void; onFlash: (m: string) => void }): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (s: AnnouncementSuggestion, accept: boolean): Promise<void> => {
    setBusy(s.id)
    const r = await window.briefly.resolveAnnouncement(s.id, accept)
    setBusy(null)
    onChange(r.view)
    if (!r.ok) onFlash(r.error)
    else if (accept) onFlash(`Added ${s.course}: ${s.title}`)
  }
  if (items.length === 0) return <></>
  return (
    <section className="rounded-xl border border-indigo-200/70 bg-indigo-50/50 p-2.5 dark:border-indigo-500/20 dark:bg-indigo-950/20">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-indigo-700 dark:text-indigo-300">From announcements</span>
        <span className="text-[11px] tabular-nums text-indigo-400">{items.length}</span>
        <span className="ml-auto text-[10.5px] text-indigo-500/80 dark:text-indigo-300/70">read by the model — confirm each</span>
      </div>
      <ul className="space-y-1">
        {items.map((s) => (
          <li key={s.id} className="flex items-start gap-2 rounded-lg bg-white/80 px-2 py-1.5 dark:bg-ink-900/70">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[12px]">
                <span className="shrink-0 font-semibold text-gray-600 dark:text-zinc-400">{s.course}</span>
                <span className="truncate font-medium">{s.title}</span>
                <span className="shrink-0 rounded bg-slate-100 px-1 text-[9.5px] font-semibold text-gray-600 dark:bg-white/[0.06] dark:text-zinc-400">{KIND_LABEL[s.kind]}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-gray-500 dark:text-zinc-500">
                  {s.due}
                  {s.time ? ` ${clock12(s.time)}` : ''}
                </span>
                {s.confidence !== 'high' && <span className="shrink-0 text-[9.5px] uppercase tracking-wide text-amber-600 dark:text-amber-400">{s.confidence}</span>}
              </div>
              <div className="truncate text-[10.5px] text-gray-400 dark:text-zinc-600" title={s.evidence}>
                “{s.evidence || s.from}” · {s.from}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {s.url && (
                <IconButton title="Open the announcement" onClick={() => void window.briefly.openSchoolUrl(s.url!)} small>
                  <ExternalLink size={11} />
                </IconButton>
              )}
              <button onClick={() => void act(s, false)} disabled={busy === s.id} className="rounded-md border border-slate-200 px-1.5 py-0.5 text-[10.5px] font-semibold text-gray-600 hover:border-gray-400 disabled:opacity-50 dark:border-white/[0.1] dark:text-zinc-300">
                No
              </button>
              <button onClick={() => void act(s, true)} disabled={busy === s.id} className="rounded-md bg-gray-900 px-1.5 py-0.5 text-[10.5px] font-semibold text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-accent dark:hover:bg-accent-hover">
                Add
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition',
        active
          ? 'border-gray-900 bg-gray-900 text-white dark:border-zinc-200 dark:bg-zinc-200 dark:text-ink-950'
          : 'border-slate-200 text-gray-600 hover:border-gray-400 dark:border-white/[0.1] dark:text-zinc-400 dark:hover:border-white/[0.25]'
      )}
    >
      {children}
    </button>
  )
}

function IconButton({ title, onClick, disabled, active, small, children }: { title: string; onClick: () => void; disabled?: boolean; active?: boolean; small?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center justify-center rounded-md border transition active:scale-95 disabled:opacity-40',
        small ? 'h-5 w-5' : 'h-7 w-7',
        active
          ? 'border-gray-900 bg-gray-900 text-white dark:border-zinc-200 dark:bg-zinc-200 dark:text-ink-950'
          : 'border-slate-200 bg-white text-gray-600 hover:border-gray-400 dark:border-white/[0.1] dark:bg-ink-800 dark:text-zinc-400 dark:hover:border-white/[0.25]'
      )}
    >
      {children}
    </button>
  )
}

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] outline-none transition focus:border-gray-400 dark:border-white/[0.08] dark:bg-ink-800 dark:focus:border-accent'
const labelCls = 'mb-0.5 block text-[10px] font-bold uppercase tracking-[0.08em] text-gray-400 dark:text-zinc-500'
const primaryBtn =
  'rounded-lg bg-gray-900 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-accent dark:hover:bg-accent-hover'
const secondaryBtn =
  'rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-gray-700 transition hover:border-gray-400 disabled:opacity-50 dark:border-white/[0.1] dark:bg-ink-800 dark:text-zinc-200'
const panelCls = 'rounded-xl border border-slate-200/80 bg-white/90 p-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-ink-900/90'

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

function AddPanel({
  courses,
  defaultCourse,
  onDone,
  onCancel
}: {
  courses: SchoolCourse[]
  defaultCourse: string | null
  onDone: (v: View, msg?: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [course, setCourse] = useState(defaultCourse ?? courses[0]?.course ?? '')
  const [title, setTitle] = useState('')
  const [due, setDue] = useState(localDay())
  const [time, setTime] = useState('')
  const [kind, setKind] = useState<SchoolKind>('assignment')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Two shapes of thing live here: dated work the feeds missed, and your own study to-dos
  // ("rewatch lecture 5") that nothing can detect. The switch keeps the form short for each.
  const study = kind === 'study'
  const [lastDeadlineKind, setLastDeadlineKind] = useState<SchoolKind>('assignment')
  const setMode = (m: 'deadline' | 'study'): void => {
    if (m === 'study') {
      if (!study) setLastDeadlineKind(kind)
      setKind('study')
    } else if (study) setKind(lastDeadlineKind)
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.briefly.addSchoolItem({ course, title, due, time: time || null, kind, url: url || null })
    setBusy(false)
    if (r.ok) onDone(r.view, study ? `Added to your ${course} to-dos` : `Added to ${course}`)
    else setError(r.error)
  }

  const modeBtn = (active: boolean): string =>
    cn(
      'rounded-md px-2 py-0.5 text-[11px] font-semibold transition',
      active ? 'bg-ink-900 text-white dark:bg-white dark:text-ink-900' : 'text-gray-500 hover:text-gray-800 dark:text-zinc-400 dark:hover:text-zinc-100'
    )

  return (
    <form
      className={cn(panelCls, 'space-y-2')}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 dark:bg-white/[0.06]" role="tablist" aria-label="What are you adding?">
        <button type="button" role="tab" aria-selected={!study} onClick={() => setMode('deadline')} className={modeBtn(!study)}>
          Deadline
        </button>
        <button type="button" role="tab" aria-selected={study} onClick={() => setMode('study')} className={modeBtn(study)}>
          Study task
        </button>
        <span className="ml-auto pr-1 text-[10.5px] text-gray-400 dark:text-zinc-500">{study ? 'Rewatch, review, practice…' : 'HW, quiz, exam the feeds missed'}</span>
      </div>
      <div className={cn('grid gap-2', study ? 'grid-cols-1' : 'grid-cols-[1fr_auto]')}>
        <div>
          <label className={labelCls}>Course</label>
          <input list="school-courses" value={course} onChange={(e) => setCourse(e.target.value)} placeholder="STAT 390" className={inputCls} autoFocus />
          <datalist id="school-courses">
            {courses.map((c) => (
              <option key={c.course} value={c.course} />
            ))}
          </datalist>
        </div>
        {!study && (
          <div>
            <label className={labelCls}>Kind</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as SchoolKind)} className={inputCls}>
              {SCHOOL_KINDS.filter((k) => k !== 'study').map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div>
        <label className={labelCls}>{study ? 'What' : 'Title'}</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={study ? 'Rewatch lecture 5, redo HW 2 problems 3–6' : 'Midterm 1'} className={inputCls} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>{study ? 'Do it by' : 'Due'}</label>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Time (optional)</label>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputCls} />
        </div>
      </div>
      {!study && (
        <div>
          <label className={labelCls}>Link (optional)</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className={inputCls} />
        </div>
      )}
      {error && <p className="text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className={secondaryBtn}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !title.trim() || !course.trim()} className={primaryBtn}>
          Add
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Syllabus
// ---------------------------------------------------------------------------

function SyllabusPanel({
  courses,
  llmConfigured,
  onOpenSettings,
  onDone,
  onCancel
}: {
  courses: SchoolCourse[]
  llmConfigured: boolean
  onOpenSettings: () => void
  onDone: (v: View, msg: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [hint, setHint] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SyllabusParseResult | null>(null)
  const [kept, setKept] = useState<Set<string>>(new Set())
  const [course, setCourse] = useState('')

  const run = async (useDialog: boolean): Promise<void> => {
    setBusy(true)
    const r = await window.briefly.parseSyllabus({ useDialog, text: useDialog ? undefined : text, courseHint: hint || undefined })
    setBusy(false)
    if (!r.ok && r.error === 'cancelled') return
    setResult(r)
    if (r.ok) {
      setKept(new Set((r.suggestions ?? []).filter((s) => s.confidence !== 'low').map((s) => s.id)))
      setCourse(r.course || hint)
    }
  }

  const accept = async (): Promise<void> => {
    if (!result?.ok) return
    const suggestions = (result.suggestions ?? []).filter((s) => kept.has(s.id)).map((s) => ({ ...s, course: course || s.course }))
    setBusy(true)
    const r = await window.briefly.acceptSyllabusSuggestions({ suggestions, termStart: result.termStart, termEnd: result.termEnd })
    setBusy(false)
    if (r.ok) onDone(r.view, `${r.added} added from the syllabus${r.skipped ? ` · ${r.skipped} already on your ledger` : ''}${r.errors.length ? ` · ${r.errors.length} failed` : ''}`)
  }

  if (!llmConfigured) {
    return (
      <div className={cn(panelCls, 'space-y-2 text-[12px]')}>
        <p>Reading a syllabus uses the AI provider. Set one up first.</p>
        <button onClick={onOpenSettings} className={primaryBtn}>
          Open Settings
        </button>
      </div>
    )
  }

  if (result?.ok) {
    const s = result.suggestions ?? []
    const toggle = (id: string): void => {
      const next = new Set(kept)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setKept(next)
    }
    return (
      <div className={cn(panelCls, 'space-y-2')}>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <label className={labelCls}>Course</label>
            <input value={course} onChange={(e) => setCourse(e.target.value)} className={inputCls} placeholder="STAT 390" />
          </div>
          <div className="pt-4 text-[11px] text-gray-500 dark:text-zinc-500">
            {result.courseName}
            {result.termStart && result.termEnd ? ` · ${result.termStart} → ${result.termEnd}` : ''}
          </div>
        </div>
        {s.length === 0 ? (
          <p className="text-[12px] text-gray-500">Nothing dated was found. Add what you know by hand.</p>
        ) : (
          <ul className="max-h-[260px] space-y-1 overflow-y-auto">
            {s.map((sg) => (
              <SuggestionRow key={sg.id} s={sg} kept={kept.has(sg.id)} onToggle={() => toggle(sg.id)} />
            ))}
          </ul>
        )}
        {(result.unresolved?.length ?? 0) > 0 && (
          <div className="text-[11px] text-gray-500 dark:text-zinc-500">
            <span className={labelCls}>Couldn’t date</span>
            <ul className="list-disc pl-4">
              {result.unresolved!.map((u, i) => (
                <li key={i}>{u}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={() => setResult(null)} className={secondaryBtn}>
            Back
          </button>
          <button onClick={() => void accept()} disabled={busy || kept.size === 0 || !course.trim()} className={primaryBtn}>
            Add {kept.size}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={cn(panelCls, 'space-y-2')}>
      <div>
        <label className={labelCls}>Course (optional hint)</label>
        <input list="school-courses-hint" value={hint} onChange={(e) => setHint(e.target.value)} placeholder="AMATH 301" className={inputCls} />
        <datalist id="school-courses-hint">
          {courses.map((c) => (
            <option key={c.course} value={c.course} />
          ))}
        </datalist>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => void run(true)} disabled={busy} className={secondaryBtn}>
          Choose PDF…
        </button>
        <span className="text-[11px] text-gray-400 dark:text-zinc-600">or paste below</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="Paste the syllabus text (schedule, exam dates, homework policy)…"
        className={cn(inputCls, 'resize-none select-text')}
      />
      {result && !result.ok && <p className="text-[11.5px] text-red-600 dark:text-red-400">{result.error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className={secondaryBtn}>
          Cancel
        </button>
        <button onClick={() => void run(false)} disabled={busy || text.trim().length < 80} className={primaryBtn}>
          {busy ? 'Reading…' : 'Read syllabus'}
        </button>
      </div>
    </div>
  )
}

function SuggestionRow({ s, kept, onToggle }: { s: SyllabusSuggestion; kept: boolean; onToggle: () => void }): React.JSX.Element {
  const when = s.type === 'item' ? `${s.due}${s.time ? ` ${clock12(s.time)}` : ''}` : `every ${WEEKDAY_LABELS[s.weekday ?? 0]}${s.time ? ` ${clock12(s.time)}` : ''}`
  return (
    <li className="flex items-start gap-2 rounded-lg px-1.5 py-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
      <input type="checkbox" checked={kept} onChange={onToggle} className="mt-0.5 accent-gray-900 dark:accent-indigo-400" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12px]">
          <span className="truncate font-medium">{s.title}</span>
          <span className="shrink-0 rounded bg-slate-100 px-1 text-[9.5px] font-semibold text-gray-600 dark:bg-white/[0.06] dark:text-zinc-400">{KIND_LABEL[s.kind]}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-gray-500 dark:text-zinc-500">{when}</span>
          {s.confidence !== 'high' && <span className="shrink-0 text-[9.5px] uppercase tracking-wide text-amber-600 dark:text-amber-400">{s.confidence}</span>}
        </div>
        {s.evidence && <div className="truncate text-[10.5px] text-gray-400 dark:text-zinc-600" title={s.evidence}>“{s.evidence}”</div>}
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Manage: rules + courses
// ---------------------------------------------------------------------------

/**
 * Logged-in LMS sessions. Connect opens the sign-in page in briefly's own browser; once you're
 * in, briefly keeps the cookies (encrypted) and reads your own course pages every few hours.
 */
function Connections({ lms, browserAvailable, feedConfigured, onChange }: { lms: LmsStatus[]; browserAvailable: boolean; feedConfigured: boolean; onChange: (v: View) => void }): React.JSX.Element {
  const [busy, setBusy] = useState<LmsKind | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const label = (k: LmsKind): string => (k === 'canvas' ? 'Canvas login' : 'Gradescope')
  const connect = async (k: LmsKind): Promise<void> => {
    setBusy(k)
    setMsg(`Sign in to ${label(k)} in the browser window that just opened. briefly is waiting (up to 5 minutes).`)
    const r = await window.briefly.connectLms(k)
    setBusy(null)
    onChange(r.view)
    setMsg(r.ok ? (r.warning ? `Connected, but the first sync said: ${r.warning}` : `${label(k)} connected and synced.`) : r.error)
  }
  const sync = async (k: LmsKind): Promise<void> => {
    setBusy(k)
    const r = await window.briefly.syncLms(k)
    setBusy(null)
    onChange(r.view)
    setMsg(r.ok ? `${label(k)}: ${r.added} new, ${r.updated} changed${r.suggested ? `, ${r.suggested} to confirm` : ''}` : r.error)
  }
  const disconnect = async (k: LmsKind): Promise<void> => {
    onChange(await window.briefly.disconnectLms(k))
    setMsg(`${label(k)} forgotten. Items it added stay on the ledger.`)
  }
  return (
    <div>
      <span className={labelCls}>Connections</span>
      <ul className="space-y-0.5">
        {lms.map((l) => {
          const canConnect = browserAvailable && (l.kind !== 'canvas' || feedConfigured)
          const why = !browserAvailable
            ? 'Needs Google Chrome or the Playwright Chromium (npx playwright install chromium).'
            : l.kind === 'canvas' && !feedConfigured
              ? 'Add the Canvas calendar feed in Settings first; it tells briefly which Canvas to sign in to.'
              : undefined
          return (
            <li key={l.kind} className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-[12px]">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', !l.connected ? 'bg-gray-300 dark:bg-zinc-600' : l.needsLogin || l.lastError ? 'bg-amber-500' : 'bg-emerald-500')} />
              <span className="w-[92px] shrink-0 font-semibold text-gray-700 dark:text-zinc-300">{label(l.kind)}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-gray-500 dark:text-zinc-500" title={l.lastError ?? undefined}>
                {!l.connected
                  ? l.kind === 'canvas'
                    ? 'submission status + announcements'
                    : 'assignments + submitted/not'
                  : l.needsLogin
                    ? 'signed out — reconnect'
                    : l.lastError
                      ? l.lastError
                      : l.lastSyncAt
                        ? `synced ${ago(l.lastSyncAt)}${l.host ? ` · ${l.host}` : ''}`
                        : 'connected'}
              </span>
              {l.connected && !l.needsLogin && (
                <IconButton title="Sync now" onClick={() => void sync(l.kind)} disabled={busy !== null} small>
                  <RefreshCw size={11} className={busy === l.kind ? 'animate-spin' : ''} />
                </IconButton>
              )}
              {l.connected && (
                <IconButton title="Forget this login" onClick={() => void disconnect(l.kind)} disabled={busy !== null} small>
                  <Trash2 size={11} />
                </IconButton>
              )}
              <button
                onClick={() => void connect(l.kind)}
                disabled={busy !== null || !canConnect}
                title={why ?? (l.connected ? 'Sign in again (e.g. after the session expired)' : 'Opens the sign-in page in briefly’s browser')}
                className="shrink-0 rounded-md border border-slate-200 px-1.5 py-0.5 text-[10.5px] font-semibold text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-white/[0.1] dark:text-zinc-200"
              >
                {busy === l.kind ? 'Waiting…' : l.connected ? 'Reconnect' : 'Connect'}
              </button>
            </li>
          )
        })}
      </ul>
      {msg && <p className="mt-1 px-1.5 text-[11px] text-gray-500 dark:text-zinc-500">{msg}</p>}
    </div>
  )
}

function ManagePanel({ data, onChange }: { data: View; onChange: (v: View) => void }): React.JSX.Element {
  const [editing, setEditing] = useState<Partial<SchoolRule> | null>(null)
  const courses = [...data.courses].sort((a, b) => a.course.localeCompare(b.course))
  return (
    <div className={cn(panelCls, 'space-y-3')}>
      <Connections lms={data.lms} browserAvailable={data.browserAvailable} feedConfigured={data.status.feedConfigured} onChange={onChange} />
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className={labelCls}>Weekly rules</span>
          {!editing && (
            <button onClick={() => setEditing({ weekday: 1, time: '23:59', kind: 'assignment', startDate: localDay(), endDate: addDays(localDay(), 77) })} className="text-[11px] font-semibold text-gray-600 hover:underline dark:text-zinc-300">
              + New rule
            </button>
          )}
        </div>
        {editing ? (
          <RuleForm initial={editing} courses={courses} onSaved={(v) => { onChange(v); setEditing(null) }} onCancel={() => setEditing(null)} />
        ) : data.rules.length === 0 ? (
          <p className="text-[11.5px] text-gray-400 dark:text-zinc-600">None yet. A rule like “STAT 390 homework every Monday 21:10” puts a deadline on the ledger each week, even when nothing is posted.</p>
        ) : (
          <ul className="space-y-0.5">
            {data.rules.map((r) => (
              <li key={r.id} className="group flex items-center gap-2 rounded-lg px-1.5 py-1 text-[12px] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
                <button
                  title={r.enabled ? 'Pause rule' : 'Resume rule'}
                  onClick={() => void window.briefly.saveSchoolRule({ ...r, enabled: !r.enabled }).then((x) => onChange(x.view))}
                  className={cn('h-2 w-2 shrink-0 rounded-full', r.enabled ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-zinc-600')}
                />
                <span className="w-[58px] shrink-0 truncate font-semibold text-gray-600 dark:text-zinc-400">{r.course}</span>
                <button onClick={() => setEditing(r)} className="min-w-0 flex-1 truncate text-left hover:underline">
                  {r.title}
                </button>
                <span className="shrink-0 text-[11px] tabular-nums text-gray-500 dark:text-zinc-500">
                  {WEEKDAY_LABELS[r.weekday]} {clock12(r.time)}
                </span>
                <IconButton title="Delete rule" onClick={() => void window.briefly.deleteSchoolRule(r.id).then(onChange)} small>
                  <Trash2 size={11} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>
      {courses.length > 0 && (
        <div>
          <span className={labelCls}>Courses</span>
          <ul className="space-y-0.5">
            {courses.map((c) => (
              <li key={c.course} className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-[12px]">
                <span className="w-[58px] shrink-0 truncate font-semibold text-gray-600 dark:text-zinc-400">{c.course}</span>
                <input
                  defaultValue={c.name === c.course ? '' : c.name}
                  placeholder="Name"
                  onBlur={(e) => e.target.value !== (c.name === c.course ? '' : c.name) && void window.briefly.setSchoolCourse(c.course, { name: e.target.value }).then(onChange)}
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[12px] outline-none focus:border-slate-200 dark:focus:border-white/[0.1]"
                />
                <label className="flex shrink-0 items-center gap-1 text-[10.5px] text-gray-500 dark:text-zinc-500" title="Show office hours and other calendar events">
                  <input type="checkbox" checked={!c.hideEvents} onChange={(e) => void window.briefly.setSchoolCourse(c.course, { hideEvents: !e.target.checked }).then(onChange)} className="accent-gray-900 dark:accent-indigo-400" />
                  events
                </label>
                <label className="flex shrink-0 items-center gap-1 text-[10.5px] text-gray-500 dark:text-zinc-500" title="Hide this course entirely">
                  <input type="checkbox" checked={c.hidden} onChange={(e) => void window.briefly.setSchoolCourse(c.course, { hidden: e.target.checked }).then(onChange)} className="accent-gray-900 dark:accent-indigo-400" />
                  hide
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function RuleForm({ initial, courses, onSaved, onCancel }: { initial: Partial<SchoolRule>; courses: SchoolCourse[]; onSaved: (v: View) => void; onCancel: () => void }): React.JSX.Element {
  const [course, setCourse] = useState(initial.course ?? courses[0]?.course ?? '')
  const [title, setTitle] = useState(initial.title ?? 'Homework {n}')
  const [kind, setKind] = useState<SchoolKind>(initial.kind ?? 'assignment')
  const [weekday, setWeekday] = useState<Weekday>(initial.weekday ?? 1)
  const [time, setTime] = useState(initial.time ?? '23:59')
  const [startDate, setStart] = useState(initial.startDate ?? localDay())
  const [endDate, setEnd] = useState(initial.endDate ?? addDays(localDay(), 77))
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    const r = await window.briefly.saveSchoolRule({ id: initial.id, course, title, kind, weekday, time, startDate, endDate, enabled: initial.enabled ?? true })
    if (r.ok) onSaved(r.view)
    else setError(r.error)
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="grid grid-cols-[1fr_1fr] gap-2">
        <div>
          <label className={labelCls}>Course</label>
          <input list="school-courses-rule" value={course} onChange={(e) => setCourse(e.target.value)} className={inputCls} placeholder="STAT 390" />
          <datalist id="school-courses-rule">
            {courses.map((c) => (
              <option key={c.course} value={c.course} />
            ))}
          </datalist>
        </div>
        <div>
          <label className={labelCls}>Title ({'{n}'} = number)</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className={labelCls}>Every</label>
          <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value) as Weekday)} className={inputCls}>
            {WEEKDAY_LABELS.map((l, i) => (
              <option key={l} value={i}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>At</label>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Kind</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as SchoolKind)} className={inputCls}>
            {SCHOOL_KINDS.filter((k) => k !== 'event').map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>From</label>
          <input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Until</label>
          <input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
        </div>
      </div>
      {error && <p className="text-[11.5px] text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={secondaryBtn}>
          Cancel
        </button>
        <button type="submit" className={primaryBtn}>
          Save rule
        </button>
      </div>
    </form>
  )
}
