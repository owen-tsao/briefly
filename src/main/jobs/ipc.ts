import { ipcMain, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JobStatus, JobsView, ProfileFile } from '../../shared/jobs'
import { JOB_STATUSES } from '../../shared/jobs'
import { addTask } from '../taskStore'
import { updateTrayCount } from '../tray'
import { ensureProfile, PROFILE_FILES, profileDir } from './profile'
import { getItem, getUserState, getView, loadFixture, setNote, setPromotedTask, setStatus } from './jobsStore'
import { launchApply } from './apply'
import { runJobsScan } from './pipeline'

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

  /** "Add to Today": create a task on the board and remember the link. Never automatic, never twice. */
  ipcMain.handle('jobs:promote', (_event, id: string) => {
    if (typeof id === 'string') {
      const item = getItem(id)
      if (item && !getUserState(id)?.promotedTaskId) {
        const taskId = addTask(`Apply: ${item.company} — ${item.title}`, {
          sourceNote: 'jobs',
          track: 'job-apps',
          deadline: item.deadline
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

  /** Apply hand-off: mark as applying and launch Aside. Never submits anything itself. */
  ipcMain.handle('jobs:apply', async (_event, id: string) => {
    if (typeof id !== 'string') return { via: null, view: view() }
    const item = getItem(id)
    if (!item || !/^https:\/\//i.test(item.url)) return { via: null, view: view() }
    const { via } = await launchApply(item)
    setStatus(id, 'applying')
    updateTrayCount()
    return { via, view: view() }
  })

  ipcMain.handle('jobs:scanNow', async () => {
    const result = await runJobsScan({ force: true })
    updateTrayCount()
    return { ...result, view: view() }
  })
}
