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
  const t = texts.filter(Boolean).join(' ').toLowerCase()
  if (/co-?op/.test(t) && !/summer/.test(t)) return 'co-op'
  if (/fall\s*(20)?26/.test(t) || /autumn\s*(20)?26/.test(t)) return 'fall-2026'
  if (/winter\s*(20)?27/.test(t)) return 'winter-2027'
  if (/spring\s*(20)?27/.test(t)) return 'spring-2027'
  if (/summer\s*(20)?27/.test(t) || /2027/.test(t)) return 'summer-2027'
  return 'unknown'
}

const TITLE_MUST = /intern|co-?op/i
const TITLE_ANY = /software|engineer|swe|developer|machine learning|\bml\b|\bai\b|data|quant|research|infra|platform|backend|frontend|full[- ]?stack|systems|security|robotics/i
const TITLE_NOT = /\b(marketing|sales|hr\b|human resources|recruit|finance|accounting|legal|paralegal|design intern|ux|product manager|pm intern|business|operations|analyst|supply chain|mechanical|civil|electrical|chemical|nurse|pharma)/i

/** Cheap pre-filter before any network or LLM spend. */
export function titleLooksRelevant(title: string): boolean {
  return TITLE_MUST.test(title) && TITLE_ANY.test(title) && !TITLE_NOT.test(title)
}

const NON_US =
  /\b(canada|toronto|vancouver|montr[eé]al|ottawa|calgary|waterloo|united kingdom|\buk\b|london|england|ireland|dublin|germany|berlin|munich|france|paris|netherlands|amsterdam|poland|warsaw|india|bangalore|bengaluru|hyderabad|pune|mumbai|singapore|israel|tel aviv|australia|sydney|melbourne|japan|tokyo|china|shanghai|beijing|taiwan|taipei|korea|seoul|mexico|brazil|s[aã]o paulo|spain|madrid|barcelona|switzerland|zurich|sweden|stockholm)\b|,\s?(ON|BC|QC|AB)\b/i

/**
 * Locations that are plainly outside the US. Empty/remote/unknown stays in, so this only
 * removes postings that would fail the location rule anyway — before they cost LLM tokens.
 */
export function locationLooksNonUS(location: string | null | undefined): boolean {
  if (!location) return false
  return NON_US.test(location) && !/united states|\busa?\b|remote.*us|us.*remote/i.test(location)
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
