import { useEffect, useState } from 'react'
import { cn, relativeTime } from '@/lib/utils'
import { DEFAULT_BASE_URL, DEFAULT_BEDROCK_MODEL, DEFAULT_BEDROCK_REGION, DEFAULT_MODEL, type LlmProvider } from '../../../shared/types'
import type { ProfileFile } from '../../../shared/jobs'

const DAY_START_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8]

function formatHour(h: number): string {
  if (h === 0) return 'Midnight'
  return `${h} am`
}

export function SettingsView({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [provider, setProvider] = useState<LlmProvider>('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [awsRegion, setAwsRegion] = useState(DEFAULT_BEDROCK_REGION)
  const [awsModel, setAwsModel] = useState(DEFAULT_BEDROCK_MODEL)
  const [awsKeyId, setAwsKeyId] = useState('')
  const [awsSecret, setAwsSecret] = useState('')
  const [awsHasCreds, setAwsHasCreds] = useState(false)
  const [awsKeyHint, setAwsKeyHint] = useState('')
  const [awsTest, setAwsTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; detail?: string }>({ state: 'idle' })
  const [saveError, setSaveError] = useState<string | null>(null)
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
  const [schoolHasFeed, setSchoolHasFeed] = useState(false)
  const [schoolFeedHost, setSchoolFeedHost] = useState('')
  const [schoolFeedUrl, setSchoolFeedUrl] = useState('')
  const [schoolPoll, setSchoolPoll] = useState(180)
  const [schoolHorizon, setSchoolHorizon] = useState(14)
  const [schoolFeedState, setSchoolFeedState] = useState<{ state: 'idle' | 'saving' | 'ok' | 'error'; detail?: string }>({ state: 'idle' })

  const saveSchoolFeed = async (): Promise<void> => {
    const url = schoolFeedUrl.trim()
    if (!url) return
    setSchoolFeedState({ state: 'saving' })
    const r = await window.briefly.saveSettings({ school: { feedUrl: url } })
    // Clear the pasted secret from React state immediately, success or not.
    setSchoolFeedUrl('')
    if (!r.ok) {
      setSchoolFeedState({ state: 'error', detail: r.error })
      return
    }
    setSchoolHasFeed(r.view.school.hasFeed)
    setSchoolFeedHost(r.view.school.feedHost)
    const v = await window.briefly.schoolFeedChanged()
    if (v.status.lastPollError) setSchoolFeedState({ state: 'error', detail: v.status.lastPollError })
    else setSchoolFeedState({ state: 'ok', detail: `Connected · ${v.items.filter((i) => i.source === 'canvas').length} items from ${r.view.school.feedHost}` })
    onSaved()
  }

  const clearSchoolFeed = async (): Promise<void> => {
    const r = await window.briefly.saveSettings({ school: { feedUrl: '' } })
    setSchoolHasFeed(r.view.school.hasFeed)
    setSchoolFeedHost('')
    setSchoolFeedState({ state: 'idle' })
  }

  const changeSchoolPoll = async (minutes: number): Promise<void> => {
    setSchoolPoll(minutes)
    await window.briefly.saveSettings({ school: { pollMinutes: minutes } })
  }

  const changeSchoolHorizon = async (days: number): Promise<void> => {
    setSchoolHorizon(days)
    await window.briefly.saveSettings({ school: { taskHorizonDays: days } })
  }

  useEffect(() => {
    window.briefly.getSettings().then((s) => {
      setProvider(s.llmProvider)
      setBaseUrl(s.baseUrl)
      setModel(s.model)
      setHasApiKey(s.hasApiKey)
      setAwsRegion(s.bedrock.region)
      setAwsModel(s.bedrock.model)
      setAwsHasCreds(s.bedrock.hasCredentials)
      setAwsKeyHint(s.bedrock.accessKeyHint)
      setAutoRescan(s.autoRescanMinutes)
      setNotifications(s.notificationsEnabled)
      setDayStartHour(s.dayStartHour)
      setJobsScan(s.jobsScanMinutes)
      setJobsInBadge(s.jobsInBadge)
      setSchoolHasFeed(s.school.hasFeed)
      setSchoolFeedHost(s.school.feedHost)
      setSchoolPoll(s.school.pollMinutes)
      setSchoolHorizon(s.school.taskHorizonDays)
      if ((s.llmProvider === 'bedrock' && s.bedrock.hasCredentials) || (s.llmProvider === 'openai' && s.hasApiKey)) loadModels()
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
    else {
      setModels([])
      setModelsError(result.error ?? 'Could not load models.')
    }
  }

  // Switching provider applies immediately so the model list below reflects the right service.
  const changeProvider = async (next: LlmProvider): Promise<void> => {
    setProvider(next)
    setModels([])
    setModelsError(null)
    const result = await window.briefly.saveSettings({ llmProvider: next })
    if (result.ok) {
      onSaved()
      if ((next === 'bedrock' && result.view.bedrock.hasCredentials) || (next === 'openai' && result.view.hasApiKey)) loadModels()
    }
  }

  const save = async (): Promise<void> => {
    setSaveError(null)
    const update: Parameters<typeof window.briefly.saveSettings>[0] = {
      llmProvider: provider,
      baseUrl,
      model,
      autoRescanMinutes: autoRescan,
      bedrock: { region: awsRegion, model: awsModel }
    }
    if (apiKey.trim()) update.apiKey = apiKey.trim()
    const id = awsKeyId.trim()
    const secret = awsSecret.trim()
    if (id || secret) {
      if (!id || !secret) {
        setSaveError('Enter both the access key ID and the secret access key together.')
        return
      }
      update.bedrock = { ...update.bedrock, accessKeyId: id, secretAccessKey: secret }
    }
    const result = await window.briefly.saveSettings(update)
    // Clear the secret fields whether or not the save took: they never sit in component state.
    setApiKey('')
    setAwsKeyId('')
    setAwsSecret('')
    if (!result.ok) {
      setSaveError(result.error ?? 'Could not save settings.')
      return
    }
    setHasApiKey(result.view.hasApiKey)
    setAwsHasCreds(result.view.bedrock.hasCredentials)
    setAwsKeyHint(result.view.bedrock.accessKeyHint)
    setAwsTest({ state: 'idle' })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    onSaved()
    if ((provider === 'bedrock' && result.view.bedrock.hasCredentials) || (provider === 'openai' && result.view.hasApiKey)) loadModels()
  }

  const clearAwsCredentials = async (): Promise<void> => {
    const result = await window.briefly.saveSettings({ bedrock: { accessKeyId: '', secretAccessKey: '' } })
    if (result.ok) {
      setAwsHasCreds(false)
      setAwsKeyHint('')
      setModels([])
      setAwsTest({ state: 'idle' })
    }
  }

  // Test what's on screen, not what was last saved: persist region + model (never the key fields)
  // before the call so picking a model and clicking Test does the obvious thing.
  const runAwsTest = async (): Promise<void> => {
    setAwsTest({ state: 'running' })
    const saved = await window.briefly.saveSettings({ bedrock: { region: awsRegion, model: awsModel } })
    if (!saved.ok) {
      setAwsTest({ state: 'error', detail: saved.error ?? 'Could not save region/model.' })
      return
    }
    const r = await window.briefly.testBedrock()
    if (r.ok) setAwsTest({ state: 'ok', detail: `${awsModel.split('.').slice(1).join('.') || awsModel} answered in ${r.ms} ms (${r.tokens} tokens).` })
    else setAwsTest({ state: 'error', detail: r.error ?? 'Test failed.' })
  }

  const inputCls =
    'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] shadow-[0_1px_2px_rgba(0,0,0,0.03)] outline-none transition focus:border-gray-400 dark:border-white/[0.08] dark:bg-ink-900 dark:focus:border-accent'
  const labelCls = 'text-[11px] font-bold uppercase tracking-[0.08em] text-gray-500 dark:text-zinc-400'
  const hintCls = 'block text-[11px] leading-relaxed text-gray-400 dark:text-zinc-500'

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <span className={labelCls}>AI provider</span>
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 dark:border-white/[0.08] dark:bg-ink-900">
          {(
            [
              ['openai', 'API key (Groq, Google…)'],
              ['bedrock', 'AWS Bedrock']
            ] as [LlmProvider, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => changeProvider(id)}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12px] font-medium transition',
                provider === id
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-ink-700 dark:text-white'
                  : 'text-gray-500 hover:text-gray-800 dark:text-zinc-400 dark:hover:text-zinc-200'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className={hintCls}>
          Used for screening postings, reading your notes and Ask. Switching applies at once; the next scan uses the new provider.
        </span>
      </div>

      {provider === 'openai' && (
        <>
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
              autoComplete="off"
              placeholder={hasApiKey ? '••••••••  (enter to replace)' : 'gsk_… or AIza…'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className={inputCls}
            />
            <span className={hintCls}>
              Any OpenAI-compatible service. Free keys: console.groq.com, aistudio.google.com. Stored encrypted on
              this Mac, never synced.
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
        </>
      )}

      {provider === 'bedrock' && (
        <>
          <div className="space-y-1.5">
            <span className={labelCls}>
              AWS access key{' '}
              {awsHasCreds && (
                <span className="normal-case tracking-normal text-emerald-600 dark:text-emerald-400">
                  · set ✓ (…{awsKeyHint})
                </span>
              )}
            </span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={awsHasCreds ? '••••••••  access key ID (enter to replace)' : 'Access key ID (AKIA…)'}
              value={awsKeyId}
              onChange={(e) => setAwsKeyId(e.target.value)}
              className={inputCls}
            />
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={awsHasCreds ? '••••••••  secret access key (enter to replace)' : 'Secret access key'}
              value={awsSecret}
              onChange={(e) => setAwsSecret(e.target.value)}
              className={inputCls}
            />
            <span className={hintCls}>
              Encrypted with your Mac&apos;s keychain before it touches disk; never shown again, never logged, never
              synced. Use a key that only has Bedrock permissions.{' '}
              {awsHasCreds && (
                <button onClick={clearAwsCredentials} className="underline decoration-dotted">
                  Remove key
                </button>
              )}
            </span>
          </div>

          <label className="block space-y-1.5">
            <span className={labelCls}>Region</span>
            <input
              placeholder={DEFAULT_BEDROCK_REGION}
              value={awsRegion}
              onChange={(e) => setAwsRegion(e.target.value)}
              className={inputCls}
            />
          </label>
        </>
      )}

      <label className="block space-y-1.5">
        <span className={labelCls}>Model</span>
        {models.length > 0 ? (
          <select
            value={models.includes(provider === 'bedrock' ? awsModel : model) ? (provider === 'bedrock' ? awsModel : model) : ''}
            onChange={(e) => (provider === 'bedrock' ? setAwsModel(e.target.value) : setModel(e.target.value))}
            className={inputCls}
          >
            {!models.includes(provider === 'bedrock' ? awsModel : model) && (
              <option value="" disabled>
                {(provider === 'bedrock' ? awsModel : model)
                  ? `${provider === 'bedrock' ? awsModel : model} (not in list)`
                  : 'Choose a model'}
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
            placeholder={provider === 'bedrock' ? DEFAULT_BEDROCK_MODEL : DEFAULT_MODEL}
            value={provider === 'bedrock' ? awsModel : model}
            onChange={(e) => (provider === 'bedrock' ? setAwsModel(e.target.value) : setModel(e.target.value))}
            className={inputCls}
          />
        )}
        <span className={hintCls}>
          {models.length > 0
            ? provider === 'bedrock'
              ? 'Inference profiles your key can see. Pick a "us." Claude profile; Haiku 4.5 is cheapest, Sonnet is sharper.'
              : 'Live list from your provider — only models your key can use.'
            : modelsError
              ? `Could not fetch model list: ${modelsError}`
              : provider === 'bedrock'
                ? 'Save a key to load your inference profiles, or type an ID like us.anthropic.claude-sonnet-4-5-20250929-v1:0.'
                : 'Save an API key to load the live model list from your provider.'}
        </span>
      </label>

      {provider === 'bedrock' && (
        <div className="flex items-center gap-3">
          <button
            onClick={runAwsTest}
            disabled={!awsHasCreds || awsTest.state === 'running'}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium shadow-sm transition hover:border-slate-300 disabled:opacity-50 dark:border-white/[0.08] dark:bg-ink-900 dark:hover:border-white/20"
          >
            {awsTest.state === 'running' ? 'Testing…' : 'Test connection'}
          </button>
          {awsTest.state === 'ok' && <span className="text-[12px] text-emerald-600 dark:text-emerald-400">{awsTest.detail}</span>}
          {awsTest.state === 'error' && <span className="text-[12px] text-rose-600 dark:text-rose-400">{awsTest.detail}</span>}
          {awsTest.state === 'idle' && !awsHasCreds && <span className={hintCls}>Save a key first.</span>}
        </div>
      )}

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
            <option value={5}>Every 5 minutes</option>
            <option value={15}>Every 15 minutes</option>
            <option value={30}>Every 30 minutes</option>
            <option value={60}>Every hour</option>
          </select>
          <span className={hintCls}>
            Checks your watchlist companies&apos; job boards and the ApplyGuy feed every tick, the larger
            public feeds every 15 minutes (only re-downloaded when they changed), then scores new
            postings against your profile. Tier and watchlist companies are scored first, then the newest arrivals.
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

      <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-white/[0.08]">
        <span className={labelCls}>School</span>

        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium">Canvas calendar feed</span>
          {schoolHasFeed ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] dark:border-white/[0.08] dark:bg-ink-900">
              <span>
                Connected to <span className="font-medium">{schoolFeedHost}</span>
              </span>
              <button onClick={clearSchoolFeed} className="text-[11.5px] font-semibold text-rose-600 hover:underline dark:text-rose-400">
                Remove
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="password"
                value={schoolFeedUrl}
                onChange={(e) => setSchoolFeedUrl(e.target.value)}
                placeholder="https://canvas.…/feeds/calendars/user_….ics"
                autoComplete="off"
                className={inputCls}
              />
              <button onClick={saveSchoolFeed} disabled={!schoolFeedUrl.trim() || schoolFeedState.state === 'saving'} className="shrink-0 rounded-lg bg-gray-900 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50 dark:bg-accent">
                {schoolFeedState.state === 'saving' ? 'Checking…' : 'Connect'}
              </button>
            </div>
          )}
          {schoolFeedState.state === 'ok' && <p className="text-[12px] text-emerald-600 dark:text-emerald-400">{schoolFeedState.detail}</p>}
          {schoolFeedState.state === 'error' && <p className="text-[12px] text-rose-600 dark:text-rose-400">{schoolFeedState.detail}</p>}
          <span className={hintCls}>
            In Canvas: Calendar → Calendar Feed (bottom right) → copy the link. It contains a private token that lets anyone see your
            schedule, so it is stored encrypted in the macOS keychain and never shown again here. If it ever leaks, regenerate it
            on that same Canvas page.
          </span>
        </div>

        <label className="block space-y-1.5">
          <span className="block text-[13px] font-medium">Check Canvas</span>
          <select value={schoolPoll} onChange={(e) => changeSchoolPoll(Number(e.target.value))} className={inputCls}>
            <option value={0}>Off</option>
            <option value={60}>Every hour</option>
            <option value={180}>Every 3 hours</option>
            <option value={360}>Every 6 hours</option>
          </select>
        </label>

        <label className="block space-y-1.5">
          <span className="block text-[13px] font-medium">Put deadlines on the task list</span>
          <select value={schoolHorizon} onChange={(e) => changeSchoolHorizon(Number(e.target.value))} className={inputCls}>
            <option value={0}>Never — School tab only</option>
            <option value={2}>Due within 2 days</option>
            <option value={3}>Due within 3 days</option>
            <option value={7}>Due within 7 days</option>
            <option value={14}>Due within 14 days</option>
            <option value={21}>Due within 21 days</option>
            <option value={30}>Due within 30 days</option>
          </select>
          <span className={hintCls}>
            Each School deadline inside this window becomes a task (track: School). Marking either one done completes both. Shrinking the
            window removes mirrored tasks you have not edited; ones you touched stay.
          </span>
        </label>
      </div>

      <div className="space-y-2">
        <button
          onClick={save}
          className="rounded-lg bg-gray-900 px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition hover:bg-gray-700 dark:bg-accent dark:text-white dark:shadow-[0_0_16px_rgba(94,106,210,0.35)] dark:hover:bg-accent-hover"
        >
          {saved ? 'Saved ✓' : 'Save'}
        </button>
        {saveError && <p className="text-[12px] text-rose-600 dark:text-rose-400">{saveError}</p>}
      </div>

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
