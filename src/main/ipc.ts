import { ipcMain, app } from 'electron'
import {
  getState,
  setTaskState,
  updateTaskText,
  dismissTodayItem,
  addTask,
  setTaskRecurrence,
  setTaskHorizon,
  setTaskTrack,
  setTaskPriority
} from './taskStore'
import { getSettingsView, saveSettings, getApiKey } from './settings'
import { refresh, ask, listNotes, extractFromNote } from './agent'
import { openNote } from './notes'
import { listModels } from './llm'
import { updateTrayCount } from './tray'
import { scheduleAutoRescan } from './scheduler'
import { notifyDueTasks } from './notifications'
import type { Horizon, Priority, TaskState, Track } from '../shared/types'
import { HORIZONS, TRACKS } from '../shared/types'

const TASK_STATES: TaskState[] = ['open', 'done', 'snoozed', 'dismissed', 'archived']
const PRIORITIES: Priority[] = ['high', 'medium', 'low']

export function registerIpc(): void {
  ipcMain.handle('state:get', () => getState(Boolean(getApiKey())))

  ipcMain.handle('state:refresh', async () => {
    const result = await refresh()
    updateTrayCount()
    if (result.ok) notifyDueTasks()
    return result
  })

  ipcMain.handle(
    'task:setState',
    (_event, id: string, state: TaskState, snoozedUntil?: string) => {
      const until =
        typeof snoozedUntil === 'string' && !Number.isNaN(Date.parse(snoozedUntil))
          ? snoozedUntil
          : undefined
      if (typeof id === 'string' && TASK_STATES.includes(state)) {
        setTaskState(id, state, until)
        updateTrayCount()
      }
      return getState(Boolean(getApiKey()))
    }
  )

  ipcMain.handle('task:updateText', (_event, id: string, text: string) => {
    if (typeof id === 'string' && typeof text === 'string') updateTaskText(id, text)
    return getState(Boolean(getApiKey()))
  })

  ipcMain.handle('task:add', (_event, text: string) => {
    if (typeof text === 'string' && text.trim()) {
      addTask(text)
      updateTrayCount()
    }
    return getState(Boolean(getApiKey()))
  })

  ipcMain.handle('task:setRecurrence', (_event, id: string, recurrence: 'daily' | null) => {
    if (typeof id === 'string' && (recurrence === 'daily' || recurrence === null)) {
      setTaskRecurrence(id, recurrence)
    }
    return getState(Boolean(getApiKey()))
  })

  ipcMain.handle('task:setHorizon', (_event, id: string, horizon: Horizon) => {
    if (typeof id === 'string' && HORIZONS.includes(horizon)) setTaskHorizon(id, horizon)
    return getState(Boolean(getApiKey()))
  })

  ipcMain.handle('task:setTrack', (_event, id: string, track: Track) => {
    if (typeof id === 'string' && TRACKS.includes(track)) setTaskTrack(id, track)
    return getState(Boolean(getApiKey()))
  })

  ipcMain.handle('task:setPriority', (_event, id: string, priority: Priority) => {
    if (typeof id === 'string' && PRIORITIES.includes(priority)) setTaskPriority(id, priority)
    return getState(Boolean(getApiKey()))
  })

  ipcMain.handle('notes:open', async (_event, title: string) => {
    if (typeof title === 'string' && title.length <= 300) {
      try {
        await openNote(title)
      } catch {
        // Best effort — Notes may be blocked by Automation permissions.
      }
    }
  })

  ipcMain.handle('today:dismiss', (_event, section: 'priorities' | 'changes', text: string) => {
    if ((section === 'priorities' || section === 'changes') && typeof text === 'string') {
      dismissTodayItem(section, text)
    }
    return getState(Boolean(getApiKey()))
  })

  ipcMain.handle('ask', (_event, question: string) => ask(question))

  ipcMain.handle('notes:list', () => listNotes())

  ipcMain.handle('notes:extract', async (_event, title: string, modified: string | null) => {
    const result = await extractFromNote(title, modified)
    updateTrayCount()
    return result
  })

  ipcMain.handle('settings:get', () => getSettingsView())

  ipcMain.handle('models:list', async () => {
    try {
      return { ok: true, models: await listModels() }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('settings:save',
    (_event, update: {
      baseUrl?: string
      model?: string
      apiKey?: string
      autoRescanMinutes?: number
      notificationsEnabled?: boolean
    }) => {
      const view = saveSettings(update)
      scheduleAutoRescan()
      return view
    }
  )

  ipcMain.handle('login:get', () => app.getLoginItemSettings().openAtLogin)

  ipcMain.handle('login:set', (_event, enabled: boolean) => {
    if (typeof enabled === 'boolean') app.setLoginItemSettings({ openAtLogin: enabled })
    return app.getLoginItemSettings().openAtLogin
  })

  ipcMain.handle('app:quit', () => app.quit())
}
