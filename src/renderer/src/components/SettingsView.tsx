import { useEffect, useState } from 'react'
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../../../shared/types'

export function SettingsView({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [saved, setSaved] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)

  useEffect(() => {
    window.briefly.getSettings().then((s) => {
      setBaseUrl(s.baseUrl)
      setModel(s.model)
      setHasApiKey(s.hasApiKey)
      if (s.hasApiKey) loadModels()
    })
  }, [])

  const loadModels = async (): Promise<void> => {
    setModelsError(null)
    const result = await window.briefly.listModels()
    if (result.ok && result.models) setModels(result.models)
    else setModelsError(result.error ?? 'Could not load models.')
  }

  const save = async (): Promise<void> => {
    const update: { baseUrl: string; model: string; apiKey?: string } = { baseUrl, model }
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

      <button
        onClick={save}
        className="rounded-lg bg-gray-900 px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition hover:bg-gray-700 dark:bg-accent dark:text-white dark:shadow-[0_0_16px_rgba(94,106,210,0.35)] dark:hover:bg-accent-hover"
      >
        {saved ? 'Saved ✓' : 'Save'}
      </button>

      <p className="border-t border-slate-200 pt-3 text-[11px] leading-relaxed text-gray-400 dark:border-white/[0.08] dark:text-zinc-500">
        briefly reads your Apple Notes read-only. Locked notes are never read. Task state lives only
        in this app.
      </p>
    </div>
  )
}
