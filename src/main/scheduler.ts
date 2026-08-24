import type { BrowserWindow } from 'electron'
import { powerMonitor } from 'electron'
import { refresh } from './agent'
import { getApiKey, getAutoRescanMinutes } from './settings'
import { getLastRefreshed } from './taskStore'
import { updateTrayCount } from './tray'
import { notifyDueTasks } from './notifications'

let getWindow: () => BrowserWindow | null = () => null
let timer: NodeJS.Timeout | null = null
let catchUp: NodeJS.Timeout | null = null

export function initScheduler(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  // Interval timers don't tick during sleep — catch up on wake if the board is stale.
  powerMonitor.on('resume', () => {
    if (isStale()) setTimeout(() => void autoRescan(), 15_000)
  })
}

function isStale(): boolean {
  const minutes = getAutoRescanMinutes()
  if (!minutes) return false
  const last = getLastRefreshed()
  return !last || Date.now() - new Date(last).getTime() > minutes * 60_000
}

/** (Re)arm the auto-rescan interval from settings. Call on launch and after settings save. */
export function scheduleAutoRescan(): void {
  if (timer) clearInterval(timer)
  if (catchUp) clearTimeout(catchUp)
  timer = catchUp = null

  const minutes = getAutoRescanMinutes()
  if (!minutes) return

  timer = setInterval(() => void autoRescan(), minutes * 60_000)
  // One catch-up scan shortly after arming if the board is already stale.
  catchUp = setTimeout(() => {
    if (isStale()) void autoRescan()
  }, 20_000)
}

async function autoRescan(): Promise<void> {
  if (!getApiKey()) return
  const win = getWindow()
  // Never yank state out from under the user mid-edit; they can refresh manually.
  if (win && !win.isDestroyed() && win.isVisible()) return
  const result = await refresh()
  if (result.ok && result.state) {
    updateTrayCount()
    notifyDueTasks()
    if (win && !win.isDestroyed()) win.webContents.send('state:changed', result.state)
  }
}
