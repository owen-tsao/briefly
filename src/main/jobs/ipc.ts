import { clipboard, ipcMain, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JobStatus, JobsView, ProfileFile } from '../../shared/jobs'
import { JOB_STATUSES } from '../../shared/jobs'
import { addTask, removeTask } from '../taskStore'
import { updateTrayCount } from '../tray'
import { ensureProfile, PROFILE_FILES, profileDir } from './profile'
import {
  addManualItem,
  getItem,
  getUserState,
  getView,
  loadFixture,
  requestLlmScore,
  setNote,
  setPromotedTask,
  setStatus
} from './jobsStore'
import { copyApplyPrompt, launchApply } from './apply'
import { focusPrepared, prepareApplication, prepareBatch, supportedAts } from './browser/prepare'
import { exportTrackerCsv } from './exportCsv'
import { importApplied, parseGreenhousePaste } from './importApplied'
import { hostToCompany, slugTitle } from './normalize'
import { kickScoring, runJobsScan } from './pipeline'
import { toItem } from './sources/common'

function view(): JobsView {
  ensureProfile()
  return getView()
}

export function registerJobsIpc(): void {
  // Dev aid: BRIEFLY_JOBS_FIXTURE=/path/to/jobs.sample.json seeds the items list at startup.
  if (process.env.BRIEFLY_JOBS_FIXTURE) {
    try {
      loadFixture(JSON.parse(readFileSync(process.env.BRIEFLY_JOBS_FIXTURE, 'utf8')))
    } catch (err) {
      console.warn('[jobs] fixture load failed', err)
    }
  }

  ipcMain.handle('jobs:get', () => view())

  /**
   * Paste a posting link. It becomes a card immediately (company and title guessed from the URL),
   * is screened like any other posting on the next drain, and can be handed to Aside right away.
   */
  ipcMain.handle('jobs:addLink', (_event, raw: string) => {
    const text = typeof raw === 'string' ? raw.trim() : ''
    const m = text.match(/https?:\/\/[^\s<>"']+/i)
    if (!m) return { id: null, existed: false, error: 'That does not look like a link.', view: view() }
    if (m[0].length > 2000) return { id: null, existed: false, error: 'That link is too long to be a posting.', view: view() }
    let url: URL
    try {
      url = new URL(m[0])
    } catch {
      return { id: null, existed: false, error: 'That does not look like a link.', view: view() }
    }
    // Apply and Open only act on https (see jobs:apply / jobs:openUrl), so a plain-http card would be a dud.
    if (url.protocol !== 'https:') {
      return { id: null, existed: false, error: 'Only https links can be added.', view: view() }
    }
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) {
      return { id: null, existed: false, error: 'Local addresses cannot be added.', view: view() }
    }
    const href = url.href
    const { id, existed } = addManualItem(
      (u) =>
        toItem({
          source: 'manual',
          company: hostToCompany(u),
          title: slugTitle(u) || 'Posting you added',
          url: u
        }),
      href
    )
    void kickScoring()
    updateTrayCount()
    return { id, existed, error: null, view: view() }
  })

  ipcMain.handle('jobs:setStatus', (_event, id: string, status: JobStatus) => {
    if (typeof id === 'string' && JOB_STATUSES.includes(status)) {
      setStatus(id, status)
      updateTrayCount()
    }
    return view()
  })

  ipcMain.handle('jobs:setNote', (_event, id: string, note: string) => {
    if (typeof id === 'string' && typeof note === 'string') setNote(id, note)
    return view()
  })

  /** "Score anyway" on a rule reject: clear the rule verdict and queue the posting for the LLM. */
  ipcMain.handle('jobs:scoreAnyway', (_event, id: string) => {
    if (typeof id === 'string' && requestLlmScore(id)) void kickScoring()
    return view()
  })

  /** "Add to Today": create a task on the board and remember the link. Never automatic, never twice. */
  ipcMain.handle('jobs:promote', (_event, id: string) => {
    if (typeof id === 'string') {
      const item = getItem(id)
      if (item && !getUserState(id)?.promotedTaskId) {
        const taskId = addTask(`Apply: ${item.company} — ${item.title}`, {
          sourceNote: 'jobs',
          track: 'job-apps',
          deadline: item.deadline,
          priority: 'medium'
        })
        if (taskId) setPromotedTask(id, taskId)
        updateTrayCount()
      }
    }
    return view()
  })

  ipcMain.handle('jobs:openProfile', async (_event, name: ProfileFile['name'] | null) => {
    ensureProfile()
    const dir = profileDir()
    if (name && PROFILE_FILES.includes(name)) await shell.openPath(join(dir, name))
    else await shell.openPath(dir)
  })

  ipcMain.handle('jobs:openUrl', async (_event, url: string) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url) && url.length <= 2000) {
      await shell.openExternal(url)
    }
  })

  /**
   * Apply. Supported ATSs (Greenhouse, Ashby, Lever, Workday, jobright wrappers) open in briefly's
   * own browser and get filled from your profile; anything else is handed to Aside as before.
   * Neither path ever presses Submit.
   */
  ipcMain.handle('jobs:apply', async (_event, id: string) => {
    if (typeof id !== 'string') return { via: null, view: view() }
    const item = getItem(id)
    if (!item || !/^https:\/\//i.test(item.url)) return { via: null, view: view() }
    // Events have no application form; register in the browser instead.
    if (item.kind === 'event') {
      await shell.openExternal(item.url)
      return { via: null, view: view() }
    }
    // A jobright wrapper that already resolved goes straight to the employer page.
    const startUrl = getUserState(id)?.resolvedUrl ?? item.url
    if (supportedAts(startUrl)) {
      const r = await prepareApplication(item, { startUrl })
      updateTrayCount()
      if (r.ok) return { via: 'browser' as const, view: view() }
      return { via: null, error: r.error, view: view() }
    }
    const { via } = await launchApply(item)
    setStatus(id, 'applying')
    updateTrayCount()
    return { via, view: view() }
  })

  /** Explicit Aside hand-off even for a supported ATS (e.g. the auto-fill got stuck). */
  ipcMain.handle('jobs:applyWithAside', async (_event, id: string) => {
    if (typeof id !== 'string') return { via: null, view: view() }
    const item = getItem(id)
    if (!item || !/^https:\/\//i.test(item.url) || item.kind === 'event') return { via: null, view: view() }
    // Hand Aside the employer page if a wrapper link already resolved to one.
    const resolved = getUserState(id)?.resolvedUrl
    const { via } = await launchApply(resolved ? { ...item, url: resolved } : item)
    setStatus(id, 'applying')
    updateTrayCount()
    return { via, view: view() }
  })

  /** Bring a prepared card's browser tab forward. False when the tab is gone, so the UI offers Apply again. */
  ipcMain.handle('jobs:focusPrepared', async (_event, id: string) => {
    if (typeof id !== 'string') return false
    return focusPrepared(id)
  })

  /**
   * Prepare several cards at once (the renderer sends its Apply-now order). Takes the first `limit`
   * on a supported ATS, fills them one after another, and leaves the tabs open for review.
   */
  ipcMain.handle('jobs:prepareMany', async (_event, ids: string[], limit: number) => {
    const n = Math.max(1, Math.min(10, Number(limit) || 3))
    const items = (Array.isArray(ids) ? ids : [])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => getItem(x))
      .filter((it): it is NonNullable<typeof it> => Boolean(it && it.active && it.kind !== 'event' && /^https:\/\//i.test(it.url)))
      .filter((it) => {
        const status = getUserState(it.id)?.status ?? 'new'
        return (status === 'new' || status === 'saved') && supportedAts(getUserState(it.id)?.resolvedUrl ?? it.url)
      })
      .slice(0, n)
    const r = await prepareBatch(items, (id) => getUserState(id)?.resolvedUrl ?? null)
    updateTrayCount()
    return { ...r, view: view() }
  })

  ipcMain.handle('jobs:copyPrompt', (_event, id: string) => {
    if (typeof id !== 'string') return false
    const item = getItem(id)
    if (!item) return false
    copyApplyPrompt(item)
    return true
  })

  /** Undo "Add to Today": remove the task it created (if still untouched) and forget the link. */
  ipcMain.handle('jobs:unpromote', (_event, id: string) => {
    if (typeof id === 'string') {
      const taskId = getUserState(id)?.promotedTaskId
      if (taskId) removeTask(taskId)
      setPromotedTask(id, null)
      updateTrayCount()
    }
    return view()
  })

  ipcMain.handle('jobs:scanNow', async () => {
    const result = await runJobsScan({ force: true })
    updateTrayCount()
    return { ...result, view: view() }
  })

  ipcMain.handle('jobs:exportCsv', () => {
    try {
      return exportTrackerCsv(getView().rows)
    } catch (err) {
      console.warn('[jobs] csv export failed', err)
      return null
    }
  })

  /** Import applications from a MyGreenhouse select-all → copy. Reads the clipboard only when you click. */
  ipcMain.handle('jobs:importClipboard', () => {
    const text = clipboard.readText().slice(0, 500_000)
    const apps = parseGreenhousePaste(text)
    const result = apps.length ? importApplied(apps) : { matched: 0, created: 0, skipped: 0 }
    if (apps.length) updateTrayCount()
    return { parsed: apps.length, ...result, view: view() }
  })
}
