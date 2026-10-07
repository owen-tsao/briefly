import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

/**
 * A render error anywhere in the tree used to unmount everything, leaving an empty popover with no
 * hint of what went wrong (an older build reading a newer tasks.json did exactly that). Catch it,
 * say so, and offer a reload.
 */
class RootBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  componentDidCatch(error: Error): void {
    console.error('[briefly] renderer crashed:', error)
  }
  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-[12px] text-gray-600 dark:text-zinc-300">
        <div className="text-[13px] font-semibold">briefly hit an error while drawing this view</div>
        <div className="max-w-[320px] break-words font-mono text-[10.5px] text-gray-400 dark:text-zinc-500">{this.state.error.message}</div>
        <button
          onClick={() => window.location.reload()}
          className="rounded-lg bg-gray-900 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-gray-700 dark:bg-accent dark:hover:bg-accent-hover"
        >
          Reload
        </button>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </React.StrictMode>
)
