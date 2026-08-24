import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface Note {
  title: string
  body: string
  modified: string | null
}

export interface NoteIndexEntry {
  title: string
  modified: string | null
}

export interface NotesSnapshot {
  /** Full notes modified within the recency window, newest first. */
  recent: Note[]
  /** Title + date index of recent months (bodies omitted). */
  index: NoteIndexEntry[]
  /** Every readable note, newest first (for browsing and manual extraction). */
  all: Note[]
}

/**
 * Batched property access (folder.notes.name() etc.) is one Apple Event per
 * property instead of one per note — reads ~300 notes in a couple of seconds.
 * Locked notes are excluded via passwordProtected; their bodies are not
 * readable anyway, but we skip titles/dates too. "Recently Deleted" is a
 * normal folder to the automation API, so it is excluded by name.
 */
const JXA_SCRIPT = `
function run() {
  const app = Application("Notes");
  const out = [];
  const folders = app.folders();
  for (const folder of folders) {
    let fname;
    try { fname = folder.name(); } catch (e) { continue; }
    if (fname === "Recently Deleted") continue;
    let names, bodies, dates, locked;
    try {
      names = folder.notes.name();
      bodies = folder.notes.plaintext();
      dates = folder.notes.modificationDate();
      locked = folder.notes.passwordProtected();
    } catch (e) { continue; }
    for (let i = 0; i < names.length; i++) {
      if (locked[i]) continue;
      out.push({
        title: names[i],
        body: bodies[i] || "",
        modified: dates[i] ? dates[i].toISOString() : null
      });
    }
  }
  return JSON.stringify(out);
}
`

/** Static script; the title travels as an argv value, never interpolated into code. */
const OPEN_NOTE_SCRIPT = `
function run(argv) {
  const app = Application("Notes");
  app.activate();
  const title = argv[0];
  try {
    const matches = app.notes.whose({ name: title })();
    if (matches.length > 0) app.show(matches[0]);
  } catch (e) {}
  return "";
}
`

/** Open Apple Notes with the named note selected (first match); falls back to just opening Notes. */
export async function openNote(title: string): Promise<void> {
  await execFileAsync('osascript', ['-l', 'JavaScript', '-e', OPEN_NOTE_SCRIPT, title], {
    timeout: 15_000
  })
}

export async function readNotes(recentDays = 45): Promise<NotesSnapshot> {
  let stdout: string
  try {
    const result = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', JXA_SCRIPT], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000
    })
    stdout = result.stdout
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    const stderr = e?.stderr ?? ''
    if (stderr.includes('-1743') || stderr.toLowerCase().includes('not authorized')) {
      throw new Error(
        'macOS blocked access to Notes. Open System Settings → Privacy & Security → Automation and allow briefly (or Electron) to control Notes, then retry.'
      )
    }
    throw new Error(`Failed to read Apple Notes: ${stderr || e?.message || String(err)}`)
  }

  const all: Note[] = JSON.parse(stdout.trim())
  all.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''))

  const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000
  const recent = all.filter((n) => n.modified && new Date(n.modified).getTime() >= cutoff)
  // Index only spans the last ~6 months — older notes are noise, not context.
  const indexCutoff = Date.now() - 180 * 24 * 60 * 60 * 1000
  const index = all
    .filter((n) => n.modified && new Date(n.modified).getTime() >= indexCutoff)
    .map((n) => ({ title: n.title, modified: n.modified }))

  return { recent, index, all }
}

/**
 * Two-tier context block: recent full bodies + whole-library title index.
 * Budgets are sized so a full scan request (context + prompts + response)
 * stays under tight free-tier per-minute token limits (~4 chars/token).
 */
export function buildContext(
  snapshot: NotesSnapshot,
  maxBodyChars = 14_000,
  maxIndexEntries = 80
): string {
  const parts: string[] = []
  let used = 0

  parts.push('=== RECENT NOTES (full content, newest first) ===\n')
  for (const note of snapshot.recent) {
    const modified = note.modified ? note.modified.slice(0, 10) : 'unknown'
    const body = note.body.trim().replace(/\n{3,}/g, '\n\n')
    const chunk = `--- "${note.title}" (modified ${modified}) ---\n${body}\n\n`
    if (used + chunk.length > maxBodyChars) break
    parts.push(chunk)
    used += chunk.length
  }

  parts.push('\n=== LIBRARY INDEX (most recent notes, titles and dates only) ===\n')
  const indexLines = snapshot.index
    .slice(0, maxIndexEntries)
    .map((n) => `${n.modified ? n.modified.slice(0, 10) : '????-??-??'}  ${n.title.slice(0, 60)}`)
  parts.push(indexLines.join('\n'))

  return parts.join('')
}
