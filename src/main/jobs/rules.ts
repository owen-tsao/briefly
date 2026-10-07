import type { JobItem, JobVerdict } from '../../shared/jobs'
import type { RulesFile } from './profile'

/**
 * Deterministic pre-filter. Runs before any LLM request so plainly ineligible postings never cost
 * quota. Every reject carries the rule id and the exact text that matched, and the UI offers
 * "Score anyway", so a wrong call is visible and reversible.
 *
 * Two confidence tiers:
 *  - reject: title/company facts and unambiguous posting-text patterns.
 *  - hint:   fuzzy text patterns (degree phrasing, duration words). Never reject; passed to the
 *            LLM as "check this" so it costs nothing extra.
 */

export interface RuleHit {
  id: string
  label: string
  quote: string
}

export interface TextRuleResult {
  reject: RuleHit | null
  hints: string[]
}

const GRAD_OK_YEAR = 2028
const INTERN_WORD = /\b(intern|interns|internship|internships|co-?op|coop)\b/i
/**
 * Bump when a built-in text rule gets stricter. Apply-verdict rows are re-read once against the new
 * revision (no LLM), so a fixed rule reaches postings that were already screened.
 *   1: R2 catches "enrolled in a M.S./Ph.D."; R1 allows words between qualifier and "experience".
 *   2: R2 admits "Bachelors"/"BSc"/"BE" spellings and a bachelor's mention shortly after the sentence.
 */
export const TEXT_RULES_REV = 2

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whole-word, case-insensitive match of any entry against `text`. Returns the entry that hit. */
function matchList(text: string, entries: string[]): string | null {
  for (const e of entries) {
    if (!e) continue
    const re = new RegExp(`(^|[^a-z0-9])${esc(e)}([^a-z0-9]|$)`, 'i')
    if (re.test(text)) return e
  }
  return null
}

const TITLE_RULES: { id: string; label: string; re: RegExp; unless?: RegExp }[] = [
  {
    id: 'R1',
    label: 'New-grad / experienced role, not an internship',
    re: /\bnew grad(uate)?\b|\bearly career\b|\bentry[- ]level\b|\bgraduate (program|engineer|developer|analyst)\b/i,
    unless: /intern/i
  },
  {
    id: 'R2',
    label: "PhD or Master's required",
    re: /\b(phd|ph\.d\.?|doctoral|postdoc|predoc)\b|\bmaster['’]?s\b|\bms only\b|\bms\/phd\b/i,
    // "BS/MS", "Bachelor's or Master's", "Master's and Bachelor's" all admit a BS.
    unless: /\b(bs|ba|bachelor|undergrad)[^,)]*\/|\bbs\/ms\b|\bbs,? ms\b|\bbachelor['’]?s?\b[^,)]{0,20}\b(or|and)\b|\b(or|and)\b[^,)]{0,20}\bbachelor/i
  },
  {
    id: 'R3',
    label: 'Off-cycle term longer than one quarter',
    re: /\b([6-9]|1[0-2]|six|seven|eight|nine|twelve)[- ]months?\b|\byear[- ]long\b|\bjan(uary)?\s*[-–to]+\s*(may|jun)/i
  },
  {
    id: 'R4',
    label: 'Program for a different graduation year',
    re: /\b(sophomore|freshman|first[- ]year)\b|\bclass of 20(29|3\d)\b|\bgraduating (in )?20(26|27)\b/i,
    unless: /\bjunior\b|\b2028\b/i
  },
  {
    id: 'R8',
    label: 'Non-engineering role',
    re: /\b(it intern|help ?desk|servicenow|corporate services|business analyst|product manager|program manager|project manager|sales|marketing|data analytics|analytics intern|technology development program|scrum|qa analyst|technical writer|customer success|solutions consultant|it support|desktop support|network admin|dynamics (365|admin|developer))\b/i
  },
  {
    id: 'R14',
    label: 'Active security clearance required',
    re: /\b(ts\/sci|top secret|cleared|active (secret|clearance)|polygraph)\b/i
  }
]

/**
 * Rules that need only the feed row (title, company, location, term). Free, so they run at
 * ingest and again before scoring.
 */
export function titleRules(item: Pick<JobItem, 'title' | 'company' | 'term' | 'source'>, rules: RulesFile): RuleHit | null {
  // R0: the title must say it's an internship. Word-bounded, so "Internal", "International" and
  // "Database Internals" don't count. Only for aggregator feeds, which carry the real title:
  // Instagram and manual rows often have a placeholder or URL slug (the LLM reads the page), and
  // watchlist boards already gate on the title or on the ATS's own employment type ("Intern"),
  // which a Lever/Ashby title like "Software Engineer, Summer 2027" may not repeat.
  if (item.source !== 'instagram' && item.source !== 'manual' && item.source !== 'ats' && !INTERN_WORD.test(item.title)) {
    return { id: 'R0', label: 'Not an internship or co-op', quote: item.title.slice(0, 60) }
  }
  const blocked = matchList(item.company, rules.blocklist)
  if (blocked) return { id: 'R12', label: 'Company on your blocklist', quote: blocked }
  const capped = matchList(item.company, rules.capped)
  if (capped) return { id: 'R11', label: 'Application cap reached at this company', quote: capped }
  const competitor = matchList(item.company, rules.competitors)
  if (competitor) return { id: 'R10', label: 'Direct competitor of your employer', quote: competitor }
  const domain = matchList(item.title, rules.excludedTitleKeywords)
  if (domain) return { id: 'R9', label: 'Excluded role domain', quote: domain }
  if (item.term === 'fall-2026') return { id: 'R13', label: 'Term already passed (Fall 2026)', quote: 'fall 2026' }
  for (const r of TITLE_RULES) {
    const m = item.title.match(r.re)
    if (m && !(r.unless && r.unless.test(item.title))) return { id: r.id, label: r.label, quote: m[0] }
  }
  return null
}

/** Snippet around a match, for the "why" line. */
function around(text: string, m: RegExpMatchArray, span = 70): string {
  const start = Math.max(0, (m.index ?? 0) - 20)
  return text.slice(start, start + span).replace(/\s+/g, ' ').trim()
}

// `\b` matters: "undergraduate program … returning by Fall 2027" must not read as a graduation window.
const YEAR_WINDOW = /\bgraduat\w*[^.\n]{0,60}?\b(20\d\d)\b(?:[^.\n]{0,25}?\b(20\d\d)\b)?/gi

/**
 * Posting-text rules. Only patterns that are unambiguous reject; everything else becomes a hint.
 * Text is the cleaned page body, already fetched for the LLM anyway.
 */
export function textRules(text: string): TextRuleResult {
  const hints: string[] = []
  const t = text.slice(0, 40_000)

  // R4: an explicit graduation window that excludes both Jun and Dec 2028.
  for (const m of t.matchAll(YEAR_WINDOW)) {
    const lo = Number(m[1])
    const hi = m[2] ? Number(m[2]) : lo
    const [a, b] = lo <= hi ? [lo, hi] : [hi, lo]
    const sentence = m[0]
    // "students graduating before Dec 2027 should apply to new-grad roles" redirects earlier grads; it admits 2028.
    if (/\bnew[- ]grad|full[- ]time (role|position|opening)/i.test(sentence)) continue
    // "by 2027", "no later than 2027" → upper bound. ("before"/"prior to" are ambiguous: they also
    // introduce lower bounds, so they only hint via the LLM.)
    if (/\b(by|no later than|on or before)\b/i.test(sentence) && b < GRAD_OK_YEAR) {
      return { reject: { id: 'R4', label: 'Graduation window excludes 2028', quote: around(t, m) }, hints }
    }
    // A closed range that misses 2028 entirely.
    if (m[2] && (b < GRAD_OK_YEAR || a > GRAD_OK_YEAR)) {
      return { reject: { id: 'R4', label: 'Graduation window excludes 2028', quote: around(t, m) }, hints }
    }
  }

  // R14: must currently hold a clearance (not "ability to obtain", not "a plus").
  const clr = t.match(/\b(active|current)\s+(ts\/sci|top secret|secret|dod)?\s*(security\s+)?clearance\b/i)
  if (
    clr &&
    !/\b(ability|eligib\w*|obtain|preferred|willing|plus|desired|bonus|nice|not required|optional)\b/i.test(
      t.slice(Math.max(0, (clr.index ?? 0) - 40), (clr.index ?? 0) + 160)
    )
  ) {
    return { reject: { id: 'R14', label: 'Active security clearance required', quote: around(t, clr) }, hints }
  }

  // R1: years of professional experience stated as a requirement (not "a degree or 2+ years").
  // Allows a few words between the qualifier and "experience": "7+ years of full-time software engineering experience".
  const yrs = t.match(/\b([2-9]|1\d|two|three|four|five|six|seven|eight|ten)\+?\s*(years?|yrs?)\s+of\s+(professional|industry|relevant|work|full[- ]time|hands[- ]on|commercial|software|engineering)\b(?:\s+[\w/-]+){0,4}?\s+experience\b/i)
  if (
    yrs &&
    !/\b(preferred|plus|nice|bonus|ideally)\b/i.test(t.slice(Math.max(0, (yrs.index ?? 0) - 60), (yrs.index ?? 0) + 120)) &&
    !/\bor\s*$/i.test(t.slice(Math.max(0, (yrs.index ?? 0) - 12), yrs.index ?? 0))
  ) {
    return { reject: { id: 'R1', label: 'Requires professional experience', quote: around(t, yrs) }, hints }
  }

  // R2: degree requirement stated as "enrolled in / pursuing a Master's or PhD" with no bachelor's
  // admitted anywhere in the sentence. Handles dotted abbreviations ("M.S.", "Ph.D.").
  const degReq = t.match(
    /\b(currently\s+)?(enrolled\s+in|pursuing|working\s+towards?|candidates?\s+for|must\s+be\s+(in|enrolled\s+in))\s+(a\s+|an\s+)?[^.\n]{0,40}?\b(m\.?s\.?c?|master['’]?s?|ph\.?d\.?|doctoral|doctorate|graduate\s+(degree|program|student))\b[^.\n]{0,160}/i
  )
  if (degReq) {
    // A rule reject has no LLM backstop, so look a little past the sentence for a bachelor's mention
    // ("...Master's program. Exceptional undergraduates also considered.") before rejecting.
    const start = degReq.index ?? 0
    const window = t.slice(start, start + degReq[0].length + 160)
    const admitsBs = /\b(b\.?s\.?c?|b\.?a\.?|b\.?e\.?|bachelor\w*|baccalaureate|undergrad\w*|any\s+degree|or\s+equivalent|(junior|senior)\s+(year|standing))\b/i.test(window)
    if (!admitsBs) {
      return { reject: { id: 'R2', label: "Master's or PhD required", quote: around(t, degReq, 110) }, hints }
    }
  }

  // Hints: real signals, too context-dependent to reject on.
  const deg = t.match(/\b(currently\s+)?(pursuing|enrolled in)\s+(a\s+)?(phd|ph\.?d\.?|master['’]?s?|m\.?s\.?|graduate)\b/i)
  if (deg && !degReq) hints.push(`Degree phrasing: "${around(t, deg, 90)}" — check whether a BS is also accepted`)
  const dur = t.match(/\b([6-9]|1[0-2]|six|seven|eight|nine|twelve)[- ]months?\b|\bjanuary\b[^.\n]{0,20}\b(may|june)\b|\b(two|2)\s+(consecutive\s+)?(quarters|semesters|terms)\b/i)
  if (dur) hints.push(`Duration phrasing: "${around(t, dur, 90)}" — check whether this is a >1-quarter off-cycle commitment`)
  const cit = t.match(/\bu\.?s\.?\s+citizen(ship)?\s+(is\s+)?required\b|\bitar\b|\bus persons?\b/i)
  if (cit) hints.push(`Citizenship/ITAR language: "${around(t, cit, 90)}" — fine for a US citizen`)
  const pay = t.match(/\$\s?(\d{2})(?:\.\d+)?\s*(\/|per)\s*(hr|hour)\b/i)
  if (pay && Number(pay[1]) < 35) hints.push(`Pay ${pay[0]} is under your $35/hr floor`)

  return { reject: null, hints }
}

/** Build the skip verdict a rule produces. Shape matches an LLM verdict so the UI needs no special case. */
export function ruleVerdict(hit: RuleHit): JobVerdict {
  return {
    decision: 'skip',
    blockers: [hit.label],
    flags: [],
    matched: [],
    missing: [],
    summary: `Ruled out without an LLM call (${hit.id}): ${hit.label}. Matched "${hit.quote}".`,
    rule: hit
  }
}

/** F7: you already have several applications at this company. Hint only. */
export function applicationCountHint(company: string, appliedByCompany: Map<string, number>): string | null {
  const n = appliedByCompany.get(company.trim().toLowerCase()) ?? 0
  return n >= 3 ? `You already have ${n} applications at ${company}; check this isn't scattershot` : null
}
