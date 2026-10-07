import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, Clipboard, ClipboardPaste, Download, ExternalLink, Link2, RefreshCw, Rocket, Search, Sparkles, X } from 'lucide-react'
import type { JobRow, JobStatus, JobsView as JobsViewData } from '../../../shared/jobs'
import { isPasted, JOB_STATUS_LABELS, OUTCOME_STATUSES, TRACKED_STATUSES } from '../../../shared/jobs'
import { localDay } from '../../../shared/dates'
import { cn, relativeTime } from '@/lib/utils'
import { rankApplyNow, type Pick } from '@/lib/picks'
import { ActionButton, MetaMenu } from '@/components/primitives'

type Section = 'review' | 'eligible' | 'progress' | 'applied' | 'flagged' | 'hidden'

/** Apply-now rows shown before "Show all". */
const NOW_PREVIEW = 8

const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: 'review', label: 'Review queue', hint: 'Forms briefly filled in its browser. Read the yellow drafts, then press Submit yourself' },
  { id: 'eligible', label: 'Also eligible', hint: 'Passed the screen but no strong signal: not a tiered company, no stated pay, not somewhere you\u2019ve applied' },
  { id: 'progress', label: 'In progress', hint: 'Saved, or applying through Aside' },
  { id: 'applied', label: 'Applied', hint: 'Submitted — track the outcome here' },
  { id: 'flagged', label: 'Flagged', hint: 'The matcher was unsure — worth a look if you have time' },
  { id: 'hidden', label: 'Hidden', hint: 'Skipped by you or by the matcher' }
]

/** Bucket for everything that isn't in Apply now. `now` rows are decided first by the caller. */
function sectionOf(row: JobRow): Section | 'queue' {
  const status = row.state?.status ?? 'new'
  if (status === 'applying' && row.state?.prepared) return 'review'
  if (status === 'saved' || status === 'applying') return 'progress'
  if (OUTCOME_STATUSES.includes(status)) return 'applied'
  if (status === 'skipped') return 'hidden'
  const it = row.item
  if (!it) return 'hidden'
  // Untouched and no longer listed anywhere: nothing to act on.
  if (!it.active) return 'hidden'
  // A link you pasted is there to be acted on: it shows as a card while the verdict is pending,
  // and a matcher "skip" only demotes it to Flagged (with the reason) rather than hiding it.
  const pasted = isPasted(it)
  if (!it.verdict) return pasted ? 'eligible' : 'queue'
  if (it.verdict.decision === 'skip') return pasted ? 'flagged' : 'hidden'
  if (it.verdict.decision === 'flagged') return 'flagged'
  return 'eligible'
}

const LINK_RE = /^\s*https?:\/\/\S+/i

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
  /** Kept for App's wiring; nothing in Jobs writes to the task board any more. */
  onTasksChanged?: () => void
}

export function JobsView({ hasApiKey, onOpenSettings }: Props): React.JSX.Element {
  const [data, setData] = useState<JobsViewData | null>(null)
  const [mode, setMode] = useState<'shortlist' | 'tracker'>('shortlist')
  const [query, setQuery] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  /** Sticky until dismissed — the OS notification is easy to miss and the clipboard is invisible. */
  const [applied, setApplied] = useState<{ id: string; company: string; via: 'cli' | 'clipboard' | 'browser' } | null>(null)
  const [openSections, setOpenSections] = useState<Record<Section, boolean>>({
    review: true,
    eligible: false,
    progress: true,
    applied: true,
    flagged: false,
    hidden: false
  })
  const [showAllNow, setShowAllNow] = useState(false)
  /** Card whose hand-off is in flight; starting Aside or the browser from cold can take ~10s. */
  const [applyingId, setApplyingId] = useState<string | null>(null)
  /** "Prepare top N" batch in flight: the browser fills one form after another. */
  const [preparing, setPreparing] = useState(false)
  /** Card to draw the eye to for a moment after a paste; cleared on its own. */
  const [justAdded, setJustAdded] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const queryIsLink = LINK_RE.test(query)
  /** What actually filters the lists: a pasted URL is an add, not a search. */
  const search = queryIsLink ? '' : query.trim().toLowerCase()

  useEffect(() => {
    if (!justAdded) return
    const t = setTimeout(() => setJustAdded(null), 4000)
    return () => clearTimeout(t)
  }, [justAdded])

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
  const flash = (msg: string, ms = 6000): void => {
    setScanMsg(msg)
    setTimeout(() => setScanMsg(null), ms)
  }
  const apply = async (id: string): Promise<void> => {
    if (applyingId || preparing) return
    setApplyingId(id)
    try {
      const r = await window.briefly.applyJob(id)
      setData(r.view)
      const row = r.view.rows.find((x) => x.id === id)
      if (r.via) setApplied({ id, company: row?.item?.company ?? row?.state?.snapshot.company ?? 'Posting', via: r.via })
      else if (r.error) flash(r.error, 10_000)
    } finally {
      setApplyingId(null)
    }
  }
  /** Aside instead of the browser — for a form the filler could not handle. */
  const useAside = async (id: string): Promise<void> => {
    if (applyingId) return
    setApplyingId(id)
    try {
      const r = await window.briefly.applyJobWithAside(id)
      setData(r.view)
      const row = r.view.rows.find((x) => x.id === id)
      if (r.via) setApplied({ id, company: row?.item?.company ?? row?.state?.snapshot.company ?? 'Posting', via: r.via })
    } finally {
      setApplyingId(null)
    }
  }
  /** Bring the prepared tab forward; if it is gone, start the fill again. */
  const focusTab = async (id: string): Promise<void> => {
    const ok = await window.briefly.focusPreparedJob(id)
    if (!ok) await apply(id)
  }
  const prepareTop = async (ids: string[], limit: number): Promise<void> => {
    if (applyingId || preparing || ids.length === 0) return
    setPreparing(true)
    try {
      const r = await window.briefly.prepareJobs(ids, limit)
      setData(r.view)
      if (r.error) flash(r.error, 10_000)
      else {
        setOpenSections((o) => ({ ...o, review: true }))
        flash(
          r.started === 0
            ? 'None of the top Apply-now cards use a system briefly can fill — use Apply on each instead'
            : `${r.started} form${r.started === 1 ? '' : 's'} ready in the browser${r.skipped ? ` · ${r.skipped} skipped (unsupported system)` : ''}`,
          10_000
        )
      }
    } finally {
      setPreparing(false)
    }
  }
  const copyPrompt = async (id: string): Promise<void> => {
    const ok = await window.briefly.copyJobPrompt(id)
    flash(ok ? 'Prompt copied — paste into Aside with ⌘V' : 'Could not build the prompt')
  }
  const scoreAnyway = async (id: string): Promise<void> => {
    setData(await window.briefly.scoreJobAnyway(id))
    setScanMsg('Sent to the LLM — verdict lands within a minute')
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
  const exportCsv = async (): Promise<void> => {
    const path = await window.briefly.exportJobsCsv()
    setScanMsg(path ? `Saved ${path.split('/').pop()} to Downloads` : 'Export failed')
    setTimeout(() => setScanMsg(null), 6000)
  }
  const importClipboard = async (): Promise<void> => {
    const r = await window.briefly.importJobsClipboard()
    setData(r.view)
    setScanMsg(
      r.parsed === 0
        ? 'Clipboard has no MyGreenhouse applications — select all on my.greenhouse.io/applications, copy, try again'
        : `Imported ${r.parsed}: ${r.matched} matched existing postings, ${r.created} new rows, ${r.skipped} already tracked`
    )
    setTimeout(() => setScanMsg(null), 10_000)
  }
  /** The search box doubles as the paste target: a URL there becomes a card. */
  const addLink = async (): Promise<void> => {
    if (!queryIsLink || adding) return
    setAdding(true)
    try {
      const r = await window.briefly.addJobLink(query)
      setData(r.view)
      if (r.error || !r.id) {
        setScanMsg(r.error ?? 'Could not add that link')
        setTimeout(() => setScanMsg(null), 6000)
        return
      }
      setQuery('')
      setMode('shortlist')
      setJustAdded(r.id)
      const row = r.view.rows.find((x) => x.id === r.id)
      const sec = row ? sectionOf(row) : 'eligible'
      if (sec !== 'queue') setOpenSections((o) => ({ ...o, [sec]: true }))
      setScanMsg(
        r.existed
          ? 'Already on the board — brought it back up'
          : hasApiKey
            ? 'Added — screening in the background, Apply is ready now'
            : 'Added — Apply is ready now (no API key, so it will not be screened)'
      )
      setTimeout(() => setScanMsg(null), 8000)
    } finally {
      setAdding(false)
    }
  }

  const tracked = useMemo(() => {
    if (!data) return []
    const q = search
    return data.rows
      .filter((r) => r.state && TRACKED_STATUSES.includes(r.state.status))
      .filter((r) => {
        if (!q) return true
        const company = r.item?.company ?? r.state?.snapshot.company ?? ''
        const title = r.item?.title ?? r.state?.snapshot.title ?? ''
        return `${company} ${title}`.toLowerCase().includes(q)
      })
      .sort((a, b) => {
        const ka = a.state?.appliedAt ?? a.state?.updatedAt ?? ''
        const kb = b.state?.appliedAt ?? b.state?.updatedAt ?? ''
        return kb.localeCompare(ka)
      })
  }, [data, search])

  const signals = useMemo(
    () =>
      data
        ? {
            tier1: data.tier1 ?? [],
            tier2: data.tier2 ?? [],
            watchlist: data.watchlist ?? [],
            appliedCompanies: data.appliedCompanies ?? [],
            payFloor: data.payFloor ?? 50
          }
        : null,
    [data]
  )

  const picks = useMemo(() => (data && signals ? rankApplyNow(data.rows, signals) : []), [data, signals])

  const grouped = useMemo(() => {
    const q = search
    const out: Record<Section, JobRow[]> & { queue: JobRow[] } = {
      review: [],
      eligible: [],
      progress: [],
      applied: [],
      flagged: [],
      hidden: [],
      queue: []
    }
    if (!data) return out
    const inNow = new Set(picks.map((p) => p.row.id))
    for (const row of data.rows) {
      const company = row.item?.company ?? row.state?.snapshot.company ?? ''
      const title = row.item?.title ?? row.state?.snapshot.title ?? ''
      if (q && !`${company} ${title}`.toLowerCase().includes(q)) continue
      if (inNow.has(row.id)) continue
      out[sectionOf(row)].push(row)
    }
    const key = (r: JobRow): string => r.state?.updatedAt ?? r.item?.postedAt ?? r.item?.seenAt ?? ''
    const posted = (r: JobRow): string => r.item?.postedAt ?? r.item?.seenAt ?? ''
    for (const s of Object.keys(out) as (Section | 'queue')[]) {
      if (s === 'eligible' || s === 'flagged') {
        out[s].sort((a, b) => posted(b).localeCompare(posted(a)))
      } else {
        out[s].sort((a, b) => key(b).localeCompare(key(a)))
      }
    }
    return out
  }, [data, search, picks])

  /** Apply-now rows that match the search, so the box stays useful while filtering. */
  const shownPicks = useMemo(() => {
    const q = search
    if (!q) return picks
    return picks.filter(({ row }) => `${row.item?.company ?? ''} ${row.item?.title ?? ''}`.toLowerCase().includes(q))
  }, [picks, search])

  if (!data) return <div className="p-4 text-xs text-gray-400">Loading…</div>

  const total = data.rows.length
  const trackedTotal = data.rows.filter((r) => r.state && TRACKED_STATUSES.includes(r.state.status)).length
  const profileTouched = data.profile.some(
    (f) => f.exists && f.modifiedAt && Date.now() - new Date(f.modifiedAt).getTime() > 60_000
  )

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)] focus-within:border-gray-400 dark:border-white/[0.08] dark:bg-ink-900 dark:focus-within:border-accent">
          {queryIsLink ? (
            <Link2 size={13} className="shrink-0 text-gray-500 dark:text-zinc-400" />
          ) : (
            <Search size={13} className="shrink-0 text-gray-400 dark:text-zinc-500" />
          )}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && queryIsLink) {
                e.preventDefault()
                void addLink()
              }
              if (e.key === 'Escape') setQuery('')
            }}
            placeholder="Search, or paste a posting link"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-gray-400 dark:placeholder:text-zinc-500"
          />
          {queryIsLink && (
            <button
              onClick={addLink}
              disabled={adding}
              title="Add this posting as a card you can apply from (Enter)"
              className={cn(
                'shrink-0 rounded-md bg-gray-900 px-2 py-0.5 text-[11px] font-semibold text-white transition hover:bg-gray-700 dark:bg-accent dark:hover:bg-accent-hover',
                adding && 'opacity-60'
              )}
            >
              {adding ? 'Adding…' : 'Add posting'}
            </button>
          )}
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

      <div className="flex items-center justify-between gap-2 text-[11px] text-gray-400 dark:text-zinc-500">
        <div className="flex shrink-0 rounded-md bg-slate-200/60 p-0.5 dark:bg-ink-800">
          {(
            [
              { id: 'shortlist', label: 'Shortlist' },
              { id: 'tracker', label: `Tracker · ${trackedTotal}` }
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] font-semibold tabular-nums transition-all',
                mode === m.id
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-ink-700 dark:text-zinc-100'
                  : 'text-slate-500 hover:text-slate-800 dark:text-zinc-500 dark:hover:text-zinc-300'
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="min-w-0 truncate text-right">
          {scanMsg ??
            (mode === 'tracker' ? (
              <>{trackedTotal} tracked</>
            ) : (
              <>
                {data.lastScanAt ? `Last scan ${relativeTime(data.lastScanAt)}` : 'No scan yet'} · {total} posting
                {total === 1 ? '' : 's'}
                {data.unscored > 0 && (
                  <span title="Scored a few at a time in the background, Apply-now companies and the newest arrivals first. Hit Scan to score more now.">
                    {' '}· {data.unscored} queued{search && grouped.queue.length !== data.unscored ? ` (${grouped.queue.length} match)` : ''}
                  </span>
                )}
              </>
            ))}
        </span>
      </div>

      {applied && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11.5px] leading-relaxed text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-950/30 dark:text-emerald-200">
          <span className="min-w-0 flex-1">
            {applied.via === 'browser' ? (
              <>
                briefly's browser is filling <b>{applied.company}</b>. Green fields came from your profile, yellow ones are
                drafts — read those. You press Submit; the card moves to Applied when the confirmation shows.
              </>
            ) : applied.via === 'cli' ? (
              <>Aside is working on <b>{applied.company}</b>. Review before you submit.</>
            ) : (
              <>
                Aside could not be started automatically. <b>{applied.company}</b> is open in Aside and the prompt is on your
                clipboard — nothing runs until you click Aside's agent box and press{' '}
                <kbd className="rounded bg-white/70 px-1 font-mono dark:bg-white/10">⌘V</kbd>.
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

      {mode === 'tracker' && (
        <Tracker
          rows={tracked}
          onStatus={setStatus}
          onNote={setNote}
          onExport={exportCsv}
          onImport={importClipboard}
          filtered={Boolean(search)}
        />
      )}

      {mode === 'shortlist' && total === 0 && (
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

      {mode === 'shortlist' && total > 0 && (
        <ApplyNow
          picks={shownPicks}
          total={picks.length}
          showAll={showAllNow || Boolean(search)}
          searching={Boolean(search)}
          applyingId={applyingId}
          preparing={preparing}
          onToggleAll={() => setShowAllNow((v) => !v)}
          onApply={apply}
          onPrepareTop={(n) => prepareTop(picks.filter((p) => p.row.item?.kind !== 'event').map((p) => p.row.id), n)}
          onSkip={(id) => setStatus(id, 'skipped')}
          onApplied={(id) => setStatus(id, 'applied')}
          onOpenRules={() => window.briefly.openProfile('rules.md')}
        />
      )}

      {mode === 'shortlist' &&
        SECTIONS.map((s) => {
        const rows = grouped[s.id]
        if (rows.length === 0 && s.id !== 'eligible') return null
        if (rows.length === 0 && total === 0) return null
        const open = openSections[s.id]
        return (
          <section key={s.id}>
            <button
              onClick={() => setOpenSections((o) => ({ ...o, [s.id]: !o[s.id] }))}
              title={s.hint}
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
            </button>
            {open && rows.length === 0 && (
              <p className="pl-5 text-[11.5px] text-gray-400 dark:text-zinc-500">
                {data.unscored > 0
                  ? `Nothing scored yet — ${data.unscored} waiting. Scan to score a batch now.`
                  : 'Nothing else eligible right now. Scans run every 5 minutes while briefly is open.'}
              </p>
            )}
            {open && (
              <div className="space-y-1.5">
                {rows.map((row) => (
                  <JobCard
                    key={row.id}
                    row={row}
                    section={s.id}
                    highlight={row.id === justAdded}
                    busy={row.id === applyingId}
                    onStatus={setStatus}
                    onNote={setNote}
                    onApply={apply}
                    onUseAside={useAside}
                    onFocusTab={focusTab}
                    onCopyPrompt={copyPrompt}
                    onScoreAnyway={scoreAnyway}
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
 * Everything you've acted on, newest first. Same store as the shortlist — a status change here
 * shows up there and vice versa — so nothing drifts. CSV export is for a spreadsheet if you want one.
 */
type TrackerFilter = 'all' | 'progress' | JobStatus

const TRACKER_FILTERS: { id: TrackerFilter; label: string; match: (s: JobStatus) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'progress', label: 'In progress', match: (s) => s === 'saved' || s === 'applying' },
  ...OUTCOME_STATUSES.map((s) => ({ id: s as TrackerFilter, label: JOB_STATUS_LABELS[s], match: (x: JobStatus) => x === s }))
]

function Tracker({
  rows,
  onStatus,
  onNote,
  onExport,
  onImport,
  filtered
}: {
  rows: JobRow[]
  onStatus: (id: string, status: JobStatus) => void
  onNote: (id: string, note: string) => void
  onExport: () => void
  onImport: () => void
  filtered: boolean
}): React.JSX.Element {
  const [filter, setFilter] = useState<TrackerFilter>('all')
  const active = TRACKER_FILTERS.find((f) => f.id === filter) ?? TRACKER_FILTERS[0]
  const shown = rows.filter((r) => r.state && active.match(r.state.status))
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {TRACKER_FILTERS.map((f) => {
          const n = rows.filter((r) => r.state && f.match(r.state.status)).length
          const on = filter === f.id
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              disabled={n === 0 && f.id !== 'all'}
              className={cn(
                'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold tabular-nums transition-all disabled:opacity-40',
                on
                  ? 'border-gray-900 bg-gray-900 text-white dark:border-accent dark:bg-accent'
                  : 'border-slate-200 bg-white text-gray-600 hover:border-slate-300 dark:border-white/[0.1] dark:bg-ink-800 dark:text-zinc-300 dark:hover:border-white/20'
              )}
            >
              {f.id !== 'all' && f.id !== 'progress' && (
                <span className={cn('h-1.5 w-1.5 rounded-full', on ? 'bg-white/80' : STATUS_DOT[f.id])} />
              )}
              {f.label} {n}
            </button>
          )
        })}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={onImport}
            title="Import applications: on my.greenhouse.io/applications press ⌘A, ⌘C, then click this"
            className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-gray-700 shadow-sm transition hover:border-slate-300 dark:border-white/[0.1] dark:bg-ink-800 dark:text-zinc-200 dark:hover:border-white/20"
          >
            <ClipboardPaste size={11} />
            Import
          </button>
          <button
            onClick={onExport}
            disabled={rows.length === 0}
            title="Save every tracked posting (all statuses) as a CSV in Downloads"
            className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-gray-700 shadow-sm transition hover:border-slate-300 disabled:opacity-50 dark:border-white/[0.1] dark:bg-ink-800 dark:text-zinc-200 dark:hover:border-white/20"
          >
            <Download size={11} />
            CSV
          </button>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-[11.5px] text-gray-400 dark:border-white/[0.12] dark:text-zinc-500">
          {filtered
            ? 'No tracked postings match your search.'
            : filter === 'all'
              ? 'Save, apply to, or check off a posting in the shortlist and it lands here.'
              : `Nothing marked ${active.label.toLowerCase()} yet.`}
        </p>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-ink-900">
          {shown.map((row) => (
            <TrackerRow key={row.id} row={row} onStatus={onStatus} onNote={onNote} />
          ))}
        </div>
      )}
    </section>
  )
}

function TrackerRow({
  row,
  onStatus,
  onNote
}: {
  row: JobRow
  onStatus: (id: string, status: JobStatus) => void
  onNote: (id: string, note: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [note, setNoteDraft] = useState(row.state?.note ?? '')
  useEffect(() => setNoteDraft(row.state?.note ?? ''), [row.state?.note])
  const st = row.state!
  const company = row.item?.company ?? st.snapshot.company
  const title = row.item?.title ?? st.snapshot.title
  const url = row.item?.url ?? st.snapshot.url
  const when = st.appliedAt ?? st.updatedAt
  const whenLabel = st.appliedAt ? `applied ${localDay(st.appliedAt)}` : `${JOB_STATUS_LABELS[st.status].toLowerCase()} ${relativeTime(when)}`

  return (
    <div className="group border-b border-slate-100 px-3 py-2 last:border-b-0 dark:border-white/[0.06]">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[12.5px] font-semibold">{company}</span>
            <span className="truncate text-[11.5px] text-gray-500 dark:text-zinc-400">{title}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-gray-400 dark:text-zinc-500">
            <MetaMenu
              title="Change status"
              display={
                <>
                  <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[st.status])} />
                  {JOB_STATUS_LABELS[st.status]}
                </>
              }
              options={STATUS_OPTIONS.filter((o) => o.id !== 'new')}
              selected={st.status}
              onSelect={(id) => onStatus(row.id, id as JobStatus)}
            />
            <span className="tabular-nums">{whenLabel}</span>
            {!editing && st.note && (
              <button
                onClick={() => setEditing(true)}
                className="min-w-0 truncate text-left text-gray-500 hover:text-gray-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                title={st.note}
              >
                {st.note}
              </button>
            )}
            {!editing && !st.note && (
              <button
                onClick={() => setEditing(true)}
                className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-gray-700 dark:hover:text-zinc-300"
              >
                + note
              </button>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {url && (
            <ActionButton title="Open posting" onClick={() => window.briefly.openUrl(url)}>
              <ExternalLink size={12} />
            </ActionButton>
          )}
        </div>
      </div>
      {editing && (
        <textarea
          autoFocus
          value={note}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={() => {
            setEditing(false)
            if (note !== (st.note ?? '')) onNote(row.id, note)
          }}
          placeholder="Recruiter, referral, next step, OA deadline…"
          rows={2}
          className="mt-1.5 w-full resize-none rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-1.5 text-[11.5px] outline-none transition focus:border-gray-400 dark:border-white/[0.08] dark:bg-ink-800 dark:focus:border-accent"
        />
      )}
    </div>
  )
}

/**
 * The "what should I apply to right now" list: every untouched, eligible posting with a strong
 * signal (tiered company, stated pay at the floor, somewhere you've applied, watchlist, zero2sudo),
 * newest arrivals first and strongest within a day, with Apply as the primary action instead of
 * hidden behind hover. Collapsed to a preview; "Show all" expands it.
 */
function ApplyNow({
  picks,
  total,
  showAll,
  searching,
  applyingId,
  preparing,
  onToggleAll,
  onApply,
  onPrepareTop,
  onSkip,
  onApplied,
  onOpenRules
}: {
  picks: Pick[]
  total: number
  showAll: boolean
  /** A search is active: the list is fully expanded and the Show all/fewer toggle is hidden. */
  searching: boolean
  applyingId: string | null
  preparing: boolean
  onToggleAll: () => void
  onApply: (id: string) => void
  /** Fill the first N supported forms in briefly's browser, one after another. */
  onPrepareTop: (n: number) => void
  onSkip: (id: string) => void
  onApplied: (id: string) => void
  onOpenRules: () => void
}): React.JSX.Element {
  const shown = showAll ? picks : picks.slice(0, NOW_PREVIEW)
  const hidden = picks.length - shown.length
  const busy = applyingId !== null || preparing
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/70 p-2.5 dark:border-white/[0.1] dark:bg-white/[0.03]">
      <div className="mb-2 flex items-center gap-1.5 px-0.5">
        <span className="shrink-0 whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.08em] text-gray-600 dark:text-zinc-300">
          Apply now
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-gray-400 dark:text-zinc-600">{total}</span>
        {picks.length > 0 && !searching && (
          <button
            onClick={() => onPrepareTop(3)}
            disabled={busy}
            title="Open the first three supported postings in briefly's browser and fill them from your profile. Nothing is submitted; you review each tab."
            className={cn(
              'ml-1 flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10.5px] font-semibold text-gray-700 shadow-sm transition hover:border-slate-300 dark:border-white/[0.1] dark:bg-ink-900 dark:text-zinc-200 dark:hover:border-white/20',
              busy && 'opacity-60'
            )}
          >
            {preparing ? <RefreshCw size={10} className="animate-spin" /> : <Rocket size={10} />}
            {preparing ? 'Filling…' : 'Prepare top 3'}
          </button>
        )}
        <button
          onClick={onOpenRules}
          title="Tiers and the pay floor live in rules.md; watchlist.md and your applications count too"
          className="ml-auto min-w-0 truncate text-right text-[10.5px] text-gray-400 transition hover:text-gray-600 dark:text-zinc-500 dark:hover:text-zinc-300"
        >
          tier · pay · applied here · zero2sudo
        </button>
      </div>
      {picks.length === 0 ? (
        <p className="px-0.5 pb-1 text-[11.5px] text-gray-400 dark:text-zinc-500">
          {total === 0
            ? 'Nothing with a strong signal yet. Eligible postings without one sit under Also eligible.'
            : 'No Apply-now posting matches your search.'}
        </p>
      ) : (
        <div className="space-y-1.5">
          {shown.map(({ row, why }) => {
            const it = row.item!
            const event = it.kind === 'event'
            return (
              <div
                key={row.id}
                className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] dark:border-white/[0.08] dark:bg-ink-900"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-[12.5px] font-semibold">{it.company}</span>
                    {event && <Chip tone="amber">Event</Chip>}
                    {it.dcLink && <Chip tone="teal">DC</Chip>}
                    {it.pay && <Chip tone="neutral">{it.pay}</Chip>}
                  </div>
                  <div className="truncate text-[11.5px] text-gray-600 dark:text-zinc-300">{it.title}</div>
                  <div className="mt-0.5 truncate text-[10.5px] text-gray-400 dark:text-zinc-500">
                    {[...why, event && it.deadline ? `on ${it.deadline}` : null, it.location].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!event && (
                    <ActionButton title="Open posting" onClick={() => window.briefly.openUrl(it.url)}>
                      <ExternalLink size={12} />
                    </ActionButton>
                  )}
                  <ActionButton title={event ? 'Registered — mark done' : 'Already applied — mark done'} onClick={() => onApplied(row.id)}>
                    <Check size={12} />
                  </ActionButton>
                  <ActionButton title="Not for me — skip" onClick={() => onSkip(row.id)}>
                    <X size={12} />
                  </ActionButton>
                  {event ? (
                    <button
                      onClick={() => window.briefly.openUrl(it.url)}
                      title="Open the event page to register"
                      className="flex items-center gap-1 rounded-md bg-gray-900 px-2 py-1 text-[11px] font-semibold text-white shadow-sm transition-all hover:bg-gray-700 active:scale-95 dark:bg-accent dark:hover:bg-accent-hover"
                    >
                      <ExternalLink size={11} />
                      Open
                    </button>
                  ) : (
                    <button
                      onClick={() => onApply(row.id)}
                      disabled={busy}
                      title="Apply — fills the form in briefly's browser (or Aside), never submits"
                      className={cn(
                        'flex items-center gap-1 rounded-md bg-gray-900 px-2 py-1 text-[11px] font-semibold text-white shadow-sm transition-all hover:bg-gray-700 active:scale-95 dark:bg-accent dark:hover:bg-accent-hover',
                        busy && applyingId !== row.id && 'opacity-50',
                        applyingId === row.id && 'cursor-progress'
                      )}
                    >
                      {applyingId === row.id ? <RefreshCw size={11} className="animate-spin" /> : <Rocket size={11} />}
                      {applyingId === row.id ? 'Starting…' : 'Apply'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {!searching && (hidden > 0 || (showAll && picks.length > NOW_PREVIEW)) && (
        <button
          onClick={onToggleAll}
          className="mt-2 flex w-full items-center justify-center gap-1 rounded-md py-1 text-[11px] font-semibold text-gray-500 transition hover:bg-slate-100 hover:text-gray-700 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-zinc-200"
        >
          <ChevronRight size={11} className={cn('transition-transform', showAll ? '-rotate-90' : 'rotate-90')} />
          {showAll ? 'Show fewer' : `Show all ${picks.length}`}
        </button>
      )}
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
  highlight = false,
  busy = false,
  onStatus,
  onNote,
  onApply,
  onUseAside,
  onFocusTab,
  onCopyPrompt,
  onScoreAnyway
}: {
  row: JobRow
  section: Section
  highlight?: boolean
  /** The hand-off for this card is in flight. */
  busy?: boolean
  onStatus: (id: string, status: JobStatus) => void
  onNote: (id: string, note: string) => void
  onApply: (id: string) => void
  onUseAside: (id: string) => void
  onFocusTab: (id: string) => void
  onCopyPrompt: (id: string) => void
  onScoreAnyway: (id: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [note, setNoteDraft] = useState(row.state?.note ?? '')
  useEffect(() => setNoteDraft(row.state?.note ?? ''), [row.state?.note])

  const item = row.item
  const snap = row.state?.snapshot
  const company = item?.company ?? snap?.company ?? 'Unknown'
  const title = item?.title ?? snap?.title ?? ''
  // A resolved wrapper (jobright) points at the employer; prefer it everywhere.
  const url = row.state?.resolvedUrl ?? item?.url ?? snap?.url ?? null
  const status = row.state?.status ?? 'new'
  const verdict = item?.verdict ?? null
  const pruned = !item
  const stale = item && !item.active
  const pasted = item ? isPasted(item) : false
  const prepared = status === 'applying' ? row.state?.prepared ?? null : null
  const filling = Boolean(prepared && !prepared.finishedAt && !prepared.closedAt)

  const options = section === 'applied' ? STATUS_OPTIONS.filter((o) => OUTCOME_STATUSES.includes(o.id)) : STATUS_OPTIONS

  return (
    <div
      className={cn(
        'group rounded-xl border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors dark:bg-ink-900',
        'border-slate-200 hover:border-slate-300 dark:border-white/[0.08] dark:hover:border-white/[0.16]',
        (pruned || stale) && 'opacity-70',
        highlight && 'border-gray-900 ring-2 ring-gray-900/15 dark:border-accent dark:ring-accent/25'
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
            {item?.kind === 'event' && <Chip tone="amber">Event</Chip>}
            {item?.dcLink && <Chip tone="teal">DC</Chip>}
            {item?.pay && <Chip tone="neutral">{item.pay}</Chip>}
            {verdict && (section === 'eligible' || section === 'flagged') && (
              <Chip tone={verdict.decision === 'apply' ? 'emerald' : verdict.decision === 'skip' ? 'rose' : 'amber'}>
                {verdict.decision === 'apply' ? 'apply' : verdict.decision === 'skip' ? 'skip' : 'flagged'}
              </Chip>
            )}
            {item && !item.verdict && <Chip tone="neutral">{pasted ? 'screening…' : 'unscored'}</Chip>}
            {verdict?.rule && (
              <Chip tone="neutral" title={`${verdict.rule.label} — matched "${verdict.rule.quote}"`}>
                {verdict.rule.id}
              </Chip>
            )}
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
            {item?.deadline && <span>{item.kind === 'event' ? 'on' : 'due'} {item.deadline}</span>}
            {item?.postedAt && (
              <span title={item.source === 'jobright' ? 'Jobright only records when it listed the role, not when the company posted it' : undefined}>
                {item.source === 'jobright' ? 'listed' : 'posted'} {relativeTime(item.postedAt)}
              </span>
            )}
            {item && (
              <span className="text-gray-300 dark:text-zinc-600">
                {[item.source, ...(item.alsoSeenIn ?? [])].map((s) => (s === 'manual' ? 'added by you' : s)).join(' · ')}
              </span>
            )}
            {pruned && <span className="italic">posting removed</span>}
            {stale && <span className="italic">no longer listed</span>}
            {prepared ? (
              <span
                className={cn(
                  prepared.error ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'
                )}
                title={prepared.error ?? undefined}
              >
                {filling
                  ? 'filling in the browser…'
                  : prepared.closedAt && !prepared.error
                    ? 'tab closed without a confirmation'
                    : prepared.error
                      ? `fill stopped: ${prepared.error}`
                      : `${prepared.filled} filled · ${prepared.drafted.length} drafted${prepared.resumeUploaded ? '' : ' · no resume'}${prepared.unfilled.length ? ` · ${prepared.unfilled.length} for you` : ''}`}
              </span>
            ) : (
              status === 'applying' &&
              row.state?.openedInAsideAt && (
                <span className="text-amber-600 dark:text-amber-400">
                  in Aside since {relativeTime(row.state.openedInAsideAt)}
                </span>
              )
            )}
          </div>
        </div>

        <div className={cn('flex shrink-0 items-center gap-1 transition-opacity', !prepared && 'opacity-0 group-hover:opacity-100')}>
          {status === 'applying' && !prepared && (
            <ActionButton title="Copy the Aside prompt again" onClick={() => onCopyPrompt(row.id)}>
              <Clipboard size={12} />
            </ActionButton>
          )}
          {prepared && (
            <ActionButton title="Hand this one to Aside instead" disabled={busy} onClick={() => onUseAside(row.id)}>
              <Clipboard size={12} />
            </ActionButton>
          )}
          {item && !stale && item.kind !== 'event' && (status === 'new' || status === 'saved') && (
            <ActionButton
              title={busy ? 'Starting…' : 'Apply — fills the form in briefly\u2019s browser (or Aside), never submits'}
              disabled={busy}
              onClick={() => onApply(row.id)}
            >
              {busy ? <RefreshCw size={12} className="animate-spin" /> : <Rocket size={12} />}
            </ActionButton>
          )}
          {(status === 'new' || status === 'saved' || status === 'applying') && (
            <ActionButton
              title={
                item?.kind === 'event'
                  ? 'Registered — mark done'
                  : status === 'applying'
                    ? prepared
                      ? 'Submitted in the browser — mark applied'
                      : 'Submitted in Aside — mark applied'
                    : 'Already applied — mark done'
              }
              onClick={() => onStatus(row.id, 'applied')}
              active={status === 'applying'}
            >
              <Check size={12} />
            </ActionButton>
          )}
          {prepared && (
            <button
              onClick={() => onFocusTab(row.id)}
              disabled={busy}
              title={prepared.closedAt ? 'The tab is gone — open and fill it again' : 'Bring the browser tab forward'}
              className="flex items-center gap-1 rounded-md bg-gray-900 px-2 py-1 text-[11px] font-semibold text-white shadow-sm transition-all hover:bg-gray-700 active:scale-95 disabled:opacity-50 dark:bg-accent dark:hover:bg-accent-hover"
            >
              <ExternalLink size={11} />
              {prepared.closedAt ? 'Reopen' : 'Open tab'}
            </button>
          )}
          {url && !prepared && (
            <ActionButton title={item?.kind === 'event' ? 'Open event page' : 'Open posting'} onClick={() => window.briefly.openUrl(url)}>
              <ExternalLink size={12} />
            </ActionButton>
          )}
        </div>
      </div>

      {expanded && (
        <div className="space-y-2 border-t border-slate-100 px-3 py-2.5 text-[11.5px] leading-relaxed dark:border-white/[0.06]">
          {prepared && (
            <div className="space-y-1.5 rounded-lg border border-amber-200/70 bg-amber-50/60 px-2.5 py-2 dark:border-amber-500/20 dark:bg-amber-950/20">
              <div className="flex items-center justify-between gap-2 text-gray-600 dark:text-zinc-300">
                <span>
                  Filled in briefly's browser{prepared.ats !== 'unknown' ? ` (${prepared.ats})` : ''} {relativeTime(prepared.at)}.
                  {prepared.resumeUploaded ? ' resume.pdf attached.' : ' Resume not attached.'}
                </span>
                {url && (
                  <button onClick={() => window.briefly.openUrl(url)} className="shrink-0 text-gray-400 hover:text-gray-700 dark:text-zinc-500 dark:hover:text-zinc-200" title="Open the posting in your default browser">
                    <ExternalLink size={11} />
                  </button>
                )}
              </div>
              {prepared.drafted.length > 0 && (
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-amber-700 dark:text-amber-400">
                    Drafted by the model — read before you submit
                  </span>
                  <ul className="mt-0.5 space-y-1">
                    {prepared.drafted.map((d, i) => (
                      <li key={i}>
                        <span className="font-semibold text-gray-700 dark:text-zinc-200">{d.label}</span>
                        <p className="select-text whitespace-pre-wrap text-gray-600 dark:text-zinc-300">{d.text}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {prepared.unfilled.length > 0 && (
                <List
                  label="Left for you"
                  items={prepared.unfilled.map((u) => `${u.label} — ${u.reason}`)}
                  tone="text-gray-600 dark:text-zinc-300"
                />
              )}
            </div>
          )}          {verdict ? (
            <>
              <p className="text-gray-700 dark:text-zinc-200">{verdict.summary}</p>
              {verdict.rule && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-1.5 dark:border-white/[0.08] dark:bg-ink-800">
                  <span className="min-w-0 text-gray-500 dark:text-zinc-400">
                    Rule {verdict.rule.id}: {verdict.rule.label}. Matched{' '}
                    <span className="text-gray-700 dark:text-zinc-200">“{verdict.rule.quote}”</span>. No LLM request spent.
                  </span>
                  {item && (
                    <button
                      onClick={() => onScoreAnyway(row.id)}
                      className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-gray-700 shadow-sm transition hover:border-slate-300 dark:border-white/[0.1] dark:bg-ink-900 dark:text-zinc-200 dark:hover:border-white/20"
                      title="Wrong call? Clear the rule and let the LLM judge this posting"
                    >
                      Score anyway
                    </button>
                  )}
                </div>
              )}
              {verdict.blockers.length > 0 && !verdict.rule && (
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
              {pasted
                ? `Screening against your profile in the background.${item.source === 'manual' ? ' Company and title are guessed from the link until then.' : ''} Apply is ready whenever you are.`
                : item.descriptionAvailable
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
  title,
  children
}: {
  tone: 'teal' | 'emerald' | 'amber' | 'rose' | 'neutral'
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  const tones = {
    teal: 'bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300',
    emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
    rose: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
    neutral: 'bg-slate-100 text-gray-600 dark:bg-white/[0.06] dark:text-zinc-400'
  }
  return (
    <span title={title} className={cn('shrink-0 rounded px-1.5 py-px text-[10px] font-semibold', tones[tone])}>
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
