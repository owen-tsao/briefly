import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Clipboard, ExternalLink, ListPlus, RefreshCw, Rocket, Search, Sparkles, X } from 'lucide-react'
import type { JobRow, JobStatus, JobsView as JobsViewData } from '../../../shared/jobs'
import { JOB_STATUS_LABELS, OUTCOME_STATUSES } from '../../../shared/jobs'
import { cn, relativeTime } from '@/lib/utils'
import { rankPicks, type Pick } from '@/lib/picks'
import { ActionButton, MetaMenu } from '@/components/primitives'

type Section = 'new' | 'progress' | 'applied' | 'hidden'

const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: 'new', label: 'New', hint: 'Scored apply or flagged, nothing done yet' },
  { id: 'progress', label: 'In progress', hint: 'Saved or applying' },
  { id: 'applied', label: 'Applied', hint: 'Submitted — track the outcome here' },
  { id: 'hidden', label: 'Hidden', hint: 'Skipped by you or by the matcher' }
]

function sectionOf(row: JobRow): Section | 'queue' {
  const status = row.state?.status ?? 'new'
  if (status === 'saved' || status === 'applying') return 'progress'
  if (OUTCOME_STATUSES.includes(status)) return 'applied'
  if (status === 'skipped') return 'hidden'
  // Untouched and no longer listed anywhere: nothing to act on, so it leaves New.
  if (row.item && !row.item.active) return 'hidden'
  if (row.item && !row.item.verdict) return 'queue'
  if (row.item?.verdict?.decision === 'skip') return 'hidden'
  return 'new'
}

const STATUS_DOT: Record<JobStatus, string> = {
  new: 'bg-slate-400',
  saved: 'bg-sky-400',
  applying: 'bg-amber-400',
  applied: 'bg-emerald-500',
  oa: 'bg-violet-400',
  interview: 'bg-fuchsia-400',
  offer: 'bg-emerald-400',
  rejected: 'bg-rose-400',
  skipped: 'bg-slate-300 dark:bg-zinc-600'
}

const STATUS_OPTIONS = (Object.keys(JOB_STATUS_LABELS) as JobStatus[]).map((id) => ({
  id,
  label: JOB_STATUS_LABELS[id],
  dot: STATUS_DOT[id]
}))

interface Props {
  hasApiKey: boolean
  onOpenSettings: () => void
  onTasksChanged: () => void
}

export function JobsView({ hasApiKey, onOpenSettings, onTasksChanged }: Props): React.JSX.Element {
  const [data, setData] = useState<JobsViewData | null>(null)
  const [query, setQuery] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  /** Sticky until dismissed — the OS notification is easy to miss and the clipboard is invisible. */
  const [applied, setApplied] = useState<{ id: string; company: string; via: 'cli' | 'clipboard' } | null>(null)
  const [openSections, setOpenSections] = useState<Record<Section, boolean>>({
    new: true,
    progress: true,
    applied: true,
    hidden: false
  })

  useEffect(() => {
    window.briefly.getJobs().then(setData)
    return window.briefly.onJobsChanged(setData)
  }, [])

  const setStatus = async (id: string, status: JobStatus): Promise<void> => {
    setData(await window.briefly.setJobStatus(id, status))
  }
  const setNote = async (id: string, note: string): Promise<void> => {
    setData(await window.briefly.setJobNote(id, note))
  }
  const promote = async (id: string): Promise<void> => {
    setData(await window.briefly.promoteJob(id))
    onTasksChanged()
  }
  const unpromote = async (id: string): Promise<void> => {
    setData(await window.briefly.unpromoteJob(id))
    onTasksChanged()
  }
  const apply = async (id: string): Promise<void> => {
    const r = await window.briefly.applyJob(id)
    setData(r.view)
    const row = r.view.rows.find((x) => x.id === id)
    if (r.via) setApplied({ id, company: row?.item?.company ?? row?.state?.snapshot.company ?? 'Posting', via: r.via })
  }
  const copyPrompt = async (id: string): Promise<void> => {
    const ok = await window.briefly.copyJobPrompt(id)
    setScanMsg(ok ? 'Prompt copied — paste into Aside with ⌘V' : 'Could not build the prompt')
    setTimeout(() => setScanMsg(null), 6000)
  }
  const scanNow = async (): Promise<void> => {
    setScanning(true)
    setScanMsg(null)
    try {
      const r = await window.briefly.scanJobsNow()
      setData(r.view)
      setScanMsg(
        r.errors.length
          ? `${r.added} new · ${r.errors.length} source error${r.errors.length === 1 ? '' : 's'}`
          : r.view.unscored > 0
            ? `${r.added} new · scoring ${r.view.unscored} in the background`
            : `${r.added} new · all scored`
      )
    } finally {
      setScanning(false)
      setTimeout(() => setScanMsg(null), 6000)
    }
  }

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out: Record<Section, JobRow[]> & { queue: JobRow[] } = { new: [], progress: [], applied: [], hidden: [], queue: [] }
    if (!data) return out
    for (const row of data.rows) {
      const company = row.item?.company ?? row.state?.snapshot.company ?? ''
      const title = row.item?.title ?? row.state?.snapshot.title ?? ''
      if (q && !`${company} ${title}`.toLowerCase().includes(q)) continue
      out[sectionOf(row)].push(row)
    }
    const key = (r: JobRow): string => r.state?.updatedAt ?? r.item?.postedAt ?? r.item?.seenAt ?? ''
    for (const s of Object.keys(out) as (Section | 'queue')[]) {
      if (s === 'new') {
        // Apply verdicts first, then newest.
        out[s].sort((a, b) => {
          const av = a.item?.verdict?.decision === 'apply' ? 0 : 1
          const bv = b.item?.verdict?.decision === 'apply' ? 0 : 1
          return av - bv || key(b).localeCompare(key(a))
        })
      } else {
        out[s].sort((a, b) => key(b).localeCompare(key(a)))
      }
    }
    return out
  }, [data, query])

  const picks = useMemo(() => (data ? rankPicks(data.rows, data.watchlist ?? []) : []), [data])

  if (!data) return <div className="p-4 text-xs text-gray-400">Loading…</div>

  const total = data.rows.length
  const profileTouched = data.profile.some(
    (f) => f.exists && f.modifiedAt && Date.now() - new Date(f.modifiedAt).getTime() > 60_000
  )

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] focus-within:border-gray-400 dark:border-white/[0.08] dark:bg-ink-900 dark:focus-within:border-accent">
          <Search size={13} className="shrink-0 text-gray-400 dark:text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search company or role"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-gray-400 dark:placeholder:text-zinc-500"
          />
        </label>
        <button
          onClick={scanNow}
          disabled={scanning}
          title="Scan sources now"
          className={cn(
            'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold shadow-sm transition-all active:scale-[0.97]',
            'border-slate-200 bg-white text-gray-700 hover:border-slate-300 dark:border-white/[0.1] dark:bg-ink-800 dark:text-zinc-200 dark:hover:border-white/20',
            scanning && 'opacity-60'
          )}
        >
          <RefreshCw size={12} className={cn(scanning && 'animate-spin')} />
          Scan
        </button>
      </div>

      <div className="flex items-center justify-between text-[11px] text-gray-400 dark:text-zinc-500">
        <span>
          {scanMsg ??
            (data.lastScanAt ? `Last scan ${relativeTime(data.lastScanAt)}` : 'No scan yet')}
        </span>
        <span>
          {total} posting{total === 1 ? '' : 's'}
          {data.unscored > 0 && (
            <span title="Scored a batch at a time, watchlist companies first. Hit Scan to score more now.">
              {' '}· {data.unscored} queued{query && grouped.queue.length !== data.unscored ? ` (${grouped.queue.length} match)` : ''}
            </span>
          )}
        </span>
      </div>

      {applied && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11.5px] leading-relaxed text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-950/30 dark:text-emerald-200">
          <span className="min-w-0 flex-1">
            {applied.via === 'cli' ? (
              <>Aside is working on <b>{applied.company}</b>. Review before you submit.</>
            ) : (
              <>
                <b>{applied.company}</b> opened in Aside. The prompt is on your clipboard — click Aside's agent
                box and press <kbd className="rounded bg-white/70 px-1 font-mono dark:bg-white/10">⌘V</kbd>.
              </>
            )}
          </span>
          {applied.via === 'clipboard' && (
            <button
              onClick={() => copyPrompt(applied.id)}
              className="shrink-0 rounded-md border border-emerald-300 px-2 py-0.5 text-[11px] font-semibold hover:bg-emerald-100 dark:border-emerald-500/40 dark:hover:bg-emerald-500/10"
            >
              Copy again
            </button>
          )}
          <button onClick={() => setApplied(null)} className="shrink-0 text-emerald-700/70 hover:text-emerald-900 dark:text-emerald-300/70" title="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}

      {!hasApiKey && (
        <Notice>
          Add an API key in{' '}
          <button onClick={onOpenSettings} className="font-semibold underline decoration-dotted">
            Settings
          </button>{' '}
          so new postings can be scored against your profile.
        </Notice>
      )}

      {data.lastErrors.length > 0 && (
        <Notice>
          Last scan had {data.lastErrors.length} problem{data.lastErrors.length === 1 ? '' : 's'}:{' '}
          <span className="select-text break-words">{data.lastErrors[0]}</span>
        </Notice>
      )}

      {total === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 p-5 text-center dark:border-white/[0.12]">
          <Sparkles size={18} className="mx-auto mb-2 text-gray-400 dark:text-zinc-500" />
          <p className="text-[13px] font-semibold">No postings yet</p>
          <p className="mx-auto mt-1 max-w-[280px] text-[11.5px] leading-relaxed text-gray-500 dark:text-zinc-400">
            {profileTouched
              ? 'Hit Scan to pull your watchlist boards and the public internship feeds.'
              : 'Fill in your profile first — resume, preferences, and a watchlist of companies — then Scan.'}
          </p>
          <div className="mt-3 flex justify-center gap-2">
            <button
              onClick={() => window.briefly.openProfile('watchlist.md')}
              className="rounded-lg bg-gray-900 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-gray-700 dark:bg-accent dark:hover:bg-accent-hover"
            >
              Open watchlist.md
            </button>
            <button
              onClick={onOpenSettings}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-gray-700 transition hover:border-slate-300 dark:border-white/[0.1] dark:bg-ink-800 dark:text-zinc-200"
            >
              Profile files
            </button>
          </div>
        </div>
      )}

      {picks.length > 0 && !query && (
        <TopPicks picks={picks} onApply={apply} onSkip={(id) => setStatus(id, 'skipped')} />
      )}

      {SECTIONS.map((s) => {
        const rows = grouped[s.id]
        if (rows.length === 0 && s.id !== 'new') return null
        if (rows.length === 0 && total === 0) return null
        const open = openSections[s.id]
        return (
          <section key={s.id}>
            <button
              onClick={() => setOpenSections((o) => ({ ...o, [s.id]: !o[s.id] }))}
              className="group mb-1.5 flex w-full items-center gap-1.5 text-left"
            >
              <ChevronRight
                size={12}
                className={cn(
                  'text-gray-400 transition-transform dark:text-zinc-500',
                  open && 'rotate-90'
                )}
              />
              <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-gray-500 dark:text-zinc-400">
                {s.label}
              </span>
              <span className="text-[11px] tabular-nums text-gray-400 dark:text-zinc-600">
                {rows.length}
              </span>
              <span className="ml-auto hidden text-[10.5px] text-gray-400 group-hover:inline dark:text-zinc-600">
                {s.hint}
              </span>
            </button>
            {open && rows.length === 0 && (
              <p className="pl-5 text-[11.5px] text-gray-400 dark:text-zinc-500">
                {data.unscored > 0
                  ? `Nothing scored yet — ${data.unscored} waiting. Scan to score a batch now.`
                  : 'Nothing new. Scans run every 15 minutes while briefly is open.'}
              </p>
            )}
            {open && (
              <div className="space-y-1.5">
                {rows.map((row) => (
                  <JobCard
                    key={row.id}
                    row={row}
                    section={s.id}
                    onStatus={setStatus}
                    onNote={setNote}
                    onPromote={promote}
                    onUnpromote={unpromote}
                    onApply={apply}
                    onCopyPrompt={copyPrompt}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

/**
 * The "should I apply to something right now" glance: the three strongest untouched apply
 * verdicts, with Apply as the primary action instead of hidden behind hover.
 */
function TopPicks({
  picks,
  onApply,
  onSkip
}: {
  picks: Pick[]
  onApply: (id: string) => void
  onSkip: (id: string) => void
}): React.JSX.Element {
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 dark:border-white/[0.1] dark:bg-white/[0.03]">
      <div className="mb-2 flex items-center gap-1.5 px-0.5">
        <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-gray-600 dark:text-zinc-300">
          Top picks
        </span>
        <span className="ml-auto text-[10.5px] text-gray-400 dark:text-zinc-500">
          referral · watchlist · pay · fresh
        </span>
      </div>
      <div className="space-y-1.5">
        {picks.map(({ row, why }) => {
          const it = row.item!
          return (
            <div
              key={row.id}
              className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] dark:border-white/[0.08] dark:bg-ink-900"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate text-[12.5px] font-semibold">{it.company}</span>
                  {it.dcLink && <Chip tone="teal">DC</Chip>}
                  {it.pay && <Chip tone="neutral">{it.pay}</Chip>}
                </div>
                <div className="truncate text-[11.5px] text-gray-600 dark:text-zinc-300">{it.title}</div>
                <div className="mt-0.5 truncate text-[10.5px] text-gray-400 dark:text-zinc-500">
                  {[...why, it.location].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <ActionButton title="Open posting" onClick={() => window.briefly.openUrl(it.url)}>
                  <ExternalLink size={12} />
                </ActionButton>
                <ActionButton title="Not for me — skip" onClick={() => onSkip(row.id)}>
                  <X size={12} />
                </ActionButton>
                <button
                  onClick={() => onApply(row.id)}
                  title="Apply with Aside — fills the form, never submits"
                  className="flex items-center gap-1 rounded-md bg-gray-900 px-2 py-1 text-[11px] font-semibold text-white shadow-sm transition-all hover:bg-gray-700 active:scale-95 dark:bg-accent dark:hover:bg-accent-hover"
                >
                  <Rocket size={11} />
                  Apply
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800 dark:border-amber-500/25 dark:bg-amber-950/30 dark:text-amber-300">
      {children}
    </div>
  )
}

function JobCard({
  row,
  section,
  onStatus,
  onNote,
  onPromote,
  onUnpromote,
  onApply,
  onCopyPrompt
}: {
  row: JobRow
  section: Section
  onStatus: (id: string, status: JobStatus) => void
  onNote: (id: string, note: string) => void
  onPromote: (id: string) => void
  onUnpromote: (id: string) => void
  onApply: (id: string) => void
  onCopyPrompt: (id: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [note, setNoteDraft] = useState(row.state?.note ?? '')
  useEffect(() => setNoteDraft(row.state?.note ?? ''), [row.state?.note])

  const item = row.item
  const snap = row.state?.snapshot
  const company = item?.company ?? snap?.company ?? 'Unknown'
  const title = item?.title ?? snap?.title ?? ''
  const url = item?.url ?? snap?.url ?? null
  const status = row.state?.status ?? 'new'
  const verdict = item?.verdict ?? null
  const pruned = !item
  const stale = item && !item.active

  const options = section === 'applied' ? STATUS_OPTIONS.filter((o) => OUTCOME_STATUSES.includes(o.id)) : STATUS_OPTIONS

  return (
    <div
      className={cn(
        'group rounded-xl border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors dark:bg-ink-900',
        'border-slate-200 hover:border-slate-300 dark:border-white/[0.08] dark:hover:border-white/[0.16]',
        (pruned || stale) && 'opacity-70'
      )}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-[3px] shrink-0 text-gray-400 transition-transform dark:text-zinc-500"
          title={expanded ? 'Collapse' : 'Details'}
        >
          <ChevronRight size={13} className={cn('transition-transform', expanded && 'rotate-90')} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[13px] font-semibold">{company}</span>
            {item?.dcLink && <Chip tone="teal">DC</Chip>}
            {item?.pay && <Chip tone="neutral">{item.pay}</Chip>}
            {verdict && section === 'new' && (
              <Chip tone={verdict.decision === 'apply' ? 'emerald' : 'amber'}>
                {verdict.decision === 'apply' ? 'apply' : 'flagged'}
              </Chip>
            )}
            {item && !item.verdict && <Chip tone="neutral">unscored</Chip>}
          </div>
          <div className="truncate text-[12px] text-gray-600 dark:text-zinc-300">{title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-gray-400 dark:text-zinc-500">
            <MetaMenu
              title="Status"
              display={
                <>
                  <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[status])} />
                  {JOB_STATUS_LABELS[status]}
                </>
              }
              options={options}
              selected={status}
              onSelect={(id) => onStatus(row.id, id as JobStatus)}
            />
            {item?.location && <span>{item.location}</span>}
            {item?.deadline && <span>due {item.deadline}</span>}
            {item?.postedAt && <span>posted {relativeTime(item.postedAt)}</span>}
            {item && (
              <span className="text-gray-300 dark:text-zinc-600">
                {[item.source, ...item.alsoSeenIn].join(' · ')}
              </span>
            )}
            {pruned && <span className="italic">posting removed</span>}
            {stale && <span className="italic">no longer listed</span>}
            {status === 'applying' && row.state?.openedInAsideAt && (
              <span className="text-amber-600 dark:text-amber-400">
                in Aside since {relativeTime(row.state.openedInAsideAt)}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {status === 'applying' && (
            <>
              <ActionButton title="Copy the Aside prompt again" onClick={() => onCopyPrompt(row.id)}>
                <Clipboard size={12} />
              </ActionButton>
              <button
                onClick={() => onStatus(row.id, 'applied')}
                className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white shadow-sm transition-all hover:bg-emerald-500 active:scale-95 dark:bg-emerald-500/90 dark:hover:bg-emerald-400"
              >
                Mark applied
              </button>
            </>
          )}
          {item && !stale && (section === 'new' || status === 'saved') && (
            <ActionButton title="Apply with Aside — fills the form, never submits" onClick={() => onApply(row.id)}>
              <Rocket size={12} />
            </ActionButton>
          )}
          {url && (
            <ActionButton title="Open posting" onClick={() => window.briefly.openUrl(url)}>
              <ExternalLink size={12} />
            </ActionButton>
          )}
          {item && !row.state?.promotedTaskId && (
            <ActionButton title="Add to Today" onClick={() => onPromote(row.id)}>
              <ListPlus size={12} />
            </ActionButton>
          )}
          {row.state?.promotedTaskId && (
            <ActionButton title="On your board — click to remove" onClick={() => onUnpromote(row.id)} active>
              <ListPlus size={12} />
            </ActionButton>
          )}
        </div>
      </div>

      {expanded && (
        <div className="space-y-2 border-t border-slate-100 px-3 py-2.5 text-[11.5px] leading-relaxed dark:border-white/[0.06]">
          {verdict ? (
            <>
              <p className="text-gray-700 dark:text-zinc-200">{verdict.summary}</p>
              {verdict.blockers.length > 0 && (
                <List label="Blockers" items={verdict.blockers} tone="text-rose-600 dark:text-rose-400" />
              )}
              {verdict.flags.length > 0 && (
                <List label="Flags" items={verdict.flags} tone="text-amber-700 dark:text-amber-400" />
              )}
              {verdict.matched.length > 0 && <List label="Matched" items={verdict.matched} />}
              {verdict.missing.length > 0 && <List label="Missing" items={verdict.missing} />}
            </>
          ) : item ? (
            <p className="text-gray-400 dark:text-zinc-500">
              {item.descriptionAvailable
                ? 'Not scored yet — runs on the next scan.'
                : 'Posting text could not be read, so this is triage-only. Open it to judge.'}
            </p>
          ) : (
            <p className="text-gray-400 dark:text-zinc-500">
              This posting is no longer in any feed. Kept for your history.
            </p>
          )}
          {item?.referralNote && (
            <p className="text-gray-500 dark:text-zinc-400">Note from source: {item.referralNote}</p>
          )}
          <textarea
            value={note}
            onChange={(e) => setNoteDraft(e.target.value)}
            onBlur={() => note !== (row.state?.note ?? '') && onNote(row.id, note)}
            placeholder="Your note — recruiter name, referral, next step…"
            rows={2}
            className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-1.5 text-[11.5px] outline-none transition focus:border-gray-400 dark:border-white/[0.08] dark:bg-ink-800 dark:focus:border-accent"
          />
        </div>
      )}
    </div>
  )
}

function Chip({
  tone,
  children
}: {
  tone: 'teal' | 'emerald' | 'amber' | 'neutral'
  children: React.ReactNode
}): React.JSX.Element {
  const tones = {
    teal: 'bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300',
    emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
    neutral: 'bg-slate-100 text-gray-600 dark:bg-white/[0.06] dark:text-zinc-400'
  }
  return (
    <span className={cn('shrink-0 rounded px-1.5 py-px text-[10px] font-semibold', tones[tone])}>
      {children}
    </span>
  )
}

function List({
  label,
  items,
  tone
}: {
  label: string
  items: string[]
  tone?: string
}): React.JSX.Element {
  return (
    <div>
      <span className={cn('text-[10px] font-bold uppercase tracking-[0.08em] text-gray-400 dark:text-zinc-500')}>
        {label}
      </span>
      <ul className={cn('mt-0.5 list-disc space-y-0.5 pl-4 text-gray-600 dark:text-zinc-300', tone)}>
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  )
}
