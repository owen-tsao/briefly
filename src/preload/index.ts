import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppState,
  AskResult,
  Horizon,
  NoteSummary,
  Priority,
  RefreshResult,
  SettingsUpdate,
  SettingsView,
  TaskState,
  Track
} from '../shared/types'
import type { JobStatus, JobsView, ProfileFile } from '../shared/jobs'
import type { LmsKind, QuickAddInput, RuleInput, SchoolView, SyllabusParseResult, SyllabusSuggestion } from '../shared/school'

export interface JobsScanOutcome {
  ok: boolean
  added: number
  scored: number
  errors: string[]
  view: JobsView
}

export type SchoolResult<T = object> = ({ ok: true } & T & { view: SchoolView }) | { ok: false; error: string; view: SchoolView }

export interface SchoolApi {
  getSchool: () => Promise<SchoolView>
  onSchoolChanged: (callback: (view: SchoolView) => void) => () => void
  pollSchoolNow: () => Promise<SchoolResult<{ added: number }>>
  /** Call after saving a new feed URL in Settings so the tab fills in immediately. */
  schoolFeedChanged: () => Promise<SchoolView>
  addSchoolItem: (input: QuickAddInput) => Promise<SchoolResult<{ id: string }>>
  setSchoolDone: (id: string, done: boolean) => Promise<SchoolView>
  setSchoolHidden: (id: string, hidden: boolean) => Promise<SchoolView>
  deleteSchoolItem: (id: string) => Promise<SchoolView>
  saveSchoolRule: (input: RuleInput) => Promise<SchoolResult<{ id: string }>>
  deleteSchoolRule: (id: string) => Promise<SchoolView>
  setSchoolCourse: (course: string, patch: { name?: string; hidden?: boolean; hideEvents?: boolean }) => Promise<SchoolView>
  openSchoolUrl: (url: string) => Promise<void>
  /** useDialog opens the OS picker; otherwise pass pasted text. Returns proposals only. */
  parseSyllabus: (input: { useDialog?: boolean; text?: string; courseHint?: string }) => Promise<SyllabusParseResult>
  acceptSyllabusSuggestions: (input: {
    suggestions: SyllabusSuggestion[]
    termStart?: string
    termEnd?: string
  }) => Promise<SchoolResult<{ added: number; skipped: number; errors: string[] }>>
  /** Opens the sign-in page in briefly's browser and waits (up to 5 min) for you to log in; then syncs once. */
  connectLms: (kind: LmsKind) => Promise<SchoolResult<{ warning: string | null }>>
  syncLms: (kind: LmsKind) => Promise<SchoolResult<{ added: number; updated: number; suggested: number }>>
  disconnectLms: (kind: LmsKind) => Promise<SchoolView>
  /** Accept (store as a deadline) or dismiss a date the model read in an announcement. */
  resolveAnnouncement: (id: string, accept: boolean) => Promise<SchoolResult>
}

export interface BrieflyApi extends SchoolApi {
  getState: () => Promise<AppState>
  refresh: () => Promise<RefreshResult>
  setTaskState: (id: string, state: TaskState, snoozedUntil?: string) => Promise<AppState>
  updateTaskText: (id: string, text: string) => Promise<AppState>
  addTask: (text: string) => Promise<AppState>
  setTaskRecurrence: (id: string, recurrence: 'daily' | null) => Promise<AppState>
  setTaskHorizon: (id: string, horizon: Horizon) => Promise<AppState>
  setTaskTrack: (id: string, track: Track) => Promise<AppState>
  setTaskPriority: (id: string, priority: Priority) => Promise<AppState>
  /** Pin/unpin a task as a must-finish for today; shown in the pinned box on the Tasks tab. */
  setTaskPinned: (id: string, pinned: boolean) => Promise<AppState>
  dismissTodayItem: (text: string) => Promise<AppState>
  endDay: () => Promise<AppState>
  reopenDay: () => Promise<AppState>
  ask: (question: string) => Promise<AskResult>
  openNote: (title: string) => Promise<void>
  getSettings: () => Promise<SettingsView>
  /** Fails softly (ok: false) on validation errors such as a malformed AWS key. */
  saveSettings: (update: SettingsUpdate) => Promise<{ ok: boolean; error?: string; view: SettingsView }>
  listModels: () => Promise<{ ok: boolean; models?: string[]; error?: string }>
  /** One tiny call to Bedrock with the saved credentials and model. */
  testBedrock: () => Promise<{ ok: boolean; ms?: number; tokens?: number; error?: string }>
  getLaunchAtLogin: () => Promise<boolean>
  setLaunchAtLogin: (enabled: boolean) => Promise<boolean>
  listNotes: () => Promise<{ ok: boolean; notes?: NoteSummary[]; error?: string }>
  extractNote: (title: string, modified: string | null) => Promise<RefreshResult>
  /** Fires when the main process refreshes state in the background. Returns unsubscribe. */
  onStateChanged: (callback: (state: AppState) => void) => () => void
  /** Fires when a background jobs scan changes the pipeline. Returns unsubscribe. */
  onJobsChanged: (callback: (view: JobsView) => void) => () => void
  getJobs: () => Promise<JobsView>
  setJobStatus: (id: string, status: JobStatus) => Promise<JobsView>
  setJobNote: (id: string, note: string) => Promise<JobsView>
  /** Clear a rule-made skip and send the posting to the LLM instead. */
  scoreJobAnyway: (id: string) => Promise<JobsView>
  promoteJob: (id: string) => Promise<JobsView>
  openProfile: (name: ProfileFile['name'] | null) => Promise<void>
  openUrl: (url: string) => Promise<void>
  /**
   * Apply. Supported systems (Greenhouse, Ashby, Lever, Workday, jobright) open in briefly's own
   * browser and get filled (`via: 'browser'`); others go to Aside. `error` explains a refused start.
   */
  applyJob: (id: string) => Promise<{ via: 'cli' | 'clipboard' | 'browser' | null; error?: string; view: JobsView }>
  /** Hand a card to Aside even when briefly's browser could fill it. */
  applyJobWithAside: (id: string) => Promise<{ via: 'cli' | 'clipboard' | null; view: JobsView }>
  /** Bring a prepared card's browser tab forward; false if that tab is gone. */
  focusPreparedJob: (id: string) => Promise<boolean>
  /** Fill the first `limit` supported cards among `ids`, one after another, leaving the tabs open. */
  prepareJobs: (ids: string[], limit: number) => Promise<{ started: number; skipped: number; error: string | null; view: JobsView }>
  copyJobPrompt: (id: string) => Promise<boolean>
  unpromoteJob: (id: string) => Promise<JobsView>
  /** Writes ~/Downloads/briefly-applications-<date>.csv and reveals it; null on failure. */
  exportJobsCsv: () => Promise<string | null>
  /** Parses a MyGreenhouse "applications" paste from the clipboard and marks those postings applied. */
  importJobsClipboard: () => Promise<{ parsed: number; matched: number; created: number; skipped: number; view: JobsView }>
  scanJobsNow: () => Promise<JobsScanOutcome>
  /** Paste a posting URL: creates (or resurfaces) a card you can apply from; screened on the next drain. */
  addJobLink: (url: string) => Promise<{ id: string | null; existed: boolean; error: string | null; view: JobsView }>
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
  setTaskPinned: (id, pinned) => ipcRenderer.invoke('task:setPinned', id, pinned),
  dismissTodayItem: (text) => ipcRenderer.invoke('today:dismiss', text),
  endDay: () => ipcRenderer.invoke('day:end'),
  reopenDay: () => ipcRenderer.invoke('day:reopen'),
  ask: (question) => ipcRenderer.invoke('ask', question),
  openNote: (title) => ipcRenderer.invoke('notes:open', title),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (update) => ipcRenderer.invoke('settings:save', update),
  listModels: () => ipcRenderer.invoke('models:list'),
  testBedrock: () => ipcRenderer.invoke('bedrock:test'),
  getLaunchAtLogin: () => ipcRenderer.invoke('login:get'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('login:set', enabled),
  listNotes: () => ipcRenderer.invoke('notes:list'),
  extractNote: (title, modified) => ipcRenderer.invoke('notes:extract', title, modified),
  onStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState): void => callback(state)
    ipcRenderer.on('state:changed', listener)
    return () => ipcRenderer.removeListener('state:changed', listener)
  },
  onJobsChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, view: JobsView): void => callback(view)
    ipcRenderer.on('jobs:changed', listener)
    return () => ipcRenderer.removeListener('jobs:changed', listener)
  },
  getJobs: () => ipcRenderer.invoke('jobs:get'),
  setJobStatus: (id, status) => ipcRenderer.invoke('jobs:setStatus', id, status),
  setJobNote: (id, note) => ipcRenderer.invoke('jobs:setNote', id, note),
  scoreJobAnyway: (id) => ipcRenderer.invoke('jobs:scoreAnyway', id),
  promoteJob: (id) => ipcRenderer.invoke('jobs:promote', id),
  openProfile: (name) => ipcRenderer.invoke('jobs:openProfile', name),
  openUrl: (url) => ipcRenderer.invoke('jobs:openUrl', url),
  applyJob: (id) => ipcRenderer.invoke('jobs:apply', id),
  applyJobWithAside: (id) => ipcRenderer.invoke('jobs:applyWithAside', id),
  focusPreparedJob: (id) => ipcRenderer.invoke('jobs:focusPrepared', id),
  prepareJobs: (ids, limit) => ipcRenderer.invoke('jobs:prepareMany', ids, limit),
  copyJobPrompt: (id) => ipcRenderer.invoke('jobs:copyPrompt', id),
  unpromoteJob: (id) => ipcRenderer.invoke('jobs:unpromote', id),
  exportJobsCsv: () => ipcRenderer.invoke('jobs:exportCsv'),
  importJobsClipboard: () => ipcRenderer.invoke('jobs:importClipboard'),
  scanJobsNow: () => ipcRenderer.invoke('jobs:scanNow'),
  addJobLink: (url) => ipcRenderer.invoke('jobs:addLink', url),
  quit: () => ipcRenderer.invoke('app:quit'),
  getSchool: () => ipcRenderer.invoke('school:get'),
  onSchoolChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, view: SchoolView): void => callback(view)
    ipcRenderer.on('school:changed', listener)
    return () => ipcRenderer.removeListener('school:changed', listener)
  },
  pollSchoolNow: () => ipcRenderer.invoke('school:pollNow'),
  schoolFeedChanged: () => ipcRenderer.invoke('school:feedChanged'),
  addSchoolItem: (input) => ipcRenderer.invoke('school:addItem', input),
  setSchoolDone: (id, done) => ipcRenderer.invoke('school:setDone', id, done),
  setSchoolHidden: (id, hidden) => ipcRenderer.invoke('school:setHidden', id, hidden),
  deleteSchoolItem: (id) => ipcRenderer.invoke('school:deleteItem', id),
  saveSchoolRule: (input) => ipcRenderer.invoke('school:saveRule', input),
  deleteSchoolRule: (id) => ipcRenderer.invoke('school:deleteRule', id),
  setSchoolCourse: (course, patch) => ipcRenderer.invoke('school:setCourse', course, patch),
  openSchoolUrl: (url) => ipcRenderer.invoke('school:openUrl', url),
  parseSyllabus: (input) => ipcRenderer.invoke('school:parseSyllabus', input),
  acceptSyllabusSuggestions: (input) => ipcRenderer.invoke('school:acceptSuggestions', input),
  connectLms: (kind) => ipcRenderer.invoke('school:connectLms', kind),
  syncLms: (kind) => ipcRenderer.invoke('school:syncLms', kind),
  disconnectLms: (kind) => ipcRenderer.invoke('school:disconnectLms', kind),
  resolveAnnouncement: (id, accept) => ipcRenderer.invoke('school:resolveAnnouncement', id, accept)
}

contextBridge.exposeInMainWorld('briefly', api)
