/** Where a posting was first seen. `alsoSeenIn` accumulates the rest. */
export type JobSource = 'ats' | 'applyguy' | 'simplify' | 'speedyapply' | 'jobright' | 'instagram'

export type JobTerm = 'summer-2027' | 'winter-2027' | 'spring-2027' | 'fall-2026' | 'co-op' | 'unknown'

export type JobDecision = 'apply' | 'flagged' | 'skip'

export interface JobVerdict {
  decision: JobDecision
  blockers: string[]
  flags: string[]
  matched: string[]
  missing: string[]
  summary: string
}

export interface JobItem {
  /** sha1(ats:board:jobId) when the ATS is recognized, else sha1 of the normalized url. */
  id: string
  source: JobSource
  alsoSeenIn: JobSource[]
  sourceRef: string | null
  company: string
  title: string
  url: string
  dcLink: boolean
  referralNote: string | null
  /** ISO timestamp. */
  postedAt: string | null
  /** YYYY-MM-DD. */
  deadline: string | null
  location: string | null
  /** Free text as the source gave it, e.g. "$55/hr". */
  pay: string | null
  term: JobTerm
  descriptionAvailable: boolean
  /** Null until the matcher has run. */
  verdict: JobVerdict | null
  seenAt: string
  /** Last time any source still listed this posting. */
  lastSeenAt?: string
  active: boolean
  scoredWithProfileVersion: string | null
}

/** Statuses the user can set. Absent entry means `new`. */
export type JobStatus =
  | 'new'
  | 'saved'
  | 'applying'
  | 'applied'
  | 'oa'
  | 'interview'
  | 'offer'
  | 'rejected'
  | 'skipped'

export const JOB_STATUSES: JobStatus[] = [
  'new',
  'saved',
  'applying',
  'applied',
  'oa',
  'interview',
  'offer',
  'rejected',
  'skipped'
]

/** Outcome statuses shown in the Applied section's dropdown. */
export const OUTCOME_STATUSES: JobStatus[] = ['applied', 'oa', 'interview', 'offer', 'rejected']

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  new: 'New',
  saved: 'Saved',
  applying: 'Applying',
  applied: 'Applied',
  oa: 'OA',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  skipped: 'Skipped'
}

/** Display fields frozen when a posting leaves `new`, so Applied history survives pruning. */
export interface JobSnapshot {
  company: string
  title: string
  url: string
  term: JobTerm
  source: JobSource
}

export interface JobUserState {
  status: JobStatus
  note: string
  promotedTaskId: string | null
  openedInAsideAt: string | null
  snapshot: JobSnapshot
  updatedAt: string
}

/** One row as the renderer sees it: item (possibly pruned → null) merged with user state. */
export interface JobRow {
  id: string
  item: JobItem | null
  state: JobUserState | null
}

export interface ProfileFile {
  name: 'resume.md' | 'preferences.md' | 'answers.md' | 'watchlist.md'
  exists: boolean
  /** ISO, or null when missing. */
  modifiedAt: string | null
}

export interface JobsView {
  rows: JobRow[]
  profileDir: string
  profile: ProfileFile[]
  lastScanAt: string | null
  /** Errors from the most recent scan (source failures, scoring failures). */
  lastErrors: string[]
  /** Active postings still waiting for a verdict (scored in batches each scan). */
  unscored: number
  /** Per-source last successful run. */
  sources: Record<string, { lastRun: string | null; lastError: string | null }>
}
