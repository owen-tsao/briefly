/**
 * Turn the Gmail exports (applications.csv + oa_list.csv) into ~/.briefly/email-updates.json.
 *
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/email-updates-from-csv.ts \
 *     --applications applications.csv --oa oa_list.csv --out fixtures/email-updates.sample.json
 *
 * applications.csv columns: company, role, applied_date, status, last_update, evidence_subject
 * oa_list.csv columns: company, role, invite_date, platform, deadline, completed, outcome_after_OA, evidence_subject
 *
 * Status words (applied, OA, interview, rejected) come from the applications file. The OA file
 * adds a deadline when one can be read (a calendar day, "N days", or "Mon D h:mm AM/PM PT").
 * Anything else is kept as a note and does not become a task. One stable id per application, so
 * writing the file again updates the same tracker row instead of adding another.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { companiesMatch, companyKey, roleKey, rolesMatch } from '../src/main/jobs/emailUpdates'

interface AppRow {
  company: string
  role: string
  applied_date: string
  status: string
  last_update: string
  evidence_subject: string
}
interface OaRow {
  company: string
  role: string
  invite_date: string
  platform: string
  deadline: string
  completed: string
  outcome_after_OA: string
  evidence_subject: string
}

const STATUS: Record<string, string> = { applied: 'applied', oa: 'oa', interview: 'interview', interviewing: 'interview', rejected: 'rejected' }
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let quoted = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cur)
      cur = ''
    } else if (c === '\n') {
      row.push(cur)
      rows.push(row)
      row = []
      cur = ''
    } else if (c !== '\r') cur += c
  }
  if (cur.length || row.length) {
    row.push(cur)
    rows.push(row)
  }
  const [header, ...body] = rows
  if (!header) return []
  return body.filter((r) => r.some((cell) => cell.trim())).map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])))
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function dayString(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`
}
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + n)
  return dt.toISOString().slice(0, 10)
}
/** US Pacific offset for 2026. DST ends on the first Sunday in November (Nov 1). */
function pacificOffset(day: string): string {
  const n = Number(day.slice(5, 7)) * 100 + Number(day.slice(8, 10))
  return n >= 308 && n < 1101 ? '-07:00' : '-08:00'
}

function parseDeadline(raw: string, invite: string): { at: string; display: string } | null {
  const text = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const clock = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2})\s*(am|pm))?(?:\s*(pt|pst|pdt|et|est|edt))?$/i.exec(text)
  if (clock) {
    const year = invite ? Number(invite.slice(0, 4)) : 2026
    const month = MONTHS[clock[1].slice(0, 3).toLowerCase()]
    const day = dayString(year, month, Number(clock[2]))
    if (!clock[3]) return { at: day, display: `${clock[1].slice(0, 3)} ${Number(clock[2])}` }
    let hour = Number(clock[3]) % 12
    if (clock[5].toLowerCase() === 'pm') hour += 12
    const offset = /e/i.test(clock[6] ?? '') ? (pacificOffset(day) === '-07:00' ? '-04:00' : '-05:00') : pacificOffset(day)
    const zone = /e/i.test(clock[6] ?? '') ? 'ET' : 'PT'
    const display = `${clock[1].slice(0, 3)} ${Number(clock[2])}, ${Number(clock[3])}:${clock[4]} ${clock[5].toUpperCase()} ${zone}`
    return { at: `${day}T${pad(hour)}:${clock[4]}:00${offset}`, display }
  }
  const relative = /^(\d+)\s+days?$/i.exec(text)
  if (relative && invite) return { at: addDays(invite, Number(relative[1])), display: `${relative[1]} days after ${invite}` }
  const embedded = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i.exec(raw)
  if (embedded) {
    const year = invite ? Number(invite.slice(0, 4)) : 2026
    const day = dayString(year, MONTHS[embedded[1].slice(0, 3).toLowerCase()], Number(embedded[2]))
    return { at: day, display: `${embedded[1].slice(0, 3)} ${Number(embedded[2])}` }
  }
  return null
}

function entryId(company: string, role: string, date: string, subject: string, seen: Set<string>): string {
  const base = `csv:${companyKey(company) || 'company'}:${roleKey(role) || 'norole'}:${date || 'nodate'}`
  let id = base.slice(0, 180)
  if (seen.has(id)) id = `${base.slice(0, 160)}:${createHash('sha1').update(subject).digest('hex').slice(0, 8)}`
  seen.add(id)
  return id
}

const applications = parseCsv(readFileSync(arg('--applications') ?? 'applications.csv', 'utf8')) as unknown as AppRow[]
const oas = parseCsv(readFileSync(arg('--oa') ?? 'oa_list.csv', 'utf8')) as unknown as OaRow[]
const usedOa = new Set<number>()
const ids = new Set<string>()

function matchOa(company: string, role: string): number {
  let fallback = -1
  for (let i = 0; i < oas.length; i++) {
    if (usedOa.has(i) || !companiesMatch(oas[i].company, company)) continue
    if (role && oas[i].role && rolesMatch(oas[i].role, role)) return i
    if (fallback < 0 && (!role || !oas[i].role)) fallback = i
  }
  return fallback
}

const entries: Record<string, unknown>[] = []
for (const app of applications) {
  const status = STATUS[app.status.trim().toLowerCase()]
  if (!app.company || !status) continue
  const eventAt = /^\d{4}-\d{2}-\d{2}$/.test(app.last_update) ? app.last_update : app.applied_date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventAt)) continue
  const oaIndex = matchOa(app.company, app.role)
  const oa = oaIndex >= 0 ? oas[oaIndex] : undefined
  if (oaIndex >= 0) usedOa.add(oaIndex)
  const notes: string[] = []
  let deadline: Record<string, string> | undefined
  if (oa) {
    const parsed = oa.deadline ? parseDeadline(oa.deadline, oa.invite_date) : null
    if (parsed) {
      deadline = { at: parsed.at, kind: 'OA', display: parsed.display }
      if (oa.platform) deadline.platform = oa.platform
    } else if (oa.platform || oa.deadline) {
      notes.push(['OA', oa.platform, oa.deadline].filter(Boolean).join(' '))
    }
  }
  const entry: Record<string, unknown> = {
    id: entryId(app.company, app.role, app.applied_date || eventAt, app.evidence_subject, ids),
    company: app.company,
    role: app.role,
    status,
    eventAt
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(app.applied_date)) entry.appliedAt = app.applied_date
  if (app.evidence_subject) entry.subject = app.evidence_subject.slice(0, 300)
  if (app.last_update && app.last_update !== eventAt) entry.emailAt = app.last_update
  if (notes.length) entry.note = notes.join(' · ').slice(0, 500)
  if (deadline) entry.deadline = deadline
  entries.push(entry)
}

for (let i = 0; i < oas.length; i++) {
  if (usedOa.has(i) || !oas[i].company) continue
  const oa = oas[i]
  const eventAt = /^\d{4}-\d{2}-\d{2}$/.test(oa.invite_date) ? oa.invite_date : ''
  if (!eventAt) continue
  const parsed = oa.deadline ? parseDeadline(oa.deadline, oa.invite_date) : null
  const entry: Record<string, unknown> = {
    id: entryId(oa.company, oa.role, eventAt, oa.evidence_subject, ids),
    company: oa.company,
    role: oa.role,
    status: 'oa',
    eventAt,
    subject: oa.evidence_subject.slice(0, 300)
  }
  if (parsed) {
    entry.deadline = { at: parsed.at, kind: 'OA', display: parsed.display, ...(oa.platform ? { platform: oa.platform } : {}) }
  } else if (oa.platform || oa.deadline) {
    entry.note = ['OA', oa.platform, oa.deadline].filter(Boolean).join(' ')
  }
  entries.push(entry)
}

const out = arg('--out') ?? 'email-updates.json'
const file = { version: 1, generatedAt: new Date().toISOString(), entries }
writeFileSync(out, JSON.stringify(file, null, 2) + '\n')
console.log(`wrote ${entries.length} entries to ${out}`)
