import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  DEFAULT_BASE_URL,
  DEFAULT_BEDROCK_MODEL,
  DEFAULT_BEDROCK_REGION,
  DEFAULT_MODEL,
  type LlmProvider,
  type SettingsUpdate,
  type SettingsView
} from '../shared/types'
import { SCHOOL_POLL_CHOICES } from '../shared/school'
import { validRegion } from './bedrock'

/**
 * The profile folder override must be an absolute path inside the home directory. A relative
 * path would resolve against cwd (`/` under launchd) and the app would try to seed files there;
 * anything invalid falls back to the default (empty string).
 */
function sanitizeProfileDir(raw: string): string {
  let p = raw.trim().slice(0, 500)
  if (!p) return ''
  if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1))
  if (!isAbsolute(p)) return ''
  const abs = resolve(p)
  const home = resolve(homedir())
  return abs === home || abs.startsWith(home + '/') ? abs : ''
}

interface StoredSettings {
  llmProvider: LlmProvider
  baseUrl: string
  model: string
  /** base64 of safeStorage-encrypted key. ("plain:" prefix = legacy unencrypted value; still read, never written.) */
  apiKeyEnc: string | null
  bedrock: {
    region: string
    model: string
    /**
     * base64 of safeStorage-encrypted "accessKeyId\nsecretAccessKey". Unlike apiKeyEnc there is no
     * plaintext fallback: an AWS key pair is only ever written through the OS keychain.
     */
    credentialsEnc: string | null
    /** Last 4 characters of the access key ID, so Settings can show which key is loaded. */
    accessKeyHint: string
  }
  /** Auto-rescan interval in minutes; 0 = off. */
  autoRescanMinutes: number
  /** Native deadline notifications. */
  notificationsEnabled: boolean
  /** Hour (0–8) at which a new work day starts. */
  dayStartHour: number
  /** Jobs: profile folder override; empty = ~/.briefly/profile. */
  profileDir: string
  /** Jobs: scan interval in minutes; 0 = off. */
  jobsScanMinutes: number
  /** Jobs: include the New count in the menu bar badge. */
  jobsInBadge: boolean
  school: {
    /** base64 of safeStorage-encrypted feed URL. No plaintext fallback. */
    feedUrlEnc: string | null
    /** Hostname of the feed, so Settings can say which Canvas it points at. */
    feedHost: string
    pollMinutes: number
    taskHorizonDays: number
  }
}

const RESCAN_CHOICES = [0, 30, 60, 180, 360]
const JOBS_SCAN_CHOICES = [0, 5, 15, 30, 60]
const TASK_HORIZON_CHOICES = [0, 2, 3, 7, 14, 21, 30]
const DEFAULT_SCHOOL_POLL = 180
const DEFAULT_TASK_HORIZON = 3
const MAX_DAY_START_HOUR = 8

function settingsPath(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'settings.json')
}

function load(): StoredSettings {
  const path = settingsPath()
  const defaults: StoredSettings = {
    llmProvider: 'openai',
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    apiKeyEnc: null,
    bedrock: { region: DEFAULT_BEDROCK_REGION, model: DEFAULT_BEDROCK_MODEL, credentialsEnc: null, accessKeyHint: '' },
    autoRescanMinutes: 0,
    notificationsEnabled: true,
    dayStartHour: 4,
    profileDir: '',
    jobsScanMinutes: 5,
    jobsInBadge: false,
    school: { feedUrlEnc: null, feedHost: '', pollMinutes: DEFAULT_SCHOOL_POLL, taskHorizonDays: DEFAULT_TASK_HORIZON }
  }
  if (!existsSync(path)) return defaults
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredSettings>
    const b: Partial<StoredSettings['bedrock']> = raw.bedrock && typeof raw.bedrock === 'object' ? raw.bedrock : {}
    const sc: Partial<StoredSettings['school']> = raw.school && typeof raw.school === 'object' ? raw.school : {}
    return {
      llmProvider: raw.llmProvider === 'bedrock' ? 'bedrock' : 'openai',
      baseUrl: raw.baseUrl || DEFAULT_BASE_URL,
      model: raw.model || DEFAULT_MODEL,
      apiKeyEnc: raw.apiKeyEnc ?? null,
      bedrock: {
        region: typeof b.region === 'string' && validRegion(b.region) ? b.region : DEFAULT_BEDROCK_REGION,
        model: typeof b.model === 'string' && b.model ? b.model : DEFAULT_BEDROCK_MODEL,
        credentialsEnc: typeof b.credentialsEnc === 'string' ? b.credentialsEnc : null,
        accessKeyHint: typeof b.accessKeyHint === 'string' ? b.accessKeyHint.slice(-4) : ''
      },
      autoRescanMinutes: RESCAN_CHOICES.includes(raw.autoRescanMinutes ?? -1)
        ? (raw.autoRescanMinutes as number)
        : 0,
      notificationsEnabled: raw.notificationsEnabled !== false,
      dayStartHour: validDayStartHour(raw.dayStartHour) ? raw.dayStartHour : 4,
      profileDir: typeof raw.profileDir === 'string' ? raw.profileDir : '',
      jobsScanMinutes: JOBS_SCAN_CHOICES.includes(raw.jobsScanMinutes ?? -1)
        ? (raw.jobsScanMinutes as number)
        : 5,
      jobsInBadge: raw.jobsInBadge === true,
      school: {
        feedUrlEnc: typeof sc.feedUrlEnc === 'string' ? sc.feedUrlEnc : null,
        feedHost: typeof sc.feedHost === 'string' ? sc.feedHost.slice(0, 100) : '',
        pollMinutes: SCHOOL_POLL_CHOICES.includes(sc.pollMinutes ?? -1) ? (sc.pollMinutes as number) : DEFAULT_SCHOOL_POLL,
        taskHorizonDays: TASK_HORIZON_CHOICES.includes(sc.taskHorizonDays ?? -1)
          ? (sc.taskHorizonDays as number)
          : DEFAULT_TASK_HORIZON
      }
    }
  } catch {
    return defaults
  }
}

function validDayStartHour(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_DAY_START_HOUR
}

function save(settings: StoredSettings): void {
  // Atomic write: never corrupt settings (and the encrypted keys) mid-write. Owner-only mode so
  // the ciphertext isn't readable by other local accounts either.
  const path = settingsPath()
  writeFileSync(path + '.tmp', JSON.stringify(settings, null, 2), { mode: 0o600 })
  renameSync(path + '.tmp', path)
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best effort */
  }
}

export function getSettingsView(): SettingsView {
  const s = load()
  // Decrypt, don't just check that ciphertext exists: a key copied from another Mac (or a
  // keychain that refuses) leaves apiKeyEnc set while getApiKey() returns null, and Settings
  // used to show "set ✓" next to "No API key set" on the model list.
  const apiKeyOk = Boolean(getApiKey())
  const awsOk = Boolean(getBedrockCredentials())
  const feedOk = Boolean(getSchoolFeedUrl())
  return {
    llmProvider: s.llmProvider,
    baseUrl: s.baseUrl,
    model: s.model,
    hasApiKey: apiKeyOk,
    bedrock: {
      region: s.bedrock.region,
      model: s.bedrock.model,
      hasCredentials: awsOk,
      accessKeyHint: awsOk ? s.bedrock.accessKeyHint : ''
    },
    autoRescanMinutes: s.autoRescanMinutes,
    notificationsEnabled: s.notificationsEnabled,
    dayStartHour: s.dayStartHour,
    profileDir: s.profileDir,
    jobsScanMinutes: s.jobsScanMinutes,
    jobsInBadge: s.jobsInBadge,
    school: {
      hasFeed: feedOk,
      feedHost: feedOk ? s.school.feedHost : '',
      pollMinutes: s.school.pollMinutes,
      taskHorizonDays: s.school.taskHorizonDays
    }
  }
}

export function getAutoRescanMinutes(): number {
  return load().autoRescanMinutes
}

export function getNotificationsEnabled(): boolean {
  return load().notificationsEnabled
}

export function getDayStartHour(): number {
  return load().dayStartHour
}

export function getProfileDir(): string {
  return load().profileDir
}

export function getJobsScanMinutes(): number {
  return load().jobsScanMinutes
}

export function getJobsInBadge(): boolean {
  return load().jobsInBadge
}

export function getSchoolConfig(): { pollMinutes: number; taskHorizonDays: number; feedConfigured: boolean; feedHost: string } {
  const s = load().school
  return { pollMinutes: s.pollMinutes, taskHorizonDays: s.taskHorizonDays, feedConfigured: Boolean(s.feedUrlEnc), feedHost: s.feedHost }
}

/** Decrypts the Canvas feed URL for one fetch. Callers must not cache or log it. */
export function getSchoolFeedUrl(): string | null {
  const enc = load().school.feedUrlEnc
  if (!enc) return null
  try {
    const url = safeStorage.decryptString(Buffer.from(enc, 'base64'))
    return validFeedUrl(url) ? url : null
  } catch {
    return null
  }
}

/**
 * A Canvas calendar feed: https, a real hostname (not an IP or localhost), and an `.ics` path.
 * The host is deliberately not pinned to instructure.com — schools run Canvas on their own
 * domains (canvas.uw.edu) — but the shape is, so a pasted login link or arbitrary URL is refused.
 */
export function validFeedUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.local')) return false
  return /\/feeds\/calendars\/[^/]+\.ics$/.test(u.pathname) && raw.length <= 400
}

/** AWS access key IDs are 16–128 chars of A–Z/0–9; secrets are 40 chars of base64-ish text. */
const ACCESS_KEY_RE = /^[A-Z0-9]{16,128}$/
const SECRET_KEY_RE = /^[A-Za-z0-9/+=]{40}$/

export function saveSettings(update: SettingsUpdate): SettingsView {
  const s = load()
  if (update.llmProvider === 'openai' || update.llmProvider === 'bedrock') s.llmProvider = update.llmProvider
  if (update.baseUrl !== undefined) s.baseUrl = update.baseUrl.trim() || DEFAULT_BASE_URL
  if (update.model !== undefined) s.model = update.model.trim() || DEFAULT_MODEL
  if (update.autoRescanMinutes !== undefined && RESCAN_CHOICES.includes(update.autoRescanMinutes)) {
    s.autoRescanMinutes = update.autoRescanMinutes
  }
  if (update.notificationsEnabled !== undefined) {
    s.notificationsEnabled = Boolean(update.notificationsEnabled)
  }
  if (validDayStartHour(update.dayStartHour)) s.dayStartHour = update.dayStartHour
  if (typeof update.profileDir === 'string') s.profileDir = sanitizeProfileDir(update.profileDir)
  if (update.jobsScanMinutes !== undefined && JOBS_SCAN_CHOICES.includes(update.jobsScanMinutes)) {
    s.jobsScanMinutes = update.jobsScanMinutes
  }
  if (update.jobsInBadge !== undefined) s.jobsInBadge = Boolean(update.jobsInBadge)
  if (update.apiKey !== undefined) {
    const key = update.apiKey.trim()
    if (!key) {
      s.apiKeyEnc = null
    } else if (safeStorage.isEncryptionAvailable()) {
      s.apiKeyEnc = safeStorage.encryptString(key).toString('base64')
    } else {
      // Same policy as the AWS pair: no keychain, no save. (Older files may still hold a "plain:"
      // value from before this rule; getApiKey keeps reading those.)
      throw new Error('This Mac cannot encrypt secrets right now (keychain unavailable), so the key was not saved.')
    }
  }
  if (update.bedrock && typeof update.bedrock === 'object') {
    const b = update.bedrock
    if (typeof b.region === 'string') {
      const region = b.region.trim()
      if (!region) s.bedrock.region = DEFAULT_BEDROCK_REGION
      else if (validRegion(region)) s.bedrock.region = region
      else throw new Error('Region must look like us-east-1.')
    }
    if (typeof b.model === 'string') s.bedrock.model = b.model.trim().slice(0, 200) || DEFAULT_BEDROCK_MODEL
    if (b.accessKeyId !== undefined || b.secretAccessKey !== undefined) {
      const id = String(b.accessKeyId ?? '').trim()
      const secret = String(b.secretAccessKey ?? '').trim()
      if (!id && !secret) {
        s.bedrock.credentialsEnc = null
        s.bedrock.accessKeyHint = ''
      } else {
        if (!ACCESS_KEY_RE.test(id)) throw new Error('That does not look like an AWS access key ID.')
        if (!SECRET_KEY_RE.test(secret)) throw new Error('That does not look like an AWS secret access key (40 characters).')
        // Fail closed: an AWS key pair is never written to disk unencrypted.
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('This Mac cannot encrypt secrets right now (keychain unavailable), so the key was not saved.')
        }
        s.bedrock.credentialsEnc = safeStorage.encryptString(`${id}\n${secret}`).toString('base64')
        s.bedrock.accessKeyHint = id.slice(-4)
      }
    }
  }
  if (update.school && typeof update.school === 'object') {
    const sc = update.school
    if (sc.pollMinutes !== undefined && SCHOOL_POLL_CHOICES.includes(sc.pollMinutes)) s.school.pollMinutes = sc.pollMinutes
    if (sc.taskHorizonDays !== undefined && TASK_HORIZON_CHOICES.includes(sc.taskHorizonDays)) {
      s.school.taskHorizonDays = sc.taskHorizonDays
    }
    if (sc.feedUrl !== undefined) {
      const url = String(sc.feedUrl).trim()
      if (!url) {
        s.school.feedUrlEnc = null
        s.school.feedHost = ''
      } else {
        if (!validFeedUrl(url)) {
          throw new Error('That does not look like a Canvas calendar feed (Calendar → Calendar Feed → copy the .ics link).')
        }
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('This Mac cannot encrypt secrets right now (keychain unavailable), so the feed was not saved.')
        }
        s.school.feedUrlEnc = safeStorage.encryptString(url).toString('base64')
        s.school.feedHost = new URL(url).hostname.toLowerCase()
      }
    }
  }
  save(s)
  return getSettingsView()
}

/**
 * Decrypts the AWS pair for one call. Callers must not cache the result. Null when none is set
 * or the keychain refuses (e.g. settings copied from another Mac).
 */
export function getBedrockCredentials(): { accessKeyId: string; secretAccessKey: string } | null {
  const enc = load().bedrock.credentialsEnc
  if (!enc) return null
  try {
    const text = safeStorage.decryptString(Buffer.from(enc, 'base64'))
    const nl = text.indexOf('\n')
    if (nl <= 0) return null
    return { accessKeyId: text.slice(0, nl), secretAccessKey: text.slice(nl + 1) }
  } catch {
    return null
  }
}

export function getBedrockConfig(): { region: string; model: string } {
  const b = load().bedrock
  return { region: b.region, model: b.model }
}

export function getApiKey(): string | null {
  if (process.env.BRIEFLY_API_KEY) return process.env.BRIEFLY_API_KEY
  const s = load()
  if (!s.apiKeyEnc) return null
  try {
    if (s.apiKeyEnc.startsWith('plain:')) {
      return Buffer.from(s.apiKeyEnc.slice(6), 'base64').toString('utf8')
    }
    return safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64'))
  } catch {
    return null
  }
}

export function getLlmProvider(): LlmProvider {
  return load().llmProvider
}

export function getLlmConfig(): { baseUrl: string; model: string; apiKey: string | null } {
  const s = load()
  return { baseUrl: s.baseUrl, model: s.model, apiKey: getApiKey() }
}

/** True when the active provider has what it needs to make a call. */
export function llmConfigured(): boolean {
  const s = load()
  if (s.llmProvider === 'bedrock') return Boolean(s.bedrock.credentialsEnc)
  return Boolean(getApiKey())
}
