import { useEffect, useState } from 'react'
import { Search, Check, Loader2, ListPlus } from 'lucide-react'
import type { NoteSummary } from '../../../shared/types'
import { cn } from '@/lib/utils'

export function NotesView({ onTasksChanged }: { onTasksChanged: () => void }): React.JSX.Element {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [extracting, setExtracting] = useState<string | null>(null)
  const [extracted, setExtracted] = useState<Set<string>>(new Set())

  useEffect(() => {
    window.briefly.listNotes().then((result) => {
      if (result.ok && result.notes) setNotes(result.notes)
      else setError(result.error ?? 'Could not read notes.')
    })
  }, [])

  const extract = async (note: NoteSummary): Promise<void> => {
    const key = note.title + note.modified
    setExtracting(key)
    setError(null)
    const result = await window.briefly.extractNote(note.title, note.modified)
    if (result.ok) {
      setExtracted((prev) => new Set(prev).add(key))
      onTasksChanged()
    } else {
      setError(result.error ?? 'Extraction failed.')
    }
    setExtracting(null)
  }

  if (error && !notes) {
    return (
      <p className="select-text px-2 py-8 text-center text-[13px] text-red-600 dark:text-red-400">
        {error}
      </p>
    )
  }

  if (!notes) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-gray-500 dark:text-zinc-400">
        <Loader2 size={14} className="animate-spin" /> Reading your notes…
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const filtered = q
    ? notes.filter((n) => n.title.toLowerCase().includes(q) || n.preview.toLowerCase().includes(q))
    : notes

  return (
    <div className="space-y-2.5">
      <div className="relative">
        <Search
          size={13}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-zinc-500"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${notes.length} notes…`}
          className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-[13px] shadow-[0_1px_2px_rgba(0,0,0,0.03)] outline-none transition focus:border-gray-400 dark:border-white/[0.08] dark:bg-ink-900 dark:focus:border-accent"
        />
      </div>

      {error && (
        <p className="select-text text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      <p className="px-1 text-[11px] leading-relaxed text-gray-400 dark:text-zinc-500">
        Notes with a <span className="mx-px inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" /> colored
        dot are in the auto-scan window. Locked notes are never read.
      </p>

      <ul className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:border-white/[0.08] dark:bg-ink-900">
        {filtered.map((note, i) => {
          const key = note.title + note.modified
          const isExtracting = extracting === key
          const wasExtracted = extracted.has(key)
          return (
            <li
              key={key}
              className={cn(
                'group px-3 py-2 transition-colors hover:bg-slate-50 dark:hover:bg-ink-800/60',
                i > 0 && 'border-t border-slate-100 dark:border-white/[0.06]'
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    note.scanned ? 'bg-accent' : 'bg-slate-200 dark:bg-white/15'
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {note.title}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-zinc-500">
                  {note.modified ? note.modified.slice(0, 10) : '—'}
                </span>
                <button
                  title="Import tasks from this note"
                  disabled={isExtracting || wasExtracted}
                  onClick={() => extract(note)}
                  className={cn(
                    'flex w-[72px] shrink-0 items-center justify-center gap-1 rounded-md border py-0.5 text-[10px] font-semibold transition-all duration-150',
                    wasExtracted
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-400'
                      : isExtracting
                        ? 'border-slate-200 bg-white text-gray-500 dark:border-white/[0.1] dark:bg-ink-800 dark:text-zinc-400'
                        : 'border-slate-200 bg-white text-gray-600 opacity-0 shadow-sm hover:border-gray-900 hover:bg-gray-900 hover:text-white group-hover:opacity-100 dark:border-white/[0.1] dark:bg-ink-800 dark:text-zinc-300 dark:hover:border-accent dark:hover:bg-accent dark:hover:text-white'
                  )}
                >
                  {wasExtracted ? (
                    <>
                      <Check size={10} strokeWidth={3} /> Added
                    </>
                  ) : isExtracting ? (
                    <>
                      <Loader2 size={10} className="animate-spin" /> Adding
                    </>
                  ) : (
                    <>
                      <ListPlus size={11} /> Import
                    </>
                  )}
                </button>
              </div>
              {note.preview && (
                <p className="mt-0.5 truncate pl-3.5 text-[11px] leading-relaxed text-gray-400 dark:text-zinc-500">
                  {note.preview}
                </p>
              )}
            </li>
          )
        })}
      </ul>

      {filtered.length === 0 && (
        <p className="py-6 text-center text-[13px] text-gray-500 dark:text-zinc-400">
          No notes match &quot;{query}&quot;.
        </p>
      )}
    </div>
  )
}
