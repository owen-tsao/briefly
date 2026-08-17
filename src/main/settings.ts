import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, type SettingsView } from '../shared/types'

interface StoredSettings {
  baseUrl: string
  model: string
  /** base64 of safeStorage-encrypted key, or plain key prefixed "plain:" if encryption unavailable */
  apiKeyEnc: string | null
}

function settingsPath(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'settings.json')
}

function load(): StoredSettings {
  const path = settingsPath()
  if (!existsSync(path)) {
    return { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL, apiKeyEnc: null }
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredSettings>
    return {
      baseUrl: raw.baseUrl || DEFAULT_BASE_URL,
      model: raw.model || DEFAULT_MODEL,
      apiKeyEnc: raw.apiKeyEnc ?? null
    }
  } catch {
    return { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL, apiKeyEnc: null }
  }
}

function save(settings: StoredSettings): void {
  // Atomic write: never corrupt settings (and the encrypted key) mid-write.
  const path = settingsPath()
  writeFileSync(path + '.tmp', JSON.stringify(settings, null, 2))
  renameSync(path + '.tmp', path)
}

export function getSettingsView(): SettingsView {
  const s = load()
  return { baseUrl: s.baseUrl, model: s.model, hasApiKey: Boolean(s.apiKeyEnc) || Boolean(process.env.BRIEFLY_API_KEY) }
}

export function saveSettings(update: { baseUrl?: string; model?: string; apiKey?: string }): SettingsView {
  const s = load()
  if (update.baseUrl !== undefined) s.baseUrl = update.baseUrl.trim() || DEFAULT_BASE_URL
  if (update.model !== undefined) s.model = update.model.trim() || DEFAULT_MODEL
  if (update.apiKey !== undefined) {
    const key = update.apiKey.trim()
    if (!key) {
      s.apiKeyEnc = null
    } else if (safeStorage.isEncryptionAvailable()) {
      s.apiKeyEnc = safeStorage.encryptString(key).toString('base64')
    } else {
      s.apiKeyEnc = 'plain:' + Buffer.from(key, 'utf8').toString('base64')
    }
  }
  save(s)
  return getSettingsView()
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

export function getLlmConfig(): { baseUrl: string; model: string; apiKey: string | null } {
  const s = load()
  return { baseUrl: s.baseUrl, model: s.model, apiKey: getApiKey() }
}
