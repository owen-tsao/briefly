/** Where a posting was first seen. `alsoSeenIn` accumulates the rest. */
export type JobSource = 'ats' | 'applyguy' | 'simplify' | 'speedyapply' | 'jobright' | 'instagram' | 'manual'

export type JobTerm = 'summer-2027' | 'winter-2027' | 'spring-2027' | 'fall-2026' | 'co-op' | 'unknown'

export type JobKind = 'posting' | 'event'

export type JobDecision = 'apply' | 'flagged' | 'skip'

export interface JobVerdict {
  decision: JobDecision
  blockers: string[]
  flags: string[]
  matched: string[]
  missing: string[]
  summary: string
  /**
   * Set when a deterministic rule decided this instead of the LLM, e.g. "R2 · PhD or Master's required".
   * `quote` is the text that triggered it, so a wrong call is visible and one click away from a re-score.
   */
  rule?: { id: string; label: string; quote: string } | null
}

export interface JobItem {
  /** sha1(ats:board:jobId) when the ATS is recognized, else sha1 of the normalized url. */
  id: string
  source: JobSource
  /**
   * What the link is. Absent means posting. Events (info sessions, resume drops, hiring
   * mixers) are judged on the access they give — direct consideration, recruiter contact —
   * not on role fit, and are never handed to the Aside apply flow.
   */
  kind?: JobKind
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
  /** User pressed "Score anyway" on a rule reject: bypass rules and let the LLM judge. */
  skipRules?: boolean
  /** Verdict was cleared on purpose (rules.md changed); re-score even if the posting is old. */
  rescore?: boolean
  /**
   * The ATS's own last-modified stamp for the posting, where the board feed exposes one (Greenhouse
   * `updated_at`). A verdict is a reading of one version of the text; when this moves past the
   * version we scored, the posting is re-read and re-judged.
   */
  sourceUpdatedAt?: string | null
  /** Description was read for a pay figure at least once; don't fetch it again just for that. */
  payChecked?: boolean
  /** Built-in text-rule revision this apply verdict was last re-checked against (see TEXT_RULES_REV). */
  textAuditRev?: number
  /**
   * Fingerprint of the posting's description (digits and punctuation stripped), set when the text
   * was read. Two rows at the same company, title and city with the same fingerprint are the same
   * posting under two requisition numbers and get folded into one card.
   */
  descriptionHash?: string | null
  /** Set on a row folded into another (identical) posting's card; `active` is false while it holds. */
  duplicateOf?: string
  /**
   * The team / org / product area the posting names ("Envelopes Management", "AWS Lambda"), so ten
   * same-title reqs at one company can be told apart. null once the text was read and named none.
   */
  team?: string | null
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
/** Statuses that mean "I did something with this" — what the tracker shows and exports. */
export const TRACKED_STATUSES: JobStatus[] = ['saved', 'applying', ...OUTCOME_STATUSES]

/**
 * A posting you added by pasting its link, whether it was new to the store or a feed row you
 * re-pasted. Pasted rows are shown while unscored, land in Flagged (not Hidden) on a matcher skip,
 * skip the title rules, and never expire for being unlisted.
 */
export function isPasted(item: Pick<JobItem, 'source' | 'alsoSeenIn'>): boolean {
  return item.source === 'manual' || item.alsoSeenIn.includes('manual')
}

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
  /** Kept so a relisted posting can be matched to this record by city, not just title. */
  location?: string | null
}

export interface JobUserState {
  status: JobStatus
  note: string
  promotedTaskId: string | null
  openedInAsideAt: string | null
  /** Set the first time the status reaches applied (or a later outcome); never moved after. */
  appliedAt?: string | null
  /** Status was copied from another record that matched by company+title, not set by you. */
  inherited?: boolean
  /** briefly's browser filled the form; you review and press Submit. */
  prepared?: PreparedInfo | null
  /**
   * The employer's real application page when the posting's own link is a wrapper (jobright).
   * Found by briefly's browser the first time you applied; Apply and Open use it from then on.
   */
  resolvedUrl?: string | null
  snapshot: JobSnapshot
  updatedAt: string
}

export interface PreparedInfo {
  at: string
  /** Set once the fill pass has run (or stopped with an error); null while briefly is still working. */
  finishedAt: string | null
  /** Which application system the form was recognised as. */
  ats: string
  /** Fields set from your profile / answers.md. */
  filled: number
  /** Free-text answers the model drafted (yellow in the form); verbatim so you can read them here. */
  drafted: { label: string; text: string }[]
  /** Things left for you, with the reason. */
  unfilled: { label: string; reason: string }[]
  resumeUploaded: boolean
  /** Set when briefly saw the confirmation page after you pressed Submit. */
  submittedAt: string | null
  /** The browser tab was closed without a confirmation. */
  closedAt: string | null
  /** Why preparation stopped early (login wall, unknown form, browser missing). */
  error: string | null
}

/** One row as the renderer sees it: item (possibly pruned → null) merged with user state. */
export interface JobRow {
  id: string
  item: JobItem | null
  state: JobUserState | null
  /** Other requisitions of this exact posting that were folded into this card. */
  duplicates?: { id: string; url: string; location: string | null }[]
}

export interface ProfileFile {
  name: 'resume.md' | 'preferences.md' | 'answers.md' | 'voice.md' | 'watchlist.md' | 'rules.md'
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
  /** Company names from watchlist.md, whatever heading they sit under. */
  watchlist: string[]
  /** Tier 1 companies: rules.md "## Tier 1" plus watchlist.md entries under "## Tier 1". Never hides anything. */
  tier1: string[]
  /** Tier 2 companies, same two sources. */
  tier2: string[]
  /** Companies with at least one application in the tracker (applied or a later status). */
  appliedCompanies: string[]
  /** Hourly pay that puts an eligible posting in Apply now on its own (rules.md). */
  payFloor: number
}
