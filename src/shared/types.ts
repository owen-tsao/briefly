import type { DayConfig } from './dates'

export type Track = 'work' | 'leetcode' | 'job-apps' | 'resume' | 'school' | 'personal' | 'other'

export const TRACKS: Track[] = ['work', 'leetcode', 'job-apps', 'resume', 'school', 'personal', 'other']

export const TRACK_LABELS: Record<Track, string> = {
  work: 'Work / Internship',
  leetcode: 'LeetCode',
  'job-apps': 'Job Applications',
  resume: 'Resume',
  school: 'School',
  personal: 'Personal',
  other: 'Other'
}

export type Priority = 'high' | 'medium' | 'low'

export type TaskState = 'open' | 'done' | 'snoozed' | 'dismissed' | 'archived'

export type Horizon = 'now' | 'soon' | 'someday'

export const HORIZONS: Horizon[] = ['now', 'soon', 'someday']

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
  /** Daily-recurring tasks reopen each morning after being completed. */
  recurrence?: 'daily' | null
  /** Time bucket: now = today, soon = this week-ish, someday = goals/ideas. */
  horizon?: Horizon
  /** Set when the user changes horizon manually — scans won't move it. */
  horizonPinned?: boolean
  /** Set when the user picks a track manually — scans won't reclassify it. */
  trackPinned?: boolean
  /** Set when the user picks a priority manually — scans won't reclassify it. */
  priorityPinned?: boolean
  /** Pinned = must-finish; stays until done or unpinned. Cleared pins drop off after the day they were finished. */
  pinned?: boolean
  pinnedAt?: string | null
  /** Your rank among pinned tasks (0 = focus on this first). Unset pins sort after ranked ones, by pinnedAt. */
  pinOrder?: number
  /** Verbatim note line this task was extracted from — provenance for reconcile. */
  sourceExcerpt?: string
  /** Last time code confirmed the source line still exists in Notes. Gate for auto-complete. */
  sourceVerifiedAt?: string
  /** Set when the task was completed because its source line/note disappeared. */
  completedVia?: 'notes'
  createdAt: string
  updatedAt: string
}

export interface TodayStrip {
  /** Scan diff: what changed since the previous scan. */
  changes: string[]
  generatedAt: string
}

export interface AppState {
  tasks: Task[]
  today: TodayStrip | null
  lastRefreshed: string | null
  hasApiKey: boolean
  /** Work-day clock config so the renderer computes "today" exactly like the main process. */
  day: DayConfig
}

export interface SettingsView {
  /** Which service answers LLM calls (screening, task extraction, Ask). */
  llmProvider: LlmProvider
  baseUrl: string
  model: string
  hasApiKey: boolean
  bedrock: BedrockSettingsView
  /** Auto-rescan interval in minutes; 0 = off. */
  autoRescanMinutes: number
  /** Native deadline notifications. */
  notificationsEnabled: boolean
  /** Hour (0–8) at which a new work day starts. */
  dayStartHour: number
  /** Jobs profile folder override; empty = ~/.briefly/profile. */
  profileDir: string
  /** Jobs scan interval in minutes; 0 = off. */
  jobsScanMinutes: number
  /** Include the New-jobs count in the menu bar badge. */
  jobsInBadge: boolean
  school: SchoolSettingsView
}

/**
 * The Canvas feed URL contains a per-user secret token (anyone holding it sees your schedule),
 * so like the AWS pair it is stored encrypted and never returned to the renderer — only whether
 * one is set and which host it points at.
 */
export interface SchoolSettingsView {
  hasFeed: boolean
  feedHost: string
  /** Feed poll interval in minutes; 0 = off. */
  pollMinutes: number
  /** Days ahead for which deadlines are mirrored into Tasks. */
  taskHorizonDays: number
}

export type LlmProvider = 'openai' | 'bedrock'

/**
 * What the renderer may know about the Bedrock credentials: whether they exist and the last four
 * characters of the access key ID, so you can tell which key is loaded. The secret never crosses
 * the IPC boundary in either direction except once, on save.
 */
export interface BedrockSettingsView {
  region: string
  model: string
  hasCredentials: boolean
  accessKeyHint: string
}

export interface SettingsUpdate {
  llmProvider?: LlmProvider
  baseUrl?: string
  model?: string
  apiKey?: string
  bedrock?: {
    region?: string
    model?: string
    /** Both must be sent together; sending empty strings clears the stored pair. */
    accessKeyId?: string
    secretAccessKey?: string
  }
  autoRescanMinutes?: number
  notificationsEnabled?: boolean
  dayStartHour?: number
  profileDir?: string
  jobsScanMinutes?: number
  jobsInBadge?: boolean
  school?: {
    /** Sending an empty string clears the stored feed. */
    feedUrl?: string
    pollMinutes?: number
    taskHorizonDays?: number
  }
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
export const DEFAULT_BEDROCK_REGION = 'us-east-1'
/** Haiku 4.5 via its US cross-region inference profile: cheap, fast, and good at JSON. */
export const DEFAULT_BEDROCK_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
