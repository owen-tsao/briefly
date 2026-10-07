import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { profileDir, readProfileFile } from '../profile'

/**
 * answers.md is a human-edited "- Question: answer" list. This turns it into the fields a form
 * filler needs, plus the raw Q&A list for matching custom questions by wording. Nothing is
 * invented: a field that isn't in the file stays empty and is reported as unfilled.
 */

export interface Candidate {
  firstName: string
  lastName: string
  preferredName: string
  fullName: string
  email: string
  phone: string
  linkedin: string
  github: string
  portfolio: string
  city: string
  state: string
  country: string
  school: string
  degree: string
  major: string
  gpa: string
  gradMonth: string
  gradYear: string
  startDate: string
  /** "yes" | "no" | "" */
  authorized: string
  /** "yes" when the authorization line says citizen / permanent resident / green card, else "". */
  citizenOrResident: string
  sponsorship: string
  relocate: string
  gender: string
  hispanic: string
  race: string
  /** "He/him" — ticks the matching box on pronoun checklists (Ashby, Lever). */
  pronouns: string
  /** Street address line, if answers.md has one ("Address: 123 Main St"); Workday asks for it. */
  street: string
  zip: string
  veteran: string
  disability: string
  howHeard: string
  salary: string
  /** Every "- Q: A" line, for fuzzy matching custom questions. */
  qa: { q: string; a: string }[]
  resumePdf: string | null
}

function pick(qa: { q: string; a: string }[], re: RegExp): string {
  return qa.find((x) => re.test(x.q))?.a ?? ''
}

/** "Yes (Dean's List)" → yes; "No — always No" → no; anything else → "" */
function yesNo(v: string): string {
  const t = v.trim().toLowerCase()
  if (/^(yes|y)\b/.test(t)) return 'yes'
  if (/^(no|n)\b/.test(t)) return 'no'
  return ''
}

export function parseAnswers(md: string): { q: string; a: string }[] {
  const out: { q: string; a: string }[] = []
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (!line.startsWith('-')) {
      // Continuation of the previous answer (the EEO line wraps onto a second line, for example).
      if (out.length) out[out.length - 1].a = `${out[out.length - 1].a} ${line}`.trim()
      continue
    }
    const m = line.slice(1).trim().match(/^\*{0,2}([^:]{2,80}?)\*{0,2}\s*:\s*(.*)$/)
    if (!m) continue
    out.push({ q: m[1].trim(), a: unwrapMarkdownLinks(m[2].trim()) })
  }
  return out.filter((x) => x.a && !/^<…>$/.test(x.a))
}

/** Editors auto-link pasted URLs as "[url](url)"; a form box wants the bare URL. */
function unwrapMarkdownLinks(a: string): string {
  return a.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '$2')
}

/** Trim, drop a trailing slash and any tracking query so what lands in the box is the plain profile URL. */
function cleanUrl(u: string): string {
  const t = u.trim()
  if (!/^https?:\/\//i.test(t)) return t
  return t.replace(/[?#].*$/, '').replace(/\/+$/, '')
}

/** "~/x" → "$HOME/x"; relative paths resolve against the profile folder. */
function expandPath(p: string): string {
  const t = p.trim().replace(/^["']|["']$/g, '')
  if (t.startsWith('~/')) return join(homedir(), t.slice(2))
  if (t.startsWith('/')) return t
  return join(profileDir(), t)
}

/**
 * The PDF the filler uploads: the "Resume PDF:" line in answers.md if it names a file that exists
 * (so you can point at the copy you actually edit, e.g. in Downloads), else resume.pdf in the
 * profile folder, else nothing — the report then says so instead of guessing.
 */
export function resolveResumePdf(qa: { q: string; a: string }[]): string | null {
  const stated = pick(qa, /^resume( pdf| file)?$/i)
  if (stated) {
    const p = expandPath(stated)
    if (existsSync(p)) return p
  }
  const fallback = join(profileDir(), 'resume.pdf')
  return existsSync(fallback) ? fallback : null
}

export function loadCandidate(): Candidate {
  const qa = parseAnswers(readProfileFile('answers.md'))
  const fullName = pick(qa, /^(full )?name$/i)
  const nameParts = fullName.split(/\s+/).filter(Boolean)
  const firstName = pick(qa, /^first name$/i) || nameParts[0] || ''
  const lastName = pick(qa, /^last name$/i) || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : '')
  const location = pick(qa, /^location/i)
  const [city = '', state = ''] = location.split(',').map((s) => s.trim())
  const grad = pick(qa, /graduation/i)
  const gradMatch = grad.match(/([A-Za-z]+)[,\s]+(\d{4})/)
  const degreeMajor = pick(qa, /^degree/i)
  // "B.S. / Computer Engineering" → both; "Computer Engineering" alone is a major with no degree level.
  const dm = degreeMajor.split(/\s*[\/,]\s*|\s+in\s+/).map((s) => s.trim())
  const degreeRe = /\b(b\.?s\.?|b\.?a\.?|bachelor|m\.?s\.?|master|ph\.?d|associate|minor)\b/i
  const degree = dm.find((s) => degreeRe.test(s)) ?? ''
  const major = dm.find((s) => s && !degreeRe.test(s)) ?? ''
  const eeo = pick(qa, /^eeo/i)
  const eeoField = (name: RegExp): string => {
    // "Gender (Male), Hispanic or Latino (No), Race (Asian/East Asian), …" — also honoured as separate lines.
    const inline = eeo.match(new RegExp(`${name.source}[^(]*\\(([^)]+)\\)`, 'i'))?.[1]
    return (inline ?? pick(qa, name)).trim()
  }
  const authAnswer = pick(qa, /work authorization|authorized to work/i)
  return {
    firstName,
    lastName,
    // No "Preferred name" line means you go by your first name; never the full name.
    preferredName: pick(qa, /^preferred( first)? name$/i) || firstName,
    fullName: fullName || [firstName, lastName].filter(Boolean).join(' '),
    email: pick(qa, /^e-?mail$/i),
    phone: pick(qa, /^phone/i),
    linkedin: cleanUrl(pick(qa, /^linkedin/i)),
    github: cleanUrl(pick(qa, /^github/i)),
    portfolio: cleanUrl(pick(qa, /^(portfolio|website|personal site)/i)),
    city,
    state,
    country: pick(qa, /^country$/i) || 'United States',
    school: pick(qa, /^(school|university)$/i),
    degree,
    major: pick(qa, /^major$/i) || major,
    gpa: pick(qa, /^gpa$/i),
    gradMonth: gradMatch?.[1] ?? '',
    gradYear: gradMatch?.[2] ?? '',
    startDate: pick(qa, /start date/i),
    authorized: yesNo(authAnswer) || (/authori[sz]ed|citizen|permanent resident|green card/i.test(authAnswer) ? 'yes' : ''),
    citizenOrResident: /citizen|permanent resident|green card/i.test(authAnswer) ? 'yes' : '',
    sponsorship: yesNo(pick(qa, /sponsorship/i)),
    relocate: yesNo(pick(qa, /relocat/i)),
    gender: eeoField(/gender/i),
    hispanic: eeoField(/hispanic/i),
    race: eeoField(/race/i),
    pronouns: pick(qa, /^pronouns?$/i),
    street: pick(qa, /^(street )?address( line 1)?$/i),
    zip: pick(qa, /^(zip|postal)( code)?$/i),
    veteran: eeoField(/veteran/i),
    disability: eeoField(/disabilit/i),
    howHeard: pick(qa, /hear about/i),
    salary: pick(qa, /salary|compensation/i),
    qa,
    resumePdf: resolveResumePdf(qa)
  }
}
