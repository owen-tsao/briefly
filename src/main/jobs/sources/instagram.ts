import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JobItem } from '../../../shared/jobs'
import { classifyUrl } from '../normalize'
import { toItem } from './common'

export const INSTAGRAM_FILE = process.env.BRIEFLY_IG_FILE ?? join(homedir(), '.briefly', 'instagram.json')
const STALE_MS = 3 * 3_600_000

interface SidecarItem {
  storyId?: string
  url: string | null
  company?: string
  title?: string | null
  caption?: string | null
  dcLink?: boolean
  referralNote?: string | null
  deadline?: string | null
  imagePath?: string | null
  takenAt?: string
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
    .filter((it): it is SidecarItem & { url: string } => Boolean(it.url && /^https?:\/\//.test(it.url)))
    .map((it) =>
      toItem({
        source: 'instagram',
        company: it.company ?? hostToCompany(it.url),
        title: it.title ?? (it.caption ?? '').split('\n')[0].slice(0, 120) ?? 'Posting from zero2sudo',
        url: it.url,
        dcLink: it.dcLink ?? /\bdc\b|direct/i.test(it.caption ?? ''),
        referralNote: it.referralNote ?? null,
        deadline: it.deadline ?? null,
        postedAt: it.takenAt ?? it.seenAt
      })
    )
  return { items, stale }
}

function hostToCompany(url: string): string {
  const ref = classifyUrl(url)
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
  if (ref) return cap(decodeURIComponent(ref.ats === 'workday' ? ref.tenant : ref.board))
  try {
    const parts = new URL(url).hostname.replace(/^www\./, '').split('.')
    return cap(parts[parts.length - 2] ?? 'Unknown')
  } catch {
    return 'Unknown'
  }
}
