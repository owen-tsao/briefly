import { useState } from 'react'
import { CornerDownLeft, Loader2 } from 'lucide-react'

export function AskView({ hasApiKey }: { hasApiKey: boolean }): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const q = question.trim()
    if (!q || loading) return
    setLoading(true)
    setError(null)
    setAnswer(null)
    const result = await window.briefly.ask(q)
    if (result.ok) setAnswer(result.answer ?? '')
    else setError(result.error ?? 'Something went wrong.')
    setLoading(false)
  }

  if (!hasApiKey) {
    return (
      <p className="px-6 py-10 text-center text-[13px] leading-relaxed text-gray-500 dark:text-zinc-400">
        Add an API key in Settings to ask questions about your notes.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          disabled={loading}
          placeholder="What should I focus on in the next hour?"
          className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-3.5 pr-10 text-[13px] shadow-[0_1px_3px_rgba(0,0,0,0.04)] outline-none transition focus:border-gray-400 disabled:opacity-60 dark:border-white/[0.08] dark:bg-ink-900 dark:focus:border-accent"
        />
        <button
          onClick={submit}
          disabled={loading || !question.trim()}
          title="Ask"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg bg-gray-900 p-1.5 text-white transition hover:bg-gray-700 disabled:opacity-30 dark:bg-accent dark:text-white dark:shadow-[0_0_16px_rgba(94,106,210,0.35)] dark:hover:bg-accent-hover"
        >
          {loading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <CornerDownLeft size={12} />
          )}
        </button>
      </div>

      {loading && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-gray-500 dark:text-zinc-400">
          Reading your notes…
        </p>
      )}
      {error && (
        <p className="select-text px-1 text-xs leading-relaxed text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {answer && (
        <div className="select-text whitespace-pre-wrap rounded-xl border border-slate-200/80 bg-white/90 p-3.5 text-[13px] leading-relaxed shadow-[0_1px_3px_rgba(0,0,0,0.04)] backdrop-blur dark:border-white/[0.08] dark:bg-ink-900/90">
          {answer}
        </div>
      )}
      {!answer && !loading && !error && (
        <p className="px-1 text-xs leading-relaxed text-gray-400 dark:text-zinc-500">
          Answers use your full notes context — try &quot;what deadlines am I forgetting?&quot; or
          &quot;summarize where my job apps stand&quot;.
        </p>
      )}
    </div>
  )
}
