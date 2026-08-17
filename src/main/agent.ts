import { readNotes, buildContext, type Note, type NotesSnapshot } from './notes'
import { completeJson, complete } from './llm'
import {
  MERGE_SYSTEM,
  ASK_SYSTEM,
  RETRIEVE_SYSTEM,
  buildMergeUserPrompt,
  buildAskUserPrompt,
  buildRetrieveUserPrompt
} from './prompts'
import { applyMerge, getOpenTasks, getSuppressedTexts, type MergeResponse } from './taskStore'
import type { AskResult, NoteSummary, RefreshResult } from '../shared/types'

let refreshing = false

export async function refresh(): Promise<RefreshResult> {
  if (refreshing) return { ok: false, error: 'A refresh is already running.' }
  refreshing = true
  try {
    const snapshot = await readNotes()
    const context = buildContext(snapshot)
    const openTasks = getOpenTasks()
    const suppressed = getSuppressedTexts()
    const response = await completeJson<MergeResponse>(
      MERGE_SYSTEM,
      buildMergeUserPrompt(openTasks, suppressed, context)
    )
    const state = applyMerge(response)
    return { ok: true, state }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    refreshing = false
  }
}

export async function ask(question: string): Promise<AskResult> {
  try {
    const snapshot = await readNotes()
    const retrieved = await retrieveNotes(question, snapshot)
    const context = buildAskContext(snapshot, retrieved)
    const answer = await complete(ASK_SYSTEM, buildAskUserPrompt(question, getOpenTasks(), context))
    return { ok: true, answer }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Retrieval pass for Ask: the LLM sees the ENTIRE library index (every title,
 * any age) and picks the notes whose content likely answers the question,
 * plus a local keyword backstop in case it misses one. Best-effort — an
 * empty result just means Ask falls back to the recent-notes context.
 */
async function retrieveNotes(question: string, snapshot: NotesSnapshot): Promise<Note[]> {
  const indexLines = snapshot.all
    .slice(0, 400)
    .map((n) => `${n.modified ? n.modified.slice(0, 10) : '????-??-??'}  ${n.title.slice(0, 60)}`)

  let picked: string[] = []
  try {
    const response = await completeJson<{ titles: string[] }>(
      RETRIEVE_SYSTEM,
      buildRetrieveUserPrompt(question, indexLines)
    )
    picked = (response.titles ?? []).filter((t): t is string => typeof t === 'string')
  } catch {
    // Retrieval is an enhancement; never let it break Ask.
  }

  const byTitle = new Map<string, Note>()
  for (const note of snapshot.all) {
    // Titles get truncated to 60 chars in the index — match on the prefix.
    const key = note.title.slice(0, 60).toLowerCase()
    if (!byTitle.has(key)) byTitle.set(key, note)
  }

  const selected: Note[] = []
  const seen = new Set<string>()
  const add = (note: Note | undefined): void => {
    if (note && !seen.has(note.title + (note.modified ?? ''))) {
      seen.add(note.title + (note.modified ?? ''))
      selected.push(note)
    }
  }

  for (const title of picked.slice(0, 8)) add(byTitle.get(title.slice(0, 60).toLowerCase().trim()))

  // Keyword backstop: notes whose title or body mentions a question word.
  const keywords = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4)
  if (keywords.length > 0 && selected.length < 8) {
    for (const note of snapshot.all) {
      if (selected.length >= 8) break
      const haystack = (note.title + ' ' + note.body).toLowerCase()
      if (keywords.some((w) => haystack.includes(w))) add(note)
    }
  }
  return selected
}

/** Retrieved notes first (full bodies), then the usual recent-notes context. */
function buildAskContext(snapshot: NotesSnapshot, retrieved: Note[]): string {
  const parts: string[] = []
  if (retrieved.length > 0) {
    parts.push('=== NOTES RETRIEVED FOR THIS QUESTION (full content) ===\n')
    let used = 0
    for (const note of retrieved) {
      const modified = note.modified ? note.modified.slice(0, 10) : 'unknown'
      const body = note.body.trim().replace(/\n{3,}/g, '\n\n').slice(0, 5_000)
      const chunk = `--- "${note.title}" (modified ${modified}) ---\n${body}\n\n`
      if (used + chunk.length > 12_000) break
      parts.push(chunk)
      used += chunk.length
    }
  }
  parts.push(buildContext(snapshot, 8_000, 60))
  return parts.join('')
}

/** Browse-able list of every readable note, newest first. */
export async function listNotes(): Promise<{ ok: boolean; notes?: NoteSummary[]; error?: string }> {
  try {
    const snapshot = await readNotes()
    const scannedTitles = new Set(snapshot.recent.map((n) => n.title + (n.modified ?? '')))
    const notes = snapshot.all.map((n) => ({
      title: n.title,
      modified: n.modified,
      preview: n.body.trim().replace(/\s+/g, ' ').slice(0, 110),
      chars: n.body.length,
      scanned: scannedTitles.has(n.title + (n.modified ?? ''))
    }))
    return { ok: true, notes }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Extract tasks from one specific note, on explicit user request.
 * Bypasses the staleness rules — the user asking is the relevance signal.
 */
export async function extractFromNote(title: string, modified: string | null): Promise<RefreshResult> {
  try {
    const snapshot = await readNotes()
    const note = snapshot.all.find(
      (n) => n.title === title && (modified === null || n.modified === modified)
    )
    if (!note) return { ok: false, error: `Note "${title}" not found.` }

    const noteContext = [
      '=== NOTE THE USER EXPLICITLY ASKED TO IMPORT ===',
      `--- "${note.title}" (modified ${note.modified?.slice(0, 10) ?? 'unknown'}) ---`,
      note.body.trim().slice(0, 12_000),
      '',
      'USER REQUEST: extract every actionable task from this specific note, regardless of the note\'s age or the recency rules. Do not remove existing tasks (return an empty removedIds).'
    ].join('\n')

    const response = await completeJson<MergeResponse>(
      MERGE_SYSTEM,
      buildMergeUserPrompt(getOpenTasks(), getSuppressedTexts(), noteContext)
    )
    const state = applyMerge({ ...response, removedIds: [] }, { updateToday: false })
    return { ok: true, state }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
