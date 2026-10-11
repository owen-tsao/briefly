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
  setTaskPriority,
  setTaskPinned,
  reorderPinned,
  endDay,
  reopenDay
} from './taskStore'
import { getBedrockConfig, getBedrockCredentials, getSettingsView, saveSettings, llmConfigured } from './settings'
import { refresh, ask, listNotes, extractFromNote } from './agent'
import { openNote } from './notes'
import { listModels } from './llm'
import { testConnection } from './bedrock'
import { updateTrayCount } from './tray'
import { scheduleAutoRescan } from './scheduler'
import { registerJobsIpc } from './jobs/ipc'
import { scheduleJobsScan } from './jobs/pipeline'
import { registerSchoolIpc } from './school/ipc'
import { scheduleSchoolPoll, syncTasks } from './school/school'
import type { Horizon, Priority, SettingsUpdate, TaskState, Track } from '../shared/types'
import { HORIZONS, TRACKS } from '../shared/types'

const TASK_STATES: TaskState[] = ['open', 'done', 'snoozed', 'dismissed', 'archived']
const PRIORITIES: Priority[] = ['high', 'medium', 'low']

export function registerIpc(): void {
  registerJobsIpc()
  registerSchoolIpc()
  ipcMain.handle('state:get', () => getState(llmConfigured()))

  ipcMain.handle('state:refresh', async () => {
    const result = await refresh()
    updateTrayCount()
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
      return getState(llmConfigured())
    }
  )

  ipcMain.handle('task:updateText', (_event, id: string, text: string) => {
    if (typeof id === 'string' && typeof text === 'string') updateTaskText(id, text)
    return getState(llmConfigured())
  })

  ipcMain.handle('task:add', (_event, text: string) => {
    if (typeof text === 'string' && text.trim()) {
      addTask(text)
      updateTrayCount()
    }
    return getState(llmConfigured())
  })

  ipcMain.handle('task:setRecurrence', (_event, id: string, recurrence: 'daily' | null) => {
    if (typeof id === 'string' && (recurrence === 'daily' || recurrence === null)) {
      setTaskRecurrence(id, recurrence)
    }
    return getState(llmConfigured())
  })

  ipcMain.handle('task:setHorizon', (_event, id: string, horizon: Horizon) => {
    if (typeof id === 'string' && HORIZONS.includes(horizon)) setTaskHorizon(id, horizon)
    return getState(llmConfigured())
  })

  ipcMain.handle('task:setTrack', (_event, id: string, track: Track) => {
    if (typeof id === 'string' && TRACKS.includes(track)) {
      setTaskTrack(id, track)
      // Moving a task onto (or off) the School track shows/hides its row in the School tab right away.
      syncTasks()
    }
    return getState(llmConfigured())
  })

  ipcMain.handle('task:setPriority', (_event, id: string, priority: Priority) => {
    if (typeof id === 'string' && PRIORITIES.includes(priority)) setTaskPriority(id, priority)
    return getState(llmConfigured())
  })

  ipcMain.handle('task:setPinned', (_event, id: string, pinned: boolean) => {
    if (typeof id === 'string' && typeof pinned === 'boolean') setTaskPinned(id, pinned)
    return getState(llmConfigured())
  })

  ipcMain.handle('task:reorderPinned', (_event, ids: unknown) => {
    if (Array.isArray(ids) && ids.length <= 200 && ids.every((x) => typeof x === 'string')) reorderPinned(ids as string[])
    return getState(llmConfigured())
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

  ipcMain.handle('today:dismiss', (_event, text: string) => {
    if (typeof text === 'string') dismissTodayItem(text)
    return getState(llmConfigured())
  })

  ipcMain.handle('day:end', () => {
    endDay()
    updateTrayCount()
    return getState(llmConfigured())
  })

  ipcMain.handle('day:reopen', () => {
    reopenDay()
    updateTrayCount()
    return getState(llmConfigured())
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

  ipcMain.handle('settings:save', (_event, update: SettingsUpdate) => {
    if (!update || typeof update !== 'object') return { ok: false as const, error: 'Bad settings payload.', view: getSettingsView() }
    try {
      const view = saveSettings(update)
      scheduleAutoRescan()
      scheduleJobsScan()
      scheduleSchoolPoll()
      updateTrayCount()
      return { ok: true as const, view }
    } catch (err: unknown) {
      // Validation failures (malformed key, keychain unavailable) come back as messages, never thrown
      // across IPC where Electron would serialize the whole error.
      return { ok: false as const, error: err instanceof Error ? err.message : 'Could not save settings.', view: getSettingsView() }
    }
  })

  /**
   * One tiny Bedrock call with the stored credentials, so a bad key, region, or model shows up
   * in Settings instead of as a silent screening stall. Only ever uses what is already saved.
   */
  ipcMain.handle('bedrock:test', async () => {
    const credentials = getBedrockCredentials()
    if (!credentials) return { ok: false, error: 'Save an access key pair first.' }
    try {
      const { region, model } = getBedrockConfig()
      const r = await testConnection(region, model, credentials)
      return { ok: true, ms: r.ms, tokens: r.tokens }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('login:get', () => app.getLoginItemSettings().openAtLogin)

  ipcMain.handle('login:set', (_event, enabled: boolean) => {
    if (typeof enabled === 'boolean') app.setLoginItemSettings({ openAtLogin: enabled })
    return app.getLoginItemSettings().openAtLogin
  })

  ipcMain.handle('app:quit', () => app.quit())
}
