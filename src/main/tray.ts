import { Tray } from 'electron'
import { getOpenCount } from './taskStore'

let tray: Tray | null = null

export function setTray(instance: Tray): void {
  tray = instance
}

/** Show the open-task count next to the menu bar icon (nothing when clear). */
export function updateTrayCount(): void {
  if (!tray) return
  const count = getOpenCount()
  tray.setTitle(count > 0 ? ` ${count}` : '')
}
