import { ipcMain, app } from 'electron'
import { getState, setTaskState, updateTaskText, dismissTodayItem } from './taskStore'
import { getSettingsView, saveSettings, getApiKey } from './settings'
import { refresh, ask, listNotes, extractFromNote } from './agent'
import { listModels } from './llm'
import { updateTrayCount } from './tray'
import { scheduleAutoRescan } from './scheduler'
import type { TaskState } from '../shared/types'

const TASK_STATES: TaskState[] = ['open', 'done', 'snoozed', 'dismissed', 'archived']

export function registerIpc(): void {
  ipcMain.handle('state:get', () => getState(Boolean(getApiKey())))

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
      return getState(Boolean(getApiKey()))
    }
  )

  ipcMain.handle('task:updateText', (_event, id: string, text: string) => {
    if (typeof id === 'string' && typeof text === 'string') updateTaskText(id, text)
    return getState(Boolean(getApiKey()))
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
    (_event, update: { baseUrl?: string; model?: string; apiKey?: string; autoRescanMinutes?: number }) => {
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
