import { useEffect, useState } from 'react'
import { cn, relativeTime } from '@/lib/utils'
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../../../shared/types'
import type { ProfileFile } from '../../../shared/jobs'

const DAY_START_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8]

function formatHour(h: number): string {
  if (h === 0) return 'Midnight'
  return `${h} am`
}

export function SettingsView({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [saved, setSaved] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  const [autoRescan, setAutoRescan] = useState(0)
  const [notifications, setNotifications] = useState(true)
  const [dayStartHour, setDayStartHour] = useState(4)
  const [jobsScan, setJobsScan] = useState(15)
  const [jobsInBadge, setJobsInBadge] = useState(false)
  const [profile, setProfile] = useState<ProfileFile[]>([])
  const [profileDir, setProfileDir] = useState('')

  useEffect(() => {
    window.briefly.getSettings().then((s) => {
      setBaseUrl(s.baseUrl)
      setModel(s.model)
      setHasApiKey(s.hasApiKey)
      setAutoRescan(s.autoRescanMinutes)
      setNotifications(s.notificationsEnabled)
      setDayStartHour(s.dayStartHour)
      setJobsScan(s.jobsScanMinutes)
      setJobsInBadge(s.jobsInBadge)
      if (s.hasApiKey) loadModels()
    })
    window.briefly.getLaunchAtLogin().then(setLaunchAtLogin)
    window.briefly.getJobs().then((v) => {
      setProfile(v.profile)
      setProfileDir(v.profileDir)
    })
  }, [])

  const changeJobsScan = async (minutes: number): Promise<void> => {
    setJobsScan(minutes)
    await window.briefly.saveSettings({ jobsScanMinutes: minutes })
  }

  const toggleJobsInBadge = async (): Promise<void> => {
    const next = !jobsInBadge
    setJobsInBadge(next)
    await window.briefly.saveSettings({ jobsInBadge: next })
  }

  const openProfile = async (name: ProfileFile['name'] | null): Promise<void> => {
    await window.briefly.openProfile(name)
    // Re-read timestamps after the user has had a chance to save.
    setTimeout(() => window.briefly.getJobs().then((v) => setProfile(v.profile)), 3000)
  }

  const toggleLaunchAtLogin = async (): Promise<void> => {
    setLaunchAtLogin(await window.briefly.setLaunchAtLogin(!launchAtLogin))
  }

  // Applies immediately — no Save needed.
  const toggleNotifications = async (): Promise<void> => {
    const next = !notifications
    setNotifications(next)
    await window.briefly.saveSettings({ notificationsEnabled: next })
  }

  // Applies immediately — no Save needed.
  const changeAutoRescan = async (minutes: number): Promise<void> => {
    setAutoRescan(minutes)
    await window.briefly.saveSettings({ autoRescanMinutes: minutes })
  }

  // Applies immediately; the board re-reads state via onSaved so "today" shifts at once.
  const changeDayStart = async (hour: number): Promise<void> => {
    setDayStartHour(hour)
    await window.briefly.saveSettings({ dayStartHour: hour })
    onSaved()
  }

  const loadModels = async (): Promise<void> => {
    setModelsError(null)
    const result = await window.briefly.listModels()
    if (result.ok && result.models) setModels(result.models)
    else setModelsError(result.error ?? 'Could not load models.')
  }

  const save = async (): Promise<void> => {
    const update: { baseUrl: string; model: string; apiKey?: string; autoRescanMinutes: number } = {
      baseUrl,
      model,
      autoRescanMinutes: autoRescan
    }
    if (apiKey.trim()) update.apiKey = apiKey.trim()
    const result = await window.briefly.saveSettings(update)
    setHasApiKey(result.hasApiKey)
    setApiKey('')
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    onSaved()
    if (result.hasApiKey) loadModels()
  }

  const inputCls =
    'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] shadow-[0_1px_2px_rgba(0,0,0,0.03)] outline-none transition focus:border-gray-400 dark:border-white/[0.08] dark:bg-ink-900 dark:focus:border-accent'
  const labelCls = 'text-[11px] font-bold uppercase tracking-[0.08em] text-gray-500 dark:text-zinc-400'
  const hintCls = 'block text-[11px] leading-relaxed text-gray-400 dark:text-zinc-500'

  return (
    <div className="space-y-4">
      <label className="block space-y-1.5">
        <span className={labelCls}>
          API key{' '}
          {hasApiKey && (
            <span className="normal-case tracking-normal text-emerald-600 dark:text-emerald-400">
              · set ✓
            </span>
          )}
        </span>
        <input
          type="password"
          placeholder={hasApiKey ? '••••••••  (enter to replace)' : 'gsk_…'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className={inputCls}
        />
        <span className={hintCls}>
          Free key at console.groq.com — no credit card needed. Stored encrypted on this Mac, never
          synced.
        </span>
      </label>

      <label className="block space-y-1.5">
        <span className={labelCls}>Base URL</span>
        <input
          placeholder={DEFAULT_BASE_URL}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className={inputCls}
        />
      </label>

      <label className="block space-y-1.5">
        <span className={labelCls}>Model</span>
        {models.length > 0 ? (
          <select
            value={models.includes(model) ? model : ''}
            onChange={(e) => setModel(e.target.value)}
            className={inputCls}
          >
            {!models.includes(model) && (
              <option value="" disabled>
                {model ? `${model} (not available!)` : 'Choose a model'}
              </option>
            )}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input
            placeholder={DEFAULT_MODEL}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className={inputCls}
          />
        )}
        <span className={hintCls}>
          {models.length > 0
            ? 'Live list from your provider — only models your key can use.'
            : modelsError
              ? `Could not fetch model list: ${modelsError}`
              : 'Save an API key to load the live model list from your provider.'}
        </span>
      </label>

      <label className="block space-y-1.5">
        <span className={labelCls}>Auto rescan</span>
        <select
          value={autoRescan}
          onChange={(e) => changeAutoRescan(Number(e.target.value))}
          className={inputCls}
        >
          <option value={0}>Off</option>
          <option value={30}>Every 30 minutes</option>
          <option value={60}>Every hour</option>
          <option value={180}>Every 3 hours</option>
          <option value={360}>Every 6 hours</option>
        </select>
        <span className={hintCls}>
          Scans in the background while the popover is closed, so the board is fresh when you open
          it.
        </span>
      </label>

      <label className="block space-y-1.5">
        <span className={labelCls}>New day starts at</span>
        <select
          value={dayStartHour}
          onChange={(e) => changeDayStart(Number(e.target.value))}
          className={inputCls}
        >
          {DAY_START_OPTIONS.map((h) => (
            <option key={h} value={h}>
              {formatHour(h)}
            </option>
          ))}
        </select>
        <span className={hintCls}>
          Working past midnight still counts as today: done tasks stay visible and daily repeats
          don&apos;t reset until this hour. Deadlines always use the calendar date.
        </span>
      </label>

      <ToggleRow
        title="Deadline notifications"
        hint="One notification a day for tasks overdue or due by tomorrow. If nothing appears, allow briefly under System Settings → Notifications."
        on={notifications}
        onToggle={toggleNotifications}
        hintCls={hintCls}
      />

      <ToggleRow
        title="Launch at login"
        hint="Start briefly automatically when you log in."
        on={launchAtLogin}
        onToggle={toggleLaunchAtLogin}
        hintCls={hintCls}
      />

      <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-white/[0.08]">
        <span className={labelCls}>Jobs</span>

        <label className="block space-y-1.5">
          <span className="block text-[13px] font-medium">Scan for postings</span>
          <select
            value={jobsScan}
            onChange={(e) => changeJobsScan(Number(e.target.value))}
            className={inputCls}
          >
            <option value={0}>Off</option>
            <option value={15}>Every 15 minutes</option>
            <option value={30}>Every 30 minutes</option>
            <option value={60}>Every hour</option>
          </select>
          <span className={hintCls}>
            Polls your watchlist companies&apos; job boards and the public internship feeds, then scores
            new postings against your profile.
          </span>
        </label>

        <ToggleRow
          title="Count new jobs in menu bar"
          hint="Adds the New-postings count to the badge next to open tasks."
          on={jobsInBadge}
          onToggle={toggleJobsInBadge}
          hintCls={hintCls}
        />

        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium">Profile files</span>
          <div className="grid grid-cols-2 gap-1.5">
            {profile.map((f) => (
              <button
                key={f.name}
                onClick={() => openProfile(f.name)}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-[12px] shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition hover:border-slate-300 dark:border-white/[0.08] dark:bg-ink-900 dark:hover:border-white/20"
              >
                <span className="font-medium">{f.name}</span>
                <span className="text-[10px] text-gray-400 dark:text-zinc-500">
                  {f.exists && f.modifiedAt ? relativeTime(f.modifiedAt) : 'missing'}
                </span>
              </button>
            ))}
          </div>
          <span className={hintCls}>
            Opens in your default editor. Folder:{' '}
            <button onClick={() => openProfile(null)} className="underline decoration-dotted">
              {profileDir.replace(/^\/Users\/[^/]+/, '~')}
            </button>
            . Edits to resume or preferences re-score every posting on the next scan.
          </span>
        </div>
      </div>

      <button
        onClick={save}
        className="rounded-lg bg-gray-900 px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition hover:bg-gray-700 dark:bg-accent dark:text-white dark:shadow-[0_0_16px_rgba(94,106,210,0.35)] dark:hover:bg-accent-hover"
      >
        {saved ? 'Saved ✓' : 'Save'}
      </button>

      <p className="border-t border-slate-200 pt-3 text-[11px] leading-relaxed text-gray-400 dark:border-white/[0.08] dark:text-zinc-500">
        briefly reads your Apple Notes read-only. Locked notes are never read. Task state lives only
        in this app. Tip: press <kbd className="rounded bg-slate-100 px-1 font-sans dark:bg-ink-700">⌥B</kbd> anywhere
        to open briefly.
      </p>
    </div>
  )
}

function ToggleRow({
  title,
  hint,
  on,
  onToggle,
  hintCls
}: {
  title: string
  hint: string
  on: boolean
  onToggle: () => void
  hintCls: string
}): React.JSX.Element {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition hover:border-slate-300 dark:border-white/[0.08] dark:bg-ink-900 dark:hover:border-white/20"
    >
      <span>
        <span className="block text-[13px] font-medium">{title}</span>
        <span className={hintCls}>{hint}</span>
      </span>
      <span
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          on ? 'bg-gray-900 dark:bg-accent' : 'bg-slate-200 dark:bg-ink-700'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all',
            on ? 'left-[18px]' : 'left-0.5'
          )}
        />
      </span>
    </button>
  )
}
