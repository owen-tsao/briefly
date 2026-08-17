export type Track = 'work' | 'leetcode' | 'job-apps' | 'resume' | 'personal' | 'other'

export const TRACKS: Track[] = ['work', 'leetcode', 'job-apps', 'resume', 'personal', 'other']

export const TRACK_LABELS: Record<Track, string> = {
  work: 'Work / Internship',
  leetcode: 'LeetCode',
  'job-apps': 'Job Applications',
  resume: 'Resume',
  personal: 'Personal',
  other: 'Other'
}

export type Priority = 'high' | 'medium' | 'low'

export type TaskState = 'open' | 'done' | 'snoozed' | 'dismissed' | 'archived'

export interface Task {
  id: string
  text: string
  track: Track
  priority: Priority
  deadline: string | null
  sourceNote: string
  state: TaskState
  snoozedUntil: string | null
  /** Set when the user renames a task — scans will never overwrite or archive it. */
  editedByUser?: boolean
  createdAt: string
  updatedAt: string
}

export interface TodayStrip {
  /** Ids of the tasks the LLM scoped to today — rendered live from the board. */
  priorityIds: string[]
  changes: string[]
  generatedAt: string
}

export interface AppState {
  tasks: Task[]
  today: TodayStrip | null
  lastRefreshed: string | null
  hasApiKey: boolean
}

export interface SettingsView {
  baseUrl: string
  model: string
  hasApiKey: boolean
}

export interface RefreshResult {
  ok: boolean
  error?: string
  state?: AppState
}

export interface AskResult {
  ok: boolean
  answer?: string
  error?: string
}

export interface NoteSummary {
  title: string
  modified: string | null
  preview: string
  chars: number
  /** Whether this note's full body is included in scan context (recency window). */
  scanned: boolean
}

export const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1'
export const DEFAULT_MODEL = 'openai/gpt-oss-120b'
