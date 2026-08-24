import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppState,
  AskResult,
  Horizon,
  NoteSummary,
  Priority,
  RefreshResult,
  SettingsView,
  TaskState,
  Track
} from '../shared/types'

export interface BrieflyApi {
  getState: () => Promise<AppState>
  refresh: () => Promise<RefreshResult>
  setTaskState: (id: string, state: TaskState, snoozedUntil?: string) => Promise<AppState>
  updateTaskText: (id: string, text: string) => Promise<AppState>
  addTask: (text: string) => Promise<AppState>
  setTaskRecurrence: (id: string, recurrence: 'daily' | null) => Promise<AppState>
  setTaskHorizon: (id: string, horizon: Horizon) => Promise<AppState>
  setTaskTrack: (id: string, track: Track) => Promise<AppState>
  setTaskPriority: (id: string, priority: Priority) => Promise<AppState>
  dismissTodayItem: (section: 'priorities' | 'changes', text: string) => Promise<AppState>
  ask: (question: string) => Promise<AskResult>
  openNote: (title: string) => Promise<void>
  getSettings: () => Promise<SettingsView>
  saveSettings: (update: {
    baseUrl?: string
    model?: string
    apiKey?: string
    autoRescanMinutes?: number
    notificationsEnabled?: boolean
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
  addTask: (text) => ipcRenderer.invoke('task:add', text),
  setTaskRecurrence: (id, recurrence) => ipcRenderer.invoke('task:setRecurrence', id, recurrence),
  setTaskHorizon: (id, horizon) => ipcRenderer.invoke('task:setHorizon', id, horizon),
  setTaskTrack: (id, track) => ipcRenderer.invoke('task:setTrack', id, track),
  setTaskPriority: (id, priority) => ipcRenderer.invoke('task:setPriority', id, priority),
  dismissTodayItem: (section, text) => ipcRenderer.invoke('today:dismiss', section, text),
  ask: (question) => ipcRenderer.invoke('ask', question),
  openNote: (title) => ipcRenderer.invoke('notes:open', title),
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
