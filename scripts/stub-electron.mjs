// DEV ONLY. Stand-in for the `electron` module so main-process code (profile reader, settings) can be
// bundled into a plain Node script. Points userData at the real folder read-only; nothing is encrypted.
import { homedir } from 'node:os'
import { join } from 'node:path'

export const app = { getPath: () => process.env.BRIEFLY_USERDATA ?? join(homedir(), 'Library/Application Support/briefly'), getName: () => 'briefly', on() {} }
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' }
export const clipboard = { writeText() {} }
export class Notification {
  static isSupported() {
    return false
  }
  on() {}
  show() {}
}
export const shell = { openExternal: async () => undefined }
export const powerMonitor = { on() {} }
export const ipcMain = { handle() {}, on() {} }
export class BrowserWindow {}
