import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProfileFile } from '../../shared/jobs'
import { getProfileDir } from '../settings'

export const PROFILE_FILES: ProfileFile['name'][] = [
  'resume.md',
  'preferences.md',
  'answers.md',
  'watchlist.md'
]

const PREFERENCES_SEED = `Apply if all three hold
- Real engineering: you'd write production or research code, not analyst, ops, GRC, or consulting-deliverable work.
- Credible company: recognizable brand, or a startup with serious backing (known investors, real revenue, or a founder with a track record).
- Pay roughly $40/hr or better. Unknown pay is fine — most postings don't say.

Skip only for hard blockers
- Ineligible: grad-date window, degree level (MS/PhD), citizenship, location rule.
- Non-engineering role.
- Explicit stack mismatch where the posting requires a language you don't have.
- Co-op that eats a school quarter you haven't planned to take off.
- Direct competitor to Clad.
- Known pay under about $35/hr at an unknown brand.

Soft flags, mention once, don't block
- Off your AI/ML lane. Prestige below FAANG. Location outside Seattle/Bay/NYC.

Timing
- Summer 2027 is primary. Winter/Spring 2027 is live as a secondary.

Facts the matcher needs for eligibility checks (fill in)
- Grad date:
- Degree level:
- Work authorization / sponsorship:
- Quarters I can take off for a co-op:
- Clad is:
`

const ANSWERS_SEED = `# Standard application answers
# Aside reads this when you click Apply. Every wrong line here is a silent auto-reject.

## Identity and links
- Name:
- Email:
- Phone:
- LinkedIn:
- GitHub:
- Portfolio:
- Location (city, state):

## Education
- School:
- Degree / major:
- GPA:
- Expected graduation (month, year):
- Earliest start date:

## Eligibility
- Work authorization:
- Will you now or in the future require sponsorship:
- Willing to relocate:
- Preferred locations:
- Quarters available for co-op:

## Standing policy
- EEO / voluntary questions:
- Salary expectation:
- How did you hear about us:

## Files
- Resume PDF: ~/.briefly/profile/resume.pdf
`

const WATCHLIST_SEED = `# One company per line. Optionally pin its ATS board so briefly polls it directly:
#   Stripe greenhouse:stripe
#   Palantir lever:palantir
#   OpenAI ashby:openai
#   NVIDIA workday:nvidia/NVIDIAExternalCareerSite
# Lines without a board are matched by company name in the aggregator feeds only.
`

const RESUME_SEED = `# Resume (markdown)
# Paste your resume here. The matcher reads this to judge fit; Aside uploads resume.pdf.
`

const SEEDS: Record<ProfileFile['name'], string> = {
  'resume.md': RESUME_SEED,
  'preferences.md': PREFERENCES_SEED,
  'answers.md': ANSWERS_SEED,
  'watchlist.md': WATCHLIST_SEED
}

export function defaultProfileDir(): string {
  return join(homedir(), '.briefly', 'profile')
}

export function profileDir(): string {
  return getProfileDir() || defaultProfileDir()
}

/** Create the folder and seed any missing files. Never overwrites. */
export function ensureProfile(): string {
  const dir = profileDir()
  mkdirSync(dir, { recursive: true })
  for (const name of PROFILE_FILES) {
    const p = join(dir, name)
    if (!existsSync(p)) writeFileSync(p, SEEDS[name])
  }
  return dir
}

export function profileFiles(): ProfileFile[] {
  const dir = profileDir()
  return PROFILE_FILES.map((name) => {
    const p = join(dir, name)
    if (!existsSync(p)) return { name, exists: false, modifiedAt: null }
    return { name, exists: true, modifiedAt: statSync(p).mtime.toISOString() }
  })
}

export function readProfileFile(name: ProfileFile['name']): string {
  const p = join(profileDir(), name)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

/** Stable hash of everything the matcher reads. Changes → items are re-scored. */
export function profileVersion(): string {
  const h = createHash('sha1')
  for (const name of ['resume.md', 'preferences.md'] as const) h.update(readProfileFile(name))
  return h.digest('hex').slice(0, 12)
}

export interface WatchEntry {
  company: string
  ats: 'greenhouse' | 'lever' | 'ashby' | 'workday' | null
  board: string | null
}

/** Parse watchlist.md: "Company [ats:board]" per line; `#` comments. */
export function readWatchlist(): WatchEntry[] {
  const out: WatchEntry[] = []
  for (const raw of readProfileFile('watchlist.md').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = line.match(/^(.*?)\s+(greenhouse|lever|ashby|workday):(\S+)$/i)
    if (m) {
      out.push({ company: m[1].trim(), ats: m[2].toLowerCase() as WatchEntry['ats'], board: m[3] })
    } else {
      out.push({ company: line, ats: null, board: null })
    }
  }
  return out
}

/** True when the profile folder has any file the user has touched beyond the seeds. */
export function profileHasContent(): boolean {
  const dir = profileDir()
  if (!existsSync(dir)) return false
  return readdirSync(dir).some((f) => {
    const name = f as ProfileFile['name']
    if (!PROFILE_FILES.includes(name)) return false
    return readProfileFile(name).trim() !== SEEDS[name].trim()
  })
}
