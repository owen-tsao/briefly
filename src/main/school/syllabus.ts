import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { localDay } from '../../shared/dates'
import { courseKey, FEED_KINDS, type SchoolKind, type SyllabusParseResult, type SyllabusSuggestion } from '../../shared/school'
import { MAX_DOCUMENT_BYTES, type ConverseDocument } from '../bedrock'
import { completeJson, completeJsonWithDocument } from '../llm'
import { stripHtml } from '../jobs/normalize'

/**
 * Turn a syllabus (PDF or pasted text) into proposed deadlines and weekly rules. The model only
 * proposes; nothing is stored until you accept each suggestion in the School tab. Every proposal
 * carries the quote it was based on so you can judge it in one glance.
 */

const MAX_TEXT_CHARS = 60_000

const SYSTEM = `You read a university course syllabus and extract every dated or recurring obligation for a student.
Return JSON only, no prose, in exactly this shape:

{
  "course": string,            // course code as printed, e.g. "STAT 390", "E E 241", "AMATH 301"
  "courseName": string,        // human title, e.g. "Statistical Methods in Engineering"
  "termStart": string|null,    // YYYY-MM-DD first day of instruction if stated
  "termEnd": string|null,      // YYYY-MM-DD last day of instruction or final exam day if stated
  "items": [                   // one-off dated things
    {
      "title": string,         // short, e.g. "Midterm 1", "Project proposal", "Final exam"
      "kind": "assignment"|"quiz"|"exam"|"project"|"event"|"other",
      "due": string,           // YYYY-MM-DD — only when you can pin the exact day
      "time": string|null,     // HH:MM 24h if stated
      "evidence": string,      // verbatim quote (<= 140 chars) from the syllabus that states this
      "confidence": "high"|"medium"|"low"
    }
  ],
  "rules": [                   // weekly recurring deadlines
    {
      "title": string,         // use {n} for the running number, e.g. "Homework {n}", "Lab {n} report"
      "kind": "assignment"|"quiz"|"exam"|"project"|"event"|"other",
      "weekday": 0|1|2|3|4|5|6, // 0 = Sunday … 6 = Saturday
      "time": string|null,     // HH:MM 24h if stated, else null
      "evidence": string,
      "confidence": "high"|"medium"|"low"
    }
  ],
  "unresolved": [string]       // obligations you saw but could not date exactly ("Midterm in week 7", "Final: TBD")
}

Rules
- Dates: resolve relative phrases ("week 7", "the Monday after Thanksgiving") ONLY if the syllabus gives the anchor you need; otherwise put the phrase in "unresolved". Never invent a date.
- Year: if the syllabus names the term (e.g. "Autumn 2026") use it; if a date lacks a year, assume the term implied by TODAY (given below) and say so by lowering confidence to "medium".
- Rules are for things that repeat weekly with a stated weekday ("homework due every Monday at 9:10 PM"). A list of 8 individual homework dates is items, not a rule.
- Do not include lecture times, office hours, or reading assignments without a deliverable.
- Exams, midterms, finals, and project milestones are the most important things to catch.
- Keep "evidence" a true quote; if you paraphrased, mark confidence "low".
- If the text is not a syllabus, return {"course":"","courseName":"","termStart":null,"termEnd":null,"items":[],"rules":[],"unresolved":["This does not look like a syllabus."]}`

interface RawParse {
  course?: unknown
  courseName?: unknown
  termStart?: unknown
  termEnd?: unknown
  items?: unknown
  rules?: unknown
  unresolved?: unknown
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export interface SyllabusInput {
  /** Absolute path chosen through the OS file dialog. */
  path?: string
  /** Pasted text, as an alternative to a file. */
  text?: string
  /** What you think the course is; the model's answer wins if confident. */
  courseHint?: string
}

export async function parseSyllabus(input: SyllabusInput): Promise<SyllabusParseResult> {
  try {
    const user = `TODAY is ${localDay()}.${input.courseHint ? ` The student believes this is for ${courseKey(input.courseHint)}.` : ''} Extract the obligations.`
    let raw: RawParse
    if (input.path) {
      const doc = loadDocument(input.path)
      if (doc.format === 'pdf') {
        raw = await completeJsonWithDocument<RawParse>(SYSTEM, user, doc)
      } else {
        raw = await completeJson<RawParse>(SYSTEM, `${user}\n\n<syllabus>\n${toText(doc)}\n</syllabus>`)
      }
    } else {
      const text = String(input.text ?? '').trim()
      if (text.length < 80) return { ok: false, error: 'Paste the whole syllabus (or pick the PDF) — that was too short to read.' }
      raw = await completeJson<RawParse>(SYSTEM, `${user}\n\n<syllabus>\n${text.slice(0, MAX_TEXT_CHARS)}\n</syllabus>`)
    }
    return normalise(raw, input.courseHint)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function loadDocument(path: string): ConverseDocument {
  const ext = extname(path).toLowerCase()
  const format = ext === '.pdf' ? 'pdf' : ext === '.md' ? 'md' : ext === '.html' || ext === '.htm' ? 'html' : ext === '.txt' ? 'txt' : null
  if (!format) throw new Error('Pick a PDF, .txt, .md, or .html file.')
  const size = statSync(path).size
  if (size > MAX_DOCUMENT_BYTES) throw new Error('That file is over 4.5 MB. Export a smaller PDF or paste the text.')
  return { name: basename(path, ext), format, bytes: readFileSync(path) }
}

function toText(doc: ConverseDocument): string {
  const s = doc.bytes.toString('utf8')
  return (doc.format === 'html' ? stripHtml(s) : s).slice(0, MAX_TEXT_CHARS)
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function kind(v: unknown): SchoolKind {
  return FEED_KINDS.includes(v as SchoolKind) ? (v as SchoolKind) : 'other'
}

function conf(v: unknown): SyllabusSuggestion['confidence'] {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'low'
}

function normalise(raw: RawParse, hint?: string): SyllabusParseResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'The model returned something that was not a syllabus summary.' }
  const modelCourse = str(raw.course, 40)
  const course = courseKey(modelCourse || hint || '')
  const suggestions: SyllabusSuggestion[] = []
  let n = 0
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const title = str(o.title, 120)
    const due = str(o.due, 10)
    if (!title || !DAY_RE.test(due) || Number.isNaN(Date.parse(due + 'T12:00:00'))) continue
    const time = str(o.time, 5)
    suggestions.push({
      id: `s${n++}`,
      type: 'item',
      course,
      title,
      kind: kind(o.kind),
      due,
      time: TIME_RE.test(time) ? time : null,
      evidence: str(o.evidence, 160),
      confidence: conf(o.confidence)
    })
  }
  for (const r of Array.isArray(raw.rules) ? raw.rules : []) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const title = str(o.title, 120)
    const weekday = Number(o.weekday)
    if (!title || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue
    const time = str(o.time, 5)
    suggestions.push({
      id: `s${n++}`,
      type: 'rule',
      course,
      title,
      kind: kind(o.kind),
      weekday: weekday as SyllabusSuggestion['weekday'],
      time: TIME_RE.test(time) ? time : null,
      evidence: str(o.evidence, 160),
      confidence: conf(o.confidence)
    })
  }
  const order = { high: 0, medium: 1, low: 2 }
  suggestions.sort((a, b) => order[a.confidence] - order[b.confidence] || (a.due ?? '').localeCompare(b.due ?? ''))
  const unresolved = (Array.isArray(raw.unresolved) ? raw.unresolved : []).map((u) => str(u, 160)).filter(Boolean).slice(0, 20)
  const termStart = str(raw.termStart, 10)
  const termEnd = str(raw.termEnd, 10)
  return {
    ok: true,
    course,
    courseName: str(raw.courseName, 80),
    termStart: DAY_RE.test(termStart) ? termStart : undefined,
    termEnd: DAY_RE.test(termEnd) ? termEnd : undefined,
    suggestions,
    unresolved
  }
}
