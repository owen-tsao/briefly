import { courseKey, type SchoolKind } from '../../shared/school'

/**
 * Minimal iCalendar reader for the Canvas user feed. Handles line unfolding, parameterised
 * property names (`DTSTART;VALUE=DATE;VALUE=DATE:…` — Canvas really emits the duplicate), text
 * unescaping, and the two date shapes Canvas uses: all-day `YYYYMMDD` and UTC `YYYYMMDDTHHMMSSZ`.
 * Everything else in the file is ignored.
 */

export interface IcsEvent {
  uid: string
  summary: string
  /** Local day YYYY-MM-DD. */
  day: string
  /** Local HH:MM for timed events; null for all-day. */
  time: string | null
  url: string | null
  description: string
  location: string
  /** Canvas-specific: course code pulled from the trailing `[E E 241 A]`, and the numeric id from the URL. */
  course: string | null
  courseId: string | null
  /** `assignment` when the UID says so, `event` otherwise. Canvas quizzes show up as assignments. */
  isAssignment: boolean
}

export const MAX_ICS_BYTES = 4 * 1024 * 1024

function unfold(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
}

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim()
}

/** Parse a DATE or DATE-TIME value into local day + optional time. Returns null when unreadable. */
export function parseIcsDate(value: string, params: string): { day: string; time: string | null } | null {
  const v = value.trim()
  const dateOnly = /VALUE=DATE(?![-A-Z])/.test(params) || /^\d{8}$/.test(v)
  if (dateOnly) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})/)
    if (!m) return null
    return { day: `${m[1]}-${m[2]}-${m[3]}`, time: null }
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s = '00', z] = m
  const date = z
    ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s))
    : new Date(+y, +mo - 1, +d, +h, +mi, +s) // floating time: treat as local; Canvas uses Z anyway
  if (Number.isNaN(date.getTime())) return null
  const pad = (n: number): string => String(n).padStart(2, '0')
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
}

export function parseIcs(text: string): IcsEvent[] {
  if (text.length > MAX_ICS_BYTES) text = text.slice(0, MAX_ICS_BYTES)
  const out: IcsEvent[] = []
  let cur: Record<string, { params: string; value: string }> | null = null
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') {
      cur = {}
      continue
    }
    if (line === 'END:VEVENT') {
      if (cur) {
        const ev = toEvent(cur)
        if (ev) out.push(ev)
      }
      cur = null
      continue
    }
    if (!cur) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const head = line.slice(0, colon)
    const semi = head.indexOf(';')
    const name = (semi === -1 ? head : head.slice(0, semi)).toUpperCase()
    const params = semi === -1 ? '' : head.slice(semi + 1).toUpperCase()
    // First occurrence wins; Canvas doesn't repeat properties within one event.
    if (!(name in cur)) cur[name] = { params, value: line.slice(colon + 1) }
  }
  return out
}

function toEvent(p: Record<string, { params: string; value: string }>): IcsEvent | null {
  const uid = p.UID?.value.trim()
  const summaryRaw = p.SUMMARY ? unescapeText(p.SUMMARY.value) : ''
  const start = p.DTSTART ? parseIcsDate(p.DTSTART.value, p.DTSTART.params) : null
  if (!uid || !summaryRaw || !start) return null
  const url = p.URL ? p.URL.value.trim() : null
  const courseMatch = summaryRaw.match(/\[([^\]]+)\]\s*$/)
  const courseId = url?.match(/course_(\d+)/)?.[1] ?? null
  return {
    uid,
    summary: courseMatch ? summaryRaw.slice(0, courseMatch.index).trim() : summaryRaw,
    day: start.day,
    time: start.time,
    url: url && /^https:\/\//i.test(url) ? url.slice(0, 500) : null,
    description: p.DESCRIPTION ? unescapeText(p.DESCRIPTION.value).slice(0, 2000) : '',
    location: p.LOCATION ? unescapeText(p.LOCATION.value).slice(0, 200) : '',
    course: courseMatch ? courseKey(courseMatch[1]) : null,
    courseId,
    isAssignment: /assignment/i.test(uid)
  }
}

/** Best-effort kind from the title; Canvas doesn't carry a type beyond assignment/event. */
export function classifyTitle(title: string, isAssignment: boolean): SchoolKind {
  const t = title.toLowerCase()
  if (/\b(final|midterm|exam)\b/.test(t)) return 'exam'
  if (/\bquiz/.test(t)) return 'quiz'
  if (/\bproject|proposal|milestone|presentation\b/.test(t)) return isAssignment ? 'project' : 'event'
  if (isAssignment) return 'assignment'
  return 'event'
}

/** Recurring-looking calendar events: office hours, sections, lectures, Zoom series. */
export function looksLikeRecurringEvent(title: string, location: string): boolean {
  return /office hours?|\bOH\b|section|lecture|discussion|lab session|study session|review session/i.test(title) || /zoom/i.test(location)
}
