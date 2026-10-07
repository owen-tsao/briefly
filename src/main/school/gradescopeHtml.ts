import { courseKey } from '../../shared/school'

/**
 * Gradescope has no API; these read the student-facing HTML. Selectors follow what the maintained
 * community scraper (nyuoss/gradescope-api) relies on, so a Gradescope redesign that breaks them
 * would break that project too. Pure functions — no Electron, no network — so they can be tested
 * against saved pages.
 */

export interface GsCourse {
  id: string
  /** Canonical course key, e.g. `STAT 390`. */
  course: string
}

export interface GsAssignment {
  id: string
  name: string
  due: { day: string; time: string }
  submitted: boolean
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
}

export function localParts(d: Date): { day: string; time: string } {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return {
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
}

/** "Fall 2026" / "Autumn 2026" / "Winter 2027" for a date, to pick the current term's courses. */
export function termWords(now = new Date()): { seasons: string[]; year: string } {
  const m = now.getMonth()
  const seasons = m >= 8 ? ['fall', 'autumn'] : m <= 2 ? ['winter'] : m <= 5 ? ['spring'] : ['summer']
  return { seasons, year: String(now.getFullYear()) }
}

/**
 * Dashboard (`/account`): each `.courseList--term` heading is followed by `a.courseBox` cards.
 * Only the current term's courses are returned; with no heading that names the current term,
 * the first block (Gradescope lists newest first) is used.
 */
export function parseGradescopeCourses(html: string, now = new Date()): GsCourse[] {
  const out: GsCourse[] = []
  const { seasons, year } = termWords(now)
  const blocks = html.split(/<div[^>]*class="[^"]*courseList--term[^"]*"[^>]*>/i).slice(1)
  const wanted = blocks.filter((b) => {
    const heading = textOf(b.slice(0, 200)).toLowerCase()
    return heading.includes(year) && seasons.some((s) => heading.includes(s))
  })
  const chosen = wanted.length ? wanted : blocks.slice(0, 1)
  const seen = new Set<string>()
  for (const block of chosen) {
    const re = /<a[^>]*class="[^"]*courseBox(?![^"]*courseBox--new)[^"]*"[^>]*href="\/courses\/(\d+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(block))) {
      const id = m[1]
      if (seen.has(id)) continue
      const short = m[2].match(/<h3[^>]*class="[^"]*courseBox--shortname[^"]*"[^>]*>([\s\S]*?)<\/h3>/i)?.[1]
      const name = short ? textOf(short) : ''
      if (!name) continue
      seen.add(id)
      out.push({ id, course: courseKey(name) })
    }
  }
  return out
}

/**
 * Student course page: one `tr[role=row]` per assignment. The first cell holds a link to the
 * submission (already submitted) or a `js-submitAssignment` button (not yet); the status cell
 * reads "No Submission" / "Submitted" / "x / y"; the time cell has `time.submissionTimeChart--dueDate`
 * with a `datetime` like `2026-10-06 21:10:00 -0700`.
 */
export function parseGradescopeAssignments(html: string, courseId: string): GsAssignment[] {
  const out: GsAssignment[] = []
  const rowRe = /<tr[^>]*role="row"[^>]*>([\s\S]*?)<\/tr>/gi
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(html))) {
    const row = m[1]
    if (/<th[^>]*scope="col"/i.test(row) || !/submissionTimeChart|js-submitAssignment|\/assignments\//.test(row)) continue
    const cells = row.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) ?? []
    const first = cells[0]
    if (cells.length < 2 || !first) continue
    const id =
      first.match(new RegExp(`/courses/${courseId}/assignments/(\\d+)`))?.[1] ??
      first.match(/data-assignment-id="(\d+)"/)?.[1] ??
      row.match(/\/assignments\/(\d+)/)?.[1]
    if (!id) continue
    const name = textOf(first)
      .replace(/\s*(Submit|Resubmit|View Submission|Upload Submission)\s*$/i, '')
      .trim()
    if (!name) continue
    const dueRaw =
      row.match(/class="[^"]*submissionTimeChart--dueDate[^"]*"[^>]*datetime="([^"]+)"/i)?.[1] ??
      row.match(/datetime="([^"]+)"[^>]*class="[^"]*submissionTimeChart--dueDate/i)?.[1]
    if (!dueRaw) continue
    const d = new Date(dueRaw.trim().replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2'))
    if (Number.isNaN(d.getTime())) continue
    const status = textOf(cells[1] ?? '')
    const submitted = /submitted|\d+(\.\d+)?\s*\/\s*\d+/i.test(status) && !/no submission/i.test(status)
    out.push({ id, name: name.slice(0, 200), due: localParts(d), submitted: submitted || /\/submissions\/\d+/.test(first) })
  }
  return out
}
