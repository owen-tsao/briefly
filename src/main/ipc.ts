import { ipcMain, app } from 'electron'
import { getState, setTaskState, updateTaskText, dismissTodayItem } from './taskStore'
import { getSettingsView, saveSettings, getApiKey } from './settings'
import { refresh, ask, listNotes, extractFromNote } from './agent'
import { listModels } from './llm'
import type { TaskState } from '../shared/types'

export function registerIpc(): void {
  ipcMain.handle('state:get', () => getState(Boolean(getApiKey())))

  ipcMain.handle('state:refresh', () => refresh())

  ipcMain.handle('task:setState', (_event, id: string, state: TaskState) => {
    setTaskState(id, state)
    return getState(Boolean(getApiKey()))
  })

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

  ipcMain.handle('notes:extract', (_event, title: string, modified: string | null) =>
    extractFromNote(title, modified)
  )

  ipcMain.handle('settings:get', () => getSettingsView())

  ipcMain.handle('models:list', async () => {
    try {
      return { ok: true, models: await listModels() }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('settings:save',
    (_event, update: { baseUrl?: string; model?: string; apiKey?: string }) => saveSettings(update)
  )

  ipcMain.handle('login:get', () => app.getLoginItemSettings().openAtLogin)

  ipcMain.handle('login:set', (_event, enabled: boolean) => {
    if (typeof enabled === 'boolean') app.setLoginItemSettings({ openAtLogin: enabled })
    return app.getLoginItemSettings().openAtLogin
  })

  ipcMain.handle('app:quit', () => app.quit())
}
