import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** Rough per-option height (px) used to decide whether the menu fits below the trigger. */
const OPTION_HEIGHT = 30

/** Clickable metadata label that opens a one-click picker — no cycling, no hidden state. */
export function MetaMenu({
  title,
  display,
  options,
  selected,
  onSelect
}: {
  title: string
  display: React.ReactNode
  options: { id: string; label: string; dot?: string }[]
  selected: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [flipUp, setFlipUp] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)

  // The popover window is short (580px); a menu that opens below a low row lands off-screen and
  // the backdrop then blocks scrolling, so it looks dead. Open upward when there is no room below.
  const toggle = (): void => {
    if (!open && trigger.current) {
      const rect = trigger.current.getBoundingClientRect()
      const needed = options.length * OPTION_HEIGHT + 12
      const below = window.innerHeight - rect.bottom
      setFlipUp(below < needed && rect.top > below)
    }
    setOpen((v) => !v)
  }

  return (
    <span className="relative">
      <button
        ref={trigger}
        title={title}
        onClick={toggle}
        className={cn(
          'flex items-center gap-1 rounded px-1 py-px text-[11px] font-medium transition-colors active:scale-95',
          open
            ? 'bg-slate-200/80 text-gray-700 dark:bg-white/[0.1] dark:text-zinc-200'
            : 'text-gray-500 hover:bg-slate-200/60 hover:text-gray-700 dark:text-zinc-400 dark:hover:bg-white/[0.08] dark:hover:text-zinc-200'
        )}
      >
        {display}
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <span
            className={cn(
              'absolute left-0 z-20 flex max-h-[45vh] w-36 flex-col overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-white/[0.1] dark:bg-ink-800',
              flipUp ? 'bottom-full mb-1' : 'top-full mt-1'
            )}
          >
            {options.map((opt) => (
              <button
                key={opt.id}
                onClick={() => {
                  setOpen(false)
                  if (opt.id !== selected) onSelect(opt.id)
                }}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 text-left text-xs font-medium transition-colors',
                  opt.id === selected
                    ? 'bg-slate-50 text-gray-900 dark:bg-white/[0.06] dark:text-zinc-100'
                    : 'text-gray-700 hover:bg-slate-50 hover:text-gray-900 dark:text-zinc-300 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100'
                )}
              >
                {opt.dot && <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', opt.dot)} />}
                <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                {opt.id === selected && <span className="text-[10px]">✓</span>}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  )
}

export function ActionButton({
  title,
  onClick,
  active,
  disabled,
  children
}: {
  title: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-md border p-1 shadow-sm transition-all active:scale-90 disabled:cursor-progress disabled:opacity-60',
        active
          ? 'border-teal-300 bg-teal-50 text-teal-600 hover:border-teal-400 dark:border-teal-500/40 dark:bg-teal-500/10 dark:text-teal-400 dark:hover:border-teal-500/60'
          : 'border-slate-200 bg-white text-gray-400 hover:border-slate-300 hover:text-gray-700 dark:border-white/[0.1] dark:bg-ink-800 dark:text-zinc-500 dark:hover:border-white/20 dark:hover:text-zinc-300'
      )}
    >
      {children}
    </button>
  )
}
