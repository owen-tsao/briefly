import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addAutoWatched, appliedPostings, getAutoWatched } from './jobsStore'
import { classifyUrl } from './normalize'
import { profileDir, readWatchlist } from './profile'

/**
 * Auto-watch: a company you applied to is one worth hearing from first. Every application whose
 * URL points at a Greenhouse / Lever / Ashby / Workday board pins that board under "## Auto" in
 * watchlist.md, so its next posting arrives from the board itself rather than a day later from an
 * aggregator. Deleting a line is respected: a handle we once added and no longer find is not re-added.
 */

const AUTO_HEADING = '## Auto'
const AUTO_INTRO = `${AUTO_HEADING}
# Boards briefly pinned because you applied to a posting on them. Delete a line to stop polling
# that board; it won't come back. Move a line up to Tier 1/2 to rank the company higher.`

const NOISE = /\s+(job board|careers?|- careers|campus|university (recruiting|jobs)|\(interns?\)|usa|llc|inc\.?|internship)$/i

/** Handle as written in watchlist.md ("greenhouse:acme", "workday:tenant/Site"). Compare with `key()`, not directly. */
export function boardHandle(url: string): string | null {
  const ref = classifyUrl(url)
  if (!ref) return null
  if (ref.ats === 'workday') return `workday:${ref.tenant.toLowerCase()}/${ref.site}`
  return `${ref.ats}:${ref.board.toLowerCase()}`
}

/** Case-insensitive identity for a handle; Workday site names carry case we must keep when writing, and a user's `@wd5` hint is the same board. */
const key = (handle: string): string => handle.toLowerCase().replace(/@wd\d+$/, '')

function cleanCompany(name: string): string {
  // "#" starts a comment in watchlist.md, so it can't be part of the name we write.
  let n = name.replace(/#/g, '').replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 3; i++) n = n.replace(NOISE, '').trim()
  return (n || 'Company').slice(0, 60)
}

/** Add boards for new applications; returns how many lines were appended. Safe to call every scan. */
export function autoWatchFromApplications(): number {
  const p = join(profileDir(), 'watchlist.md')
  if (!existsSync(p)) return 0
  const present = new Set(
    readWatchlist()
      .filter((w) => w.ats && w.board)
      .map((w) => key(`${w.ats}:${w.board}`))
  )
  const removed = new Set(getAutoWatched().map(key).filter((h) => !present.has(h)))

  const fresh = new Map<string, string>()
  for (const { company, url } of appliedPostings()) {
    const handle = boardHandle(url)
    if (!handle) continue
    const k = key(handle)
    if (present.has(k) || removed.has(k) || fresh.has(handle)) continue
    fresh.set(handle, cleanCompany(company))
  }
  if (fresh.size === 0) return 0

  let text = readFileSync(p, 'utf8')
  if (!/^##\s+auto\b/im.test(text)) text = text.replace(/\s*$/, '\n\n') + AUTO_INTRO + '\n'
  const lines = [...fresh].map(([handle, company]) => `${company} ${handle}`)
  writeFileSync(p, insertIntoAutoSection(text, lines))
  addAutoWatched([...fresh.keys()].map(key))
  return fresh.size
}

/** Put lines at the end of the "## Auto" section, before whatever heading follows it (if any). */
function insertIntoAutoSection(text: string, lines: string[]): string {
  const all = text.split('\n')
  const start = all.findIndex((l) => /^##\s+auto\b/i.test(l))
  let end = all.length
  for (let i = start + 1; i < all.length; i++) {
    if (/^##\s+/.test(all[i])) {
      end = i
      break
    }
  }
  while (end > start + 1 && all[end - 1].trim() === '') end--
  all.splice(end, 0, ...lines)
  return all.join('\n').replace(/\s*$/, '\n')
}
