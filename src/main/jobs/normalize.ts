import { createHash } from 'node:crypto'
import type { JobTerm } from '../../shared/jobs'

export type Ats = 'greenhouse' | 'lever' | 'ashby' | 'workday'

export type AtsRef =
  | { ats: 'greenhouse'; board: string; id: string }
  | { ats: 'lever'; board: string; id: string }
  | { ats: 'ashby'; board: string; id: string }
  | { ats: 'workday'; tenant: string; wd: string; site: string; path: string }
  | null

/** Recognize the four ATSs whose public JSON APIs we read. Anything else → null. */
export function classifyUrl(url: string): AtsRef {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const h = u.hostname.toLowerCase()
  const p = u.pathname
  let m: RegExpMatchArray | null
  if (/^(boards|job-boards)\.greenhouse\.io$/.test(h) && (m = p.match(/^\/([^/]+)\/jobs\/(\d+)/))) {
    return { ats: 'greenhouse', board: m[1], id: m[2] }
  }
  // Greenhouse embeds on company sites carry the job id as ?gh_jid=; board is resolved later.
  if (h === 'jobs.lever.co' && (m = p.match(/^\/([^/]+)\/([0-9a-f-]{36})/))) {
    return { ats: 'lever', board: m[1], id: m[2] }
  }
  if (h === 'jobs.ashbyhq.com' && (m = p.match(/^\/([^/]+)\/([0-9a-f-]{36})/))) {
    return { ats: 'ashby', board: m[1], id: m[2] }
  }
  if ((m = h.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/))) {
    const pm = p.match(/^\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)\/job\/(.+)$/)
    if (pm) return { ats: 'workday', tenant: m[1], wd: m[2], site: pm[1], path: pm[2] }
  }
  return null
}

/** Greenhouse job id embedded in a company careers page URL, if any. */
export function greenhouseEmbedId(url: string): string | null {
  try {
    const id = new URL(url).searchParams.get('gh_jid')
    return id && /^\d+$/.test(id) ? id : null
  } catch {
    return null
  }
}

const TRACKING = /^(utm_|gh_src|lever-|src|source|ref|referrer|trk|mc_|embed)$/i
const TRACKING_PREFIX = /^(utm_|lever-|mc_)/i

/** Strip tracking params and fragments so the same posting from two feeds gets one id. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim())
    u.hash = ''
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k) || TRACKING_PREFIX.test(k)) u.searchParams.delete(k)
    u.hostname = u.hostname.toLowerCase()
    let s = u.toString()
    if (s.endsWith('/')) s = s.slice(0, -1)
    if (s.endsWith('?')) s = s.slice(0, -1)
    return s
  } catch {
    return url.trim()
  }
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16)
}

/**
 * Canonical id. Greenhouse job ids, and Lever/Ashby posting UUIDs, are unique across all
 * boards, so the id ignores the board slug: `boards.greenhouse.io/acme/jobs/123` and
 * `acme.com/careers?gh_jid=123` are one posting. Workday paths are per tenant.
 */
export function canonicalId(url: string): { id: string; sourceRef: string | null } {
  const ref = classifyUrl(url)
  if (ref) {
    if (ref.ats === 'workday') {
      const key = `workday:${ref.tenant.toLowerCase()}:${ref.path}`
      return { id: sha1(key), sourceRef: key }
    }
    return { id: sha1(`${ref.ats}:${ref.id.toLowerCase()}`), sourceRef: `${ref.ats}:${ref.board.toLowerCase()}:${ref.id}` }
  }
  const gh = greenhouseEmbedId(url)
  if (gh) return { id: sha1(`greenhouse:${gh}`), sourceRef: `greenhouse:?:${gh}` }
  return { id: sha1(normalizeUrl(url)), sourceRef: null }
}

/** Term from title/tags/terms text. "2027" alone → summer; explicit season wins. */
export function detectTerm(...texts: (string | null | undefined)[]): JobTerm {
  const t = texts.filter(Boolean).join(' ').toLowerCase().replace(/_/g, ' ')
  if (/co-?op/.test(t) && !/summer/.test(t)) return 'co-op'
  // "Fall 2026/Winter 2027" is still open for the 2027 term; only a lone Fall 2026 has passed.
  if ((/fall\s*(20)?26/.test(t) || /autumn\s*(20)?26/.test(t)) && !/(winter|spring|summer)\s*(20)?27/.test(t)) return 'fall-2026'
  if (/winter\s*(20)?27/.test(t)) return 'winter-2027'
  if (/spring\s*(20)?27/.test(t)) return 'spring-2027'
  if (/summer\s*(20)?27/.test(t) || /2027/.test(t)) return 'summer-2027'
  return 'unknown'
}

// Word-bounded: "Internal Agent", "Database Internals", "International", "Cooperative Systems" are not internships.
const TITLE_MUST = /\b(intern|interns|internship|internships|co-?op|coop)\b/i
const TITLE_ANY = /software|engineer|swe|developer|machine learning|\bml\b|\bai\b|data|quant|research|infra|platform|backend|frontend|full[- ]?stack|systems|security|robotics/i
const TITLE_NOT = /\b(marketing|sales|hr\b|human resources|recruit|finance|accounting|legal|paralegal|design intern|ux|product manager|pm intern|business|operations|analyst|supply chain|mechanical|civil|electrical|chemical|nurse|pharma)/i

/** Cheap pre-filter before any network or LLM spend. Underscores read as spaces ("Co-op_Summer 2027"). */
export function titleLooksRelevant(title: string): boolean {
  const t = title.replace(/_/g, ' ')
  return TITLE_MUST.test(t) && TITLE_ANY.test(t) && !TITLE_NOT.test(t)
}

const NON_US =
  /\b(canada|toronto|vancouver|montr[eé]al|ottawa|calgary|waterloo|united kingdom|\buk\b|england|ireland|germany|berlin|munich|france|netherlands|amsterdam|poland|warsaw|india|bangalore|bengaluru|hyderabad|pune|mumbai|singapore|israel|tel aviv|australia|sydney|japan|tokyo|china|shanghai|beijing|taiwan|taipei|korea|seoul|brazil|s[aã]o paulo|spain|madrid|barcelona|switzerland|zurich|sweden|stockholm)\b|(?<!new )\bmexico\b|\b(dublin|melbourne|paris)\b(?![^,]*,\s*(ohio|florida|texas|oh|fl|tx)\b)/i
/** Canadian province codes and "London" are case-sensitive: ", on site" and "New London, CT" must not match. */
const NON_US_STRICT = /,\s?(ON|BC|QC|AB)\b|(?<!New )\bLondon\b/
const US_STATE = /\b(A[LKZR]|C[AOT]|DE|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY]|DC)\b/
const US_STATE_NAME =
  /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i

/**
 * Locations that are plainly outside the US. Empty/remote/unknown stays in, so this only
 * removes postings that would fail the location rule anyway — before they cost LLM tokens.
 * Any US marker anywhere in the string wins ("Toronto / New York" is a US option).
 */
export function locationLooksNonUS(location: string | null | undefined): boolean {
  if (!location) return false
  // ISO country codes collide with state codes: "Toronto, ON, CA" / "Berlin, DE" / "Bangalore, IN".
  // A trailing two-letter code right after a known non-US place is a country, not a state.
  const trailingCountryCode = /\b(CA|DE|IN)\s*$/.test(location.trim()) && (NON_US.test(location) || NON_US_STRICT.test(location))
  const stateCode = US_STATE.test(trailingCountryCode ? location.trim().replace(/\b(CA|DE|IN)\s*$/, '') : location)
  if (/united states|\busa?\b|remote.*us|us.*remote/i.test(location) || stateCode || US_STATE_NAME.test(location)) {
    return false
  }
  return NON_US.test(location) || NON_US_STRICT.test(location)
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/**
 * Best-effort role name from a URL. Many ATS URLs carry the role in the path
 * ("/jobs/10559746/software-development-engineer-intern-summer-2027"), which beats a blank.
 * Returns '' when the path is only ids or site chrome.
 */
const SITE_CHROME = /^(careers?-home|job-?boards?|job-?search|en-us|search-results|job-details?)$/i
export function slugTitle(url: string): string {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean)
    const slug = [...segs]
      .reverse()
      .find((s) => /[a-z]/i.test(s) && /-/.test(s) && !/^[0-9a-f-]{32,}$/i.test(s) && !SITE_CHROME.test(s))
    if (!slug) return ''
    return slug
      .replace(/\.[a-z]+$/i, '')
      // Workday appends the requisition id to the slug: "...-Summer-2027_JR1990001".
      .replace(/_[A-Z]*\d+$/i, '')
      .split('-')
      .filter((w) => w && !/^\d+$/.test(w))
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
      .slice(0, 120)
  } catch {
    return ''
  }
}

/** Multi-tenant ATS hosts where the company is a path segment, not the hostname. */
const PATH_TENANT: { host: RegExp; seg: number }[] = [
  { host: /^jobs\.smartrecruiters\.com$/, seg: 0 }, // /Intuitive/7440-ai-research-intern
  { host: /^app\.careerpuck\.com$/, seg: 1 } // /job-board/lyft/job/123
]
/** Single-tenant ATS hosts of the form <company>.<ats>.com or careers-<company>.<ats>.com. */
const SUBDOMAIN_TENANT = /^(?:careers-|jobs-)?([a-z0-9-]+)\.(?:icims|jibeapply|myworkdayjobs|wd\d+\.myworkdayjobs|taleo|successfactors|avature)\.(?:com|net)$/i

/** Best-effort company name from a posting URL: ATS board handle first, then host heuristics. */
export function hostToCompany(url: string): string {
  const ref = classifyUrl(url)
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
  if (ref) return cap(decodeURIComponent(ref.ats === 'workday' ? ref.tenant : ref.board))
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const segs = u.pathname.split('/').filter(Boolean)
    const pathRule = PATH_TENANT.find((r) => r.host.test(host))
    if (pathRule && segs[pathRule.seg]) return cap(decodeURIComponent(segs[pathRule.seg]))
    const sub = SUBDOMAIN_TENANT.exec(host)
    if (sub) return cap(sub[1])
    if (host === 'google.com' && segs[0] === 'about') return 'Google'
    if (/(^|\.)withgoogle\.com$/.test(host)) return 'Google'
    const parts = host.split('.')
    // careers.lutron.com / jobs.statefarm.com → the registrable label, not the "careers" prefix.
    return cap(parts[parts.length - 2] ?? 'Unknown')
  } catch {
    return 'Unknown'
  }
}
