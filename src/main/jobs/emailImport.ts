import { applyEmailTaskWrites, listTasks } from '../taskStore'
import {
  EMAIL_UPDATES_FILE,
  applyEmailImport,
  commitEmailResult,
  matchRowsFrom,
  readEmailUpdates,
  recordTaskResults,
  shouldTouchJobs,
  type EmailCommitStore,
  type FileResult
} from './emailUpdates'
import { load, save } from './jobsStore'

export interface EmailImportResult {
  ok: boolean
  missing: boolean
  error: string | null
  read: number
  skipped: number
  matched: number
  created: number
  statusUpdated: number
  ambiguous: number
  manualKept: number
  tasksCreated: number
  tasksUpdated: number
  tasksClosed: number
  /** True when a task was created or its due time moved, so the board should reload. */
  tasksChanged: boolean
  warnings: string[]
}

/**
 * Read ~/.briefly/email-updates.json and fold it into the tracker.
 * The file is never written. jobs.json is not opened when the file is missing, empty, or invalid,
 * and the apply itself does not await, so it cannot interleave with another load/save on this process.
 */
export function importEmailUpdates(path = EMAIL_UPDATES_FILE): EmailImportResult {
  const file = readEmailUpdates(path)
  const result = blank(file)
  if (!file.ok) {
    console.warn(`[jobs] ${file.error}`)
    return result
  }
  if (!shouldTouchJobs(file)) {
    if (file.skipped.length) {
      console.warn(
        `[jobs] email-updates: skipped ${file.skipped.length} invalid ${file.skipped.length === 1 ? 'entry' : 'entries'}; tracker unchanged`
      )
    }
    return result
  }
  // Synchronous on purpose: load, mutate, save with no await between them.
  const store = load()
  const rows = matchRowsFrom(store)
  const tasks = listTasks().map((t) => ({
    id: t.id,
    externalId: t.externalId ?? null,
    state: t.state,
    deadline: t.deadline,
    dueAt: t.dueAt ?? null,
    text: t.text,
    touched: t.updatedAt !== t.createdAt
  }))
  const outcome = applyEmailImport(rows, store.emailImports ?? {}, tasks, file.entries, new Date())
  const warnings = [...file.warnings, ...outcome.warnings]
  let tasksCreated = 0
  let tasksUpdated = 0
  if (outcome.dirty) {
    commitEmailResult(store as unknown as EmailCommitStore, outcome)
    const wrote = applyEmailTaskWrites(outcome.taskWrites)
    tasksCreated = wrote.filter((w) => w.action === 'created').length
    tasksUpdated = wrote.filter((w) => w.action === 'updated').length
    if (store.emailImports) recordTaskResults(store.emailImports, wrote)
    save(store)
  }
  if (outcome.dirty || file.skipped.length || outcome.ambiguous || outcome.manualKept) {
    console.info(
      `[jobs] email-updates: ${outcome.statusUpdated} status, ${outcome.created} new, ${outcome.matched} matched, ${outcome.ambiguous} ambiguous, ${file.skipped.length} skipped, ${tasksCreated} tasks created, ${tasksUpdated} tasks moved`
    )
    for (const warning of warnings.slice(0, 8)) console.info(`[jobs] email-updates: ${warning}`)
  }
  return {
    ...result,
    read: file.entries.length,
    skipped: file.skipped.length,
    matched: outcome.matched,
    created: outcome.created,
    statusUpdated: outcome.statusUpdated,
    ambiguous: outcome.ambiguous,
    manualKept: outcome.manualKept,
    tasksCreated,
    tasksUpdated,
    tasksClosed: outcome.tasksClosed,
    tasksChanged: tasksCreated > 0 || tasksUpdated > 0,
    warnings
  }
}

function blank(file: FileResult): EmailImportResult {
  return {
    ok: file.ok,
    missing: file.missing,
    error: file.error,
    read: file.entries.length,
    skipped: file.skipped.length,
    matched: 0,
    created: 0,
    statusUpdated: 0,
    ambiguous: 0,
    manualKept: 0,
    tasksCreated: 0,
    tasksUpdated: 0,
    tasksClosed: 0,
    tasksChanged: false,
    warnings: file.warnings
  }
}
