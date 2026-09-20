import { classifyUrl, greenhouseEmbedId, stripHtml, type AtsRef } from './normalize'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
const TIMEOUT_MS = 20_000
/** Feeds are a few MB at most; anything bigger is not a job posting. */
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MIN_READABLE = 500

export interface Extracted {
  text: string
  descriptionAvailable: boolean
  /** Populated from ATS metadata when present. */
  location?: string | null
  postedAt?: string | null
}

/**
 * Fetch and read the whole body under one deadline and size cap. `fetch` alone only times out
 * the headers, so a slow or endless body could otherwise park a scan until restart.
 */
export async function fetchText(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; text: string }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/json, text/html;q=0.9', ...(init.headers ?? {}) }
    })
    if (!r.ok || !r.body) return { ok: r.ok, status: r.status, text: '' }
    const declared = Number(r.headers.get('content-length') ?? 0)
    if (declared > MAX_BODY_BYTES) throw new Error(`response too large (${declared} bytes)`)
    const reader = r.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new Error('response too large')
      }
      chunks.push(value)
    }
    return { ok: true, status: r.status, text: Buffer.concat(chunks).toString('utf8') }
  } finally {
    clearTimeout(t)
  }
}

export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T | null> {
  try {
    const r = await fetchText(url, init)
    if (!r.ok) return null
    return JSON.parse(r.text) as T
  } catch {
    return null
  }
}

async function fromAts(ref: NonNullable<AtsRef>): Promise<Extracted | null> {
  switch (ref.ats) {
    case 'greenhouse': {
      const j = await getJson<{ content?: string; location?: { name?: string }; updated_at?: string }>(
        `https://boards-api.greenhouse.io/v1/boards/${ref.board}/jobs/${ref.id}`
      )
      if (!j) return null
      // Greenhouse returns HTML-escaped HTML in `content`.
      const text = stripHtml(stripHtml(j.content ?? ''))
      return { text, descriptionAvailable: text.length >= MIN_READABLE, location: j.location?.name ?? null, postedAt: j.updated_at ?? null }
    }
    case 'lever': {
      const j = await getJson<{
        descriptionPlain?: string
        lists?: { text: string; content: string }[]
        additionalPlain?: string
        categories?: { location?: string }
        createdAt?: number
      }>(`https://api.lever.co/v0/postings/${ref.board}/${ref.id}`)
      if (!j) return null
      const text = [
        j.descriptionPlain ?? '',
        ...(j.lists ?? []).map((l) => `${l.text}\n${stripHtml(l.content)}`),
        j.additionalPlain ?? ''
      ]
        .join('\n')
        .trim()
      return {
        text,
        descriptionAvailable: text.length >= MIN_READABLE,
        location: j.categories?.location ?? null,
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null
      }
    }
    case 'ashby': {
      const j = await getJson<{ jobs?: { id: string; descriptionPlain?: string; location?: string; publishedAt?: string }[] }>(
        `https://api.ashbyhq.com/posting-api/job-board/${ref.board}`
      )
      const job = j?.jobs?.find((x) => x.id === ref.id)
      if (!job) return null
      const text = job.descriptionPlain ?? ''
      return { text, descriptionAvailable: text.length >= MIN_READABLE, location: job.location ?? null, postedAt: job.publishedAt ?? null }
    }
    case 'workday': {
      const j = await getJson<{ jobPostingInfo?: { jobDescription?: string; location?: string; startDate?: string } }>(
        `https://${ref.tenant}.${ref.wd}.myworkdayjobs.com/wday/cxs/${ref.tenant}/${ref.site}/job/${ref.path}`
      )
      const info = j?.jobPostingInfo
      if (!info) return null
      const text = stripHtml(info.jobDescription ?? '')
      return { text, descriptionAvailable: text.length >= MIN_READABLE, location: info.location ?? null, postedAt: info.startDate ?? null }
    }
  }
}

/** Company-site Greenhouse embeds: try the API with a few slug guesses from the company name. */
async function fromGreenhouseEmbed(url: string, company: string): Promise<Extracted | null> {
  const id = greenhouseEmbedId(url)
  if (!id) return null
  const base = company.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const guesses = [...new Set([base, base.replace(/inc|labs|technologies|ai$/g, ''), new URL(url).hostname.split('.').slice(-2, -1)[0]])].filter(Boolean)
  for (const slug of guesses) {
    const r = await fromAts({ ats: 'greenhouse', board: slug, id })
    if (r && r.descriptionAvailable) return r
  }
  return null
}

async function fromHtml(url: string): Promise<Extracted> {
  try {
    const r = await fetchText(url)
    if (!r.ok) return { text: '', descriptionAvailable: false }
    const html = r.text
    // Prefer JSON-LD JobPosting when a site ships one — it's the cleanest text on the page.
    const ld = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? []
    for (const block of ld) {
      try {
        const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')
        const data = JSON.parse(inner)
        const nodes = Array.isArray(data) ? data : [data]
        for (const n of nodes) {
          if (n && (n['@type'] === 'JobPosting' || n['@type']?.includes?.('JobPosting')) && n.description) {
            const text = stripHtml(String(n.description))
            if (text.length >= MIN_READABLE) {
              return { text, descriptionAvailable: true, postedAt: n.datePosted ?? null, location: n.jobLocation?.address?.addressLocality ?? null }
            }
          }
        }
      } catch {
        // Not our JSON; keep looking.
      }
    }
    const body = html.match(/<main[\s\S]*<\/main>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html
    const text = stripHtml(body)
    // SPA shells return a few hundred chars of chrome; JSON payloads inline can look huge but aren't prose.
    const prose = text.split('\n').filter((l) => l.length > 40 && /[a-z]{3,}\s+[a-z]{3,}/i.test(l)).join('\n')
    return { text: prose.slice(0, 20_000), descriptionAvailable: prose.length >= MIN_READABLE }
  } catch {
    return { text: '', descriptionAvailable: false }
  }
}

/**
 * Get the posting text. ATS JSON first (clean, stable), Greenhouse-embed guess second,
 * plain HTML last. Never throws.
 */
export async function extract(url: string, company: string): Promise<Extracted> {
  try {
    const ref = classifyUrl(url)
    if (ref) {
      const r = await fromAts(ref)
      if (r) return r
    }
    const embed = await fromGreenhouseEmbed(url, company)
    if (embed) return embed
  } catch {
    // Malformed URL or unexpected API shape: fall through to plain HTML, which has its own guard.
  }
  return fromHtml(url)
}
