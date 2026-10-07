import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JobItem } from '../../../shared/jobs'
import { hostToCompany, slugTitle } from '../normalize'
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
  generatedAt?: string
  /** Written by poll.py since Oct 2026; older files have no status and are judged by age alone. */
  status?: { state: 'ok' | 'paused' | 'halted'; reason?: string; at?: string; until?: string }
  items: SidecarItem[]
}

/**
 * The Instagram sidecar (Phase 5) writes ~/.briefly/instagram.json. briefly only reads it.
 * Missing file = sidecar not installed; not an error.
 *
 * A halted sidecar (account suspended) is no longer a feed: its items are not returned, so they
 * age out of the store like any posting that stopped appearing, instead of looking fresh forever.
 * Acted-on ones keep their snapshots.
 */
export async function fetchInstagram(): Promise<{ items: JobItem[]; problem: string | null }> {
  if (!existsSync(INSTAGRAM_FILE)) return { items: [], problem: null }
  const raw = JSON.parse(readFileSync(INSTAGRAM_FILE, 'utf8')) as SidecarFile
  const status = raw.status
  if (status?.state === 'halted') {
    return {
      items: [],
      problem: `Instagram sidecar halted${status.reason ? ` — ${status.reason}` : ''}${since(status.at)}. Paste zero2sudo links by hand, or set up a new account and run poll.py --login.`
    }
  }
  let problem: string | null = null
  if (status?.state === 'paused') {
    problem = `Instagram sidecar paused${status.reason ? ` — ${status.reason}` : ''}${status.until ? `, retrying after ${shortTime(status.until)}` : ''}`
  } else {
    const generated = raw.generatedAt ? Date.parse(raw.generatedAt) : NaN
    if (Number.isNaN(generated) || Date.now() - generated > STALE_MS) {
      problem = `instagram.json last written ${ageOf(generated)} — the sidecar's launchd job isn't running`
    }
  }
  const items = (raw.items ?? [])
    .filter((it): it is SidecarItem & { url: string } => Boolean(it.url && /^https?:\/\//.test(it.url)))
    .map((it) => {
      const kind = classifyKind(it.url, `${it.title ?? ''} ${it.caption ?? ''}`)
      return toItem({
        source: 'instagram',
        kind,
        // Event platforms are multi-tenant, so the host names the platform, not the host company;
        // the screening pass fills in the organiser from the page.
        company: it.company ?? (kind === 'event' && EVENT_HOST.test(hostOf(it.url)) ? 'Event' : hostToCompany(it.url)),
        title:
          realTitle(it.title) ||
          realTitle(firstLine(it.caption)) ||
          slugTitle(it.url) ||
          (kind === 'event' ? 'Event from zero2sudo' : 'Posting from zero2sudo'),
        url: it.url,
        dcLink: it.dcLink ?? /\bdc\b|direct/i.test(it.caption ?? ''),
        referralNote: it.referralNote ?? null,
        deadline: it.deadline ?? null,
        postedAt: it.takenAt ?? it.seenAt
      })
    })
  return { items, problem }
}

function since(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? '' : ` on ${new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

function shortTime(iso: string): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function ageOf(ms: number): string {
  if (Number.isNaN(ms)) return 'at an unknown time'
  const hours = Math.round((Date.now() - ms) / 3_600_000)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)} days ago`
}

/** Platforms whose links are always events; company names live in the page, not the host. */
const EVENT_HOST = /(^|\.)(lu\.ma|luma\.com|eventbrite\.[a-z.]+|partiful\.com|meetup\.com|hopin\.com|splashthat\.com|bevy\.com|airmeet\.com|ti\.to|posh\.vip|evite\.com|zoom\.us|webex\.com|brazenconnect\.com|careereco\.com|handshake\.com)$/i
/** Company-hosted pages that are events rather than postings, judged from the URL path and any sticker text. */
const EVENT_WORDS = /\b(info[- ]?sessions?|meet-?ups?|hiring events?|career fairs?|recruiting events?|resume drops?|office hours|webinars?|open house|tech talks?|mixer|fireside|hackathons?|rsvp)\b/i
const EVENT_PATH = /\/(events?|webinars?|rsvp|info-?sessions?)(\/|$)/i

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function classifyKind(url: string, text: string): 'posting' | 'event' {
  const host = hostOf(url)
  if (EVENT_HOST.test(host)) return 'event'
  let path = ''
  try {
    path = decodeURIComponent(new URL(url).pathname)
  } catch {
    /* unparseable url: fall through to text */
  }
  if (EVENT_PATH.test(path)) return 'event'
  return EVENT_WORDS.test(`${path.replace(/[-_/]/g, ' ')} ${text}`) ? 'event' : 'posting'
}

function firstLine(caption: string | null | undefined): string {
  return (caption ?? '').split('\n')[0].trim().slice(0, 120)
}

/**
 * Instagram's default sticker labels say nothing about the role; treat them as absent.
 */
const GENERIC_LABEL = /^(visit link|apply( here| now)?|link|see more|learn more|swipe up|tap here)[.!]?$/i
function realTitle(s: string | null | undefined): string {
  const t = (s ?? '').trim()
  return t && !GENERIC_LABEL.test(t) ? t : ''
}
