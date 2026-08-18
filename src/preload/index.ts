import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppState,
  AskResult,
  NoteSummary,
  RefreshResult,
  SettingsView,
  TaskState
} from '../shared/types'

export interface BrieflyApi {
  getState: () => Promise<AppState>
  refresh: () => Promise<RefreshResult>
  setTaskState: (id: string, state: TaskState, snoozedUntil?: string) => Promise<AppState>
  updateTaskText: (id: string, text: string) => Promise<AppState>
  dismissTodayItem: (section: 'priorities' | 'changes', text: string) => Promise<AppState>
  ask: (question: string) => Promise<AskResult>
  getSettings: () => Promise<SettingsView>
  saveSettings: (update: {
    baseUrl?: string
    model?: string
    apiKey?: string
    autoRescanMinutes?: number
  }) => Promise<SettingsView>
  listModels: () => Promise<{ ok: boolean; models?: string[]; error?: string }>
  getLaunchAtLogin: () => Promise<boolean>
  setLaunchAtLogin: (enabled: boolean) => Promise<boolean>
  listNotes: () => Promise<{ ok: boolean; notes?: NoteSummary[]; error?: string }>
  extractNote: (title: string, modified: string | null) => Promise<RefreshResult>
  /** Fires when the main process refreshes state in the background. Returns unsubscribe. */
  onStateChanged: (callback: (state: AppState) => void) => () => void
  quit: () => Promise<void>
}

const api: BrieflyApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  refresh: () => ipcRenderer.invoke('state:refresh'),
  setTaskState: (id, state, snoozedUntil) =>
    ipcRenderer.invoke('task:setState', id, state, snoozedUntil),
  updateTaskText: (id, text) => ipcRenderer.invoke('task:updateText', id, text),
  dismissTodayItem: (section, text) => ipcRenderer.invoke('today:dismiss', section, text),
  ask: (question) => ipcRenderer.invoke('ask', question),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (update) => ipcRenderer.invoke('settings:save', update),
  listModels: () => ipcRenderer.invoke('models:list'),
  getLaunchAtLogin: () => ipcRenderer.invoke('login:get'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('login:set', enabled),
  listNotes: () => ipcRenderer.invoke('notes:list'),
  extractNote: (title, modified) => ipcRenderer.invoke('notes:extract', title, modified),
  onStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState): void => callback(state)
    ipcRenderer.on('state:changed', listener)
    return () => ipcRenderer.removeListener('state:changed', listener)
  },
  quit: () => ipcRenderer.invoke('app:quit')
}

contextBridge.exposeInMainWorld('briefly', api)
