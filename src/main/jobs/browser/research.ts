import type { Page } from 'playwright'
import type { JobItem } from '../../../shared/jobs'
import { extract, fetchText } from '../extract'
import { stripHtml } from '../normalize'

/**
 * What the drafter needs to answer "why us" questions honestly: the posting itself and a few pages
 * from the company's own site. Gathered once per Prepare and never stored. Everything here is
 * public web text and is passed to the model as DATA, fenced so it can't act as instructions.
 */
export interface Research {
  posting: string
  /** Company-site text, each page prefixed with "## <url>" so the model can tell pages apart. */
  company: string
  sources: string[]
}

const POSTING_CAP = 7_000
const SITE_CAP = 9_000
const PAGE_CAP = 3_500
const MAX_SITE_PAGES = 4
/** Hosts that appear on every ATS page and are never the employer. */
const NOT_THE_COMPANY =
  /(^|\.)(greenhouse\.io|ashbyhq\.com|lever\.co|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|icims\.com|jobright\.ai|simplify\.jobs|linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|glassdoor\.com|indeed\.com|google\.com|gstatic\.com|cloudfront\.net|amazonaws\.com|dover\.com|rippling\.com|bamboohr\.com|jobvite\.com|smartrecruiters\.com|apple\.com|wellfound\.com|github\.com|notion\.site|calendly\.com|eeoc\.gov|dol\.gov|e-verify\.gov|uscis\.gov)$/i

const cache = new Map<string, { at: number; site: string; sources: string[] }>()
const CACHE_MS = 6 * 60 * 60 * 1000

/** The posting page to read: the live page when briefly resolved a wrapper link (jobright), else the card's URL. */
function postingUrlFor(page: Page | null, item: JobItem): string {
  const live = page?.url() ?? ''
  if (/^https?:/.test(live) && !/jobright\.ai|simplify\.jobs/i.test(live)) return live.replace(/\/(apply|application)\/?(\?.*)?$/i, '').replace(/#.*$/, '')
  return item.url
}

export async function researchForDrafts(page: Page | null, item: JobItem): Promise<Research> {
  const postingUrl = postingUrlFor(page, item)
  const [posting, site] = await Promise.all([
    extract(postingUrl, item.company)
      .then((r) => r.text.slice(0, POSTING_CAP))
      .catch(() => ''),
    companySite(page, item).catch(() => ({ site: '', sources: [] as string[] }))
  ])
  return { posting, company: site.site, sources: site.sources }
}

async function companySite(page: Page | null, item: JobItem): Promise<{ site: string; sources: string[] }> {
  const key = item.company.toLowerCase().trim()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return { site: hit.site, sources: hit.sources }

  const home = await findCompanyHome(page, item)
  if (!home) return { site: '', sources: [] }
  const homeHtml = await fetchText(home).catch(() => null)
  if (!homeHtml?.ok || !homeHtml.text) return { site: '', sources: [] }

  const pages: { url: string; text: string }[] = [{ url: home, text: prose(homeHtml.text) }]
  for (const url of interestingLinks(homeHtml.text, home).slice(0, MAX_SITE_PAGES - 1)) {
    const r = await fetchText(url).catch(() => null)
    if (r?.ok && r.text) pages.push({ url, text: prose(r.text) })
  }
  let site = ''
  const sources: string[] = []
  for (const p of pages) {
    if (p.text.length < 200) continue
    const chunk = `## ${p.url}\n${p.text.slice(0, PAGE_CAP)}\n\n`
    if (site.length + chunk.length > SITE_CAP) break
    site += chunk
    sources.push(p.url)
  }
  cache.set(key, { at: Date.now(), site, sources })
  return { site, sources }
}

/**
 * The employer's homepage: the external host linked most often from the posting page (logo, footer,
 * "learn more"), ignoring ATS and social hosts. Falls back to the JSON-LD hiringOrganization URL when
 * the posting carries one.
 */
async function findCompanyHome(page: Page | null, item: JobItem): Promise<string | null> {
  const counts = new Map<string, number>()
  const bump = (href: string): void => {
    try {
      const u = new URL(href)
      if (!/^https?:$/.test(u.protocol) || NOT_THE_COMPANY.test(u.hostname)) return
      const host = u.hostname.replace(/^www\./, '')
      counts.set(host, (counts.get(host) ?? 0) + 1)
    } catch {
      // not a URL
    }
  }
  if (page) {
    const hrefs = await page
      .evaluate(() => {
        const out: string[] = []
        document.querySelectorAll('a[href]').forEach((a) => out.push((a as HTMLAnchorElement).href))
        const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => s.textContent ?? '')
        for (const block of ld) {
          const m = block.match(/"sameAs"\s*:\s*"([^"]+)"|"hiringOrganization"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/)
          if (m) out.push(m[1] ?? m[2])
        }
        return out
      })
      .catch(() => [] as string[])
    hrefs.forEach(bump)
  }
  // Also count links in the posting HTML itself (Lever/Ashby application pages carry fewer links).
  const html = await fetchText(postingUrlFor(page, item)).catch(() => null)
  if (html?.ok) for (const m of html.text.matchAll(/href="(https?:\/\/[^"]+)"/g)) bump(m[1])

  // Prefer a host that shares a token with the company name; otherwise the most-linked one.
  const nameTokens = item.company
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !/^(inc|llc|labs?|the|and|corp|co|ai|technologies|technology|systems|group)$/.test(t))
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const named = ranked.find(([host]) => nameTokens.some((t) => host.includes(t)))
  const pick = named ?? ranked[0]
  return pick ? `https://${pick[0]}/` : null
}

/** Same-site links whose path says "about us", "research", "blog", "product": the pages that explain what a company does. */
function interestingLinks(html: string, home: string): string[] {
  const base = new URL(home)
  const seen = new Set<string>()
  const scored: { url: string; score: number }[] = []
  for (const m of html.matchAll(/href="([^"#?]+)/g)) {
    let u: URL
    try {
      u = new URL(m[1], home)
    } catch {
      continue
    }
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue
    const path = u.pathname.toLowerCase()
    if (seen.has(path) || path === '/' || /\.(png|jpg|svg|pdf|css|js)$/.test(path)) continue
    seen.add(path)
    const score = /about|mission|company|who-we-are/.test(path) ? 3 : /research|publications|technology|science|platform|product|what-we-do|solutions/.test(path) ? 2 : /blog|news|updates|press/.test(path) ? 1 : 0
    if (score) scored.push({ url: u.toString(), score })
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.url)
}

/** Visible prose only: drop nav/footer noise, keep lines that read like sentences. */
function prose(html: string): string {
  const body = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html
  const noChrome = body.replace(/<(nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, ' ')
  return stripHtml(noChrome)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 30 && /[a-z]{3,}\s+[a-z]{3,}/i.test(l) && !/cookie|privacy policy|all rights reserved|©/i.test(l))
    .join('\n')
}
