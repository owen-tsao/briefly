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
  'voice.md',
  'watchlist.md',
  'rules.md'
]

const RULES_SEED = `# Deterministic rules. briefly checks these before spending an LLM request.
# A hit here marks the posting "skip" with the rule name and the text that matched; it shows
# in Hidden with a "Score anyway" button, so a wrong call costs one click.
# One entry per line under each heading. Company names match case-insensitively on the whole word.
# Edit freely; changes apply on the next scan without a rebuild.

## Blocklist
# Companies you never want to see (R12).
Honeywell
Blue Origin
Stoke Space
L3Harris
Neighbor
Nike
Motorola Solutions
Micron
MiniMed
Medtronic
Nasdaq
Boom Supersonic
Labcorp
Gallup
Scotiabank
Dell
Assured Guaranty

## Capped
# Companies where you've hit their application limit this cycle (R11). Remove when the cap resets.
TikTok
ByteDance
Waymo
Coinbase
Verkada

## Competitors
# Direct competitors of your current employer (R10).
# Short names can carry exclusions: Sierra (not Sierra Nevada, Sierra Space)
Pylon
Decagon
Sierra
Intercom
Zendesk
Forethought
Kustomer
Gorgias
Cresta
Parloa
Crescendo
Maven AGI

## Excluded title keywords
# Role domains you don't want, matched against the job title only (R9). Regex-free plain phrases.
VLSI
RTL
ASIC
FPGA
physical design
design verification
analog
mixed-signal
iOS
Android
mobile engineer
mobile developer
clinical
pharmacovigilance
regulatory affairs
manipulation
locomotion
robot learning
controls engineer
controls intern

## Tier 1
# "Always apply" companies. Ranks eligible postings into Apply now; never hides a posting.
# Companies under "## Tier 1" in watchlist.md count here too, so pinned boards don't need repeating.
Google
Meta
Apple
Amazon
Microsoft
NVIDIA
Netflix
OpenAI
Anthropic
DeepMind
xAI
Jane Street
Citadel
Citadel Securities
Hudson River Trading
Two Sigma
Point72
DRW
IMC
Five Rings
Headlands Technologies
Stripe
Databricks
Figma
Vercel
Datadog
Scale AI
SpaceX
Anduril
Palantir
Tesla
Robinhood
DoorDash
Lyft
Dropbox
Samsara
Neuralink
Notion

`

const TIER2_SECTION = `## Tier 2
# Strong-but-less-famous companies (well-funded startups, quant shops, public tech with a real
# engineering brand). Eligible postings from these land in Apply now. Companies under "## Tier 2"
# in watchlist.md count here too — list only board-less names here.
Optiver
Akuna Capital
Susquehanna
Jump Trading
Belvedere Trading
Squarepoint
D. E. Shaw
Millennium
Schonfeld
Balyasny
Bridgewater
AQR
Aquatic Capital Management
Garda Capital Partners
Geneva Trading
Graham Capital Management
CTC
Quantbot
Virtu
IEX
Bloomberg
Uber
Airbnb
Snap
Cruise
Zoox
Aurora
Applied Intuition
Rippling
Deel
Retool
Airtable
Cohere
Glean
Writer
Runway
Cognition
Chainguard
Wiz
CrowdStrike
Okta
1Password
Snyk
Tailscale
Temporal
Neon
PlanetScale
dbt Labs
Confluent
HashiCorp
Twitch
Spotify
Faire
Whatnot
Wealthfront
SoFi
Zipline
Together AI
Gemini
Hex
Domino
Veeam
General Matter
Klaviyo
Salesforce
Adobe
Atlassian
Intuit
Riot Games
Unity
IBM Research
Microsoft Research
`

const PAY_FLOOR_SECTION = `## Apply-now pay floor
# An eligible posting that states hourly pay at or above this number goes to Apply now even if the
# company isn't in a tier. Pay is read from the description when the feed doesn't carry it.
50
`

const RULES_SEED_FULL = RULES_SEED + TIER2_SECTION + '\n' + PAY_FLOOR_SECTION

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
# Point this at the PDF you actually edit (e.g. ~/Downloads/My Resume.pdf). Falls back to resume.pdf in this folder.
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

const VOICE_SEED = `# How to write free-text answers as me
# Aside reads this only when an application has essay-style questions ("why us", "top project",
# "outside of class"). Keep it honest: anything not here gets [ASK OWEN: ...] instead of a guess.

ABOUT ME (use only what's relevant to the question; never dump all of it)
- (fill in: school, year, availability)
- (fill in: current role and 3-4 things you actually shipped, with numbers where real)
- (fill in: 2-3 projects, each with one phrase of plain-language context)
- (fill in: anything non-technical you'd mention: teaching, sports, music, a foundation)

STYLE RULES (these matter more than anything above)
- Short. One paragraph, 80-150 words, unless the question asks for a list or gives a length. Stay under any character limit.
- Plain, direct sentences. Sound like a person, not a brand.
- Pick one or two experiences that actually fit the question. Do not list everything.
- Specifics are good when they carry weight (a number, a real decision, a real failure), bad when they're resume bullets restated.
- Never mention GPA.
- Don't name projects without a phrase of context.
- No metaphors or flourishes. No "passionate", "excited to", "leverage", "journey", "dive deep", "resonates".
- Never restate the company's mission back at them. A reason to like the company must connect to something concrete I've built.
- Don't invent facts, experiences, or opinions. Missing detail → [ASK OWEN: what?].
- Honest over impressive. Vary sentence length. No em dashes. End when the answer is done; no wrap-up sentence.
`

const SEEDS: Record<ProfileFile['name'], string> = {
  'resume.md': RESUME_SEED,
  'preferences.md': PREFERENCES_SEED,
  'answers.md': ANSWERS_SEED,
  'voice.md': VOICE_SEED,
  'watchlist.md': WATCHLIST_SEED,
  'rules.md': RULES_SEED_FULL
}

export function defaultProfileDir(): string {
  return join(homedir(), '.briefly', 'profile')
}

export function profileDir(): string {
  return getProfileDir() || defaultProfileDir()
}

/** Create the folder and seed any missing files. Never overwrites, but appends sections newer builds rely on. */
export function ensureProfile(): string {
  const dir = profileDir()
  mkdirSync(dir, { recursive: true })
  for (const name of PROFILE_FILES) {
    const p = join(dir, name)
    if (!existsSync(p)) writeFileSync(p, SEEDS[name])
  }
  ensureRuleSections()
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
  /** Heading the line sits under: "## Tier 1" → 1, "## Tier 2" → 2, "## Auto" → 'auto', anything else → null. */
  tier: 1 | 2 | 'auto' | null
}

function tierOfHeading(h: string): WatchEntry['tier'] {
  const t = h.trim().toLowerCase()
  if (/^tier\s*1\b/.test(t)) return 1
  if (/^tier\s*2\b/.test(t)) return 2
  if (/^auto\b/.test(t)) return 'auto'
  return null
}

/** Parse watchlist.md: "Company [ats:board]" per line; `#` comments; `## Tier N` headings tag the entries below. */
export function readWatchlist(): WatchEntry[] {
  const out: WatchEntry[] = []
  let tier: WatchEntry['tier'] = null
  for (const raw of readProfileFile('watchlist.md').split('\n')) {
    const heading = raw.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      tier = tierOfHeading(heading[1])
      continue
    }
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = line.match(/^(.*?)\s+(greenhouse|lever|ashby|workday):(\S+)$/i)
    if (m) {
      out.push({ company: m[1].trim(), ats: m[2].toLowerCase() as WatchEntry['ats'], board: m[3], tier })
    } else {
      out.push({ company: line, ats: null, board: null, tier })
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

export interface RulesFile {
  blocklist: string[]
  capped: string[]
  competitors: string[]
  excludedTitleKeywords: string[]
  tier1: string[]
  tier2: string[]
  /** Hourly pay at or above which an eligible posting counts as "Apply now" on its own. */
  payFloor: number
}

type ListSection = Exclude<keyof RulesFile, 'payFloor'>

const RULE_SECTIONS: Record<string, ListSection | 'payFloor'> = {
  blocklist: 'blocklist',
  capped: 'capped',
  competitors: 'competitors',
  'excluded title keywords': 'excludedTitleKeywords',
  'tier 1': 'tier1',
  'tier 2': 'tier2',
  'apply-now pay floor': 'payFloor',
  'apply now pay floor': 'payFloor'
}

export const DEFAULT_PAY_FLOOR = 50

/** Parse rules.md: `## Heading` sections with one entry per line; `#` comments. Unknown headings are ignored. */
export function readRules(): RulesFile {
  const out: RulesFile = {
    blocklist: [],
    capped: [],
    competitors: [],
    excludedTitleKeywords: [],
    tier1: [],
    tier2: [],
    payFloor: DEFAULT_PAY_FLOOR
  }
  let current: ListSection | 'payFloor' | null = null
  for (const raw of readProfileFile('rules.md').split('\n')) {
    const heading = raw.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      current = RULE_SECTIONS[heading[1].trim().toLowerCase()] ?? null
      continue
    }
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (!line || !current) continue
    if (current === 'payFloor') {
      const n = Number(line.replace(/[$,\s]|\/?hr|hour/gi, ''))
      if (Number.isFinite(n) && n >= 0 && n <= 500) out.payFloor = n
      continue
    }
    out[current].push(line.slice(0, 80))
  }
  return out
}

/** Sections added after a user's rules.md was seeded; appended once so new features have a home. */
const RULE_ADDENDA: { heading: RegExp; text: string }[] = [
  { heading: /^##\s+tier\s*2\b/im, text: TIER2_SECTION },
  { heading: /^##\s+apply[- ]now pay floor\b/im, text: PAY_FLOOR_SECTION }
]

/** Append any rules.md section this build knows about that the user's file doesn't have yet. Never edits existing text. */
export function ensureRuleSections(): void {
  const p = join(profileDir(), 'rules.md')
  if (!existsSync(p)) return
  let text = readFileSync(p, 'utf8')
  let changed = false
  for (const { heading, text: section } of RULE_ADDENDA) {
    if (heading.test(text)) continue
    text = text.replace(/\s*$/, '\n\n') + section
    changed = true
  }
  if (changed) writeFileSync(p, text)
}

/** Hash of rules.md; when it changes, rule-made verdicts are re-evaluated (cheaply, no LLM). */
export function rulesVersion(): string {
  return createHash('sha1').update(readProfileFile('rules.md')).digest('hex').slice(0, 12)
}
