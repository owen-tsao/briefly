import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JobItem } from '../../../shared/jobs'
import { toItem } from './common'

export const INSTAGRAM_FILE = join(homedir(), '.briefly', 'instagram.json')
const STALE_MS = 3 * 3_600_000

interface SidecarItem {
  url: string
  company?: string
  title?: string
  caption?: string
  dcLink?: boolean
  referralNote?: string | null
  deadline?: string | null
  seenAt: string
}

interface SidecarFile {
  version: 1
  generatedAt: string
  items: SidecarItem[]
}

/**
 * The Instagram sidecar (Phase 5) writes ~/.briefly/instagram.json. briefly only reads it.
 * Missing file = sidecar not installed; not an error.
 */
export async function fetchInstagram(): Promise<{ items: JobItem[]; stale: boolean }> {
  if (!existsSync(INSTAGRAM_FILE)) return { items: [], stale: false }
  const raw = JSON.parse(readFileSync(INSTAGRAM_FILE, 'utf8')) as SidecarFile
  const stale = Date.now() - new Date(raw.generatedAt).getTime() > STALE_MS
  const items = (raw.items ?? [])
    .filter((it) => it.url && /^https?:\/\//.test(it.url))
    .map((it) =>
      toItem({
        source: 'instagram',
        company: it.company ?? hostToCompany(it.url),
        title: it.title ?? (it.caption ?? '').split('\n')[0].slice(0, 120) ?? 'Posting from zero2sudo',
        url: it.url,
        dcLink: it.dcLink ?? /\bdc\b|direct/i.test(it.caption ?? ''),
        referralNote: it.referralNote ?? null,
        deadline: it.deadline ?? null,
        postedAt: it.seenAt
      })
    )
  return { items, stale }
}

function hostToCompany(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '')
    const parts = h.split('.')
    const core = parts.length > 2 && /greenhouse|lever|ashby|myworkdayjobs/.test(h) ? parts[0] : parts[parts.length - 2]
    return core.charAt(0).toUpperCase() + core.slice(1)
  } catch {
    return 'Unknown'
  }
}
