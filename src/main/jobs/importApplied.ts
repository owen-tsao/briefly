import { createHash } from 'node:crypto'
import type { JobUserState } from '../../shared/jobs'
import { OUTCOME_STATUSES } from '../../shared/jobs'
import { detectTerm } from './normalize'
import { load, save } from './jobsStore'

export interface ImportedApplication {
  company: string
  title: string
  /** ISO. Approximate when parsed from "3 weeks ago"; exact when the source gave a date. */
  appliedAt: string
  approximate: boolean
}

const MAX_LINE = 200
const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000
}

/** "32 minutes ago", "Last week", "1 month ago" → ISO timestamp, approximate. */
function relativeToIso(text: string, now: number): string | null {
  const t = text.trim().toLowerCase()
  if (t === 'just now' || t === 'today') return new Date(now).toISOString()
  if (t === 'yesterday') return new Date(now - UNIT_MS.day).toISOString()
  if (t === 'last week') return new Date(now - UNIT_MS.week).toISOString()
  if (t === 'last month') return new Date(now - UNIT_MS.month).toISOString()
  const m = /^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/.exec(t)
  if (!m) return null
  return new Date(now - Number(m[1]) * UNIT_MS[m[2]]).toISOString()
}

/**
 * Parses the text you get from select-all → copy on my.greenhouse.io/applications.
 * Each application is a run of lines ending in "Applied · <when>", with the company on the line
 * just above and the title above that. Anything that doesn't fit is skipped, never guessed.
 * Pure so it can be tested against a real paste.
 */
export function parseGreenhousePaste(text: string, now = Date.now()): ImportedApplication[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE))
    .filter(Boolean)
  const out: ImportedApplication[] = []
  const seen = new Set<string>()
  for (let i = 2; i < lines.length; i++) {
    const m = /^Applied\s*[·•-]\s*(.+)$/i.exec(lines[i])
    if (!m) continue
    const company = lines[i - 1]
    const title = lines[i - 2]
    if (!company || !title || /^Applied\s*[·•-]/i.test(title)) continue
    const key = `${company}|${title}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const iso = relativeToIso(m[1], now)
    const exact = /^on\s+/i.test(m[1]) ? new Date(m[1].replace(/^on\s+/i, '')) : null
    if (exact && !Number.isNaN(exact.getTime())) {
      out.push({ company, title, appliedAt: exact.toISOString(), approximate: false })
    } else if (iso) {
      out.push({ company, title, appliedAt: iso, approximate: true })
    }
  }
  return out
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(llc|inc|corp|corporation|ltd|l\.p\.|lp|careers?|job board|campus|university recruiting|usa)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export interface ImportResult {
  matched: number
  created: number
  skipped: number
}

/**
 * Marks imported applications as applied. Existing postings are matched by company + title so
 * they get the real applied date instead of a duplicate row; the rest become snapshot-only rows.
 * Never downgrades: a posting already at OA/interview/offer/rejected is left alone.
 */
export function importApplied(apps: ImportedApplication[]): ImportResult {
  const store = load()
  const res: ImportResult = { matched: 0, created: 0, skipped: 0 }
  const byKey = new Map<string, string>()
  for (const it of store.items) byKey.set(`${norm(it.company)}|${norm(it.title)}`, it.id)
  for (const [id, st] of Object.entries(store.state)) {
    byKey.set(`${norm(st.snapshot.company)}|${norm(st.snapshot.title)}`, id)
  }
  const now = new Date().toISOString()
  for (const app of apps) {
    const key = `${norm(app.company)}|${norm(app.title)}`
    const existingId = byKey.get(key)
    const id = existingId ?? createHash('sha1').update(`manual:${key}`).digest('hex')
    const state: JobUserState | undefined = store.state[id]
    if (state && OUTCOME_STATUSES.includes(state.status)) {
      // Already tracked; only backfill a missing applied date.
      if (!state.appliedAt) {
        state.appliedAt = app.appliedAt
        state.updatedAt = now
      }
      res.skipped++
      continue
    }
    const item = store.items.find((it) => it.id === id)
    store.state[id] = {
      status: 'applied',
      note: state?.note || (app.approximate ? 'Imported from MyGreenhouse (date approximate)' : 'Imported from MyGreenhouse'),
      promotedTaskId: state?.promotedTaskId ?? null,
      openedInAsideAt: state?.openedInAsideAt ?? null,
      appliedAt: app.appliedAt,
      snapshot: item
        ? { company: item.company, title: item.title, url: item.url, term: item.term, source: item.source }
        : state?.snapshot ?? {
            company: app.company,
            title: app.title,
            url: '',
            term: detectTerm(app.title),
            source: 'manual'
          },
      updatedAt: now
    }
    if (existingId) res.matched++
    else res.created++
    byKey.set(key, id)
  }
  save(store)
  return res
}
