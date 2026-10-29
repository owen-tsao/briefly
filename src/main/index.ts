import { app, BrowserWindow, Tray, globalShortcut, nativeImage, screen, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { setTray, updateTrayCount } from './tray'
import { initScheduler, scheduleAutoRescan } from './scheduler'
import { initNotifications } from './notifications'
import { initJobsScheduler } from './jobs/pipeline'
import { initSchoolScheduler } from './school/school'
import { closeBrowser } from './browser/session'
import { installFileLog } from './log'

const WINDOW_WIDTH = 400
const WINDOW_HEIGHT = 580

/**
 * Stage mode, for screen recordings: BRIEFLY_STAGE=1 keeps the popover open when it loses focus
 * (a recorder stealing focus would otherwise close it) and centers it on the primary display.
 * BRIEFLY_USER_DATA points at a separate data folder so a curated copy can be shown without
 * touching real data; BRIEFLY_THEME=light|dark forces the theme on load.
 */
const STAGE = process.env.BRIEFLY_STAGE === '1'
if (process.env.BRIEFLY_USER_DATA) app.setPath('userData', process.env.BRIEFLY_USER_DATA)

let tray: Tray | null = null
let window: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    movable: false,
    skipTaskbar: true,
    transparent: false,
    backgroundColor: '#16161d',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  win.on('blur', () => {
    if (!STAGE && !win.webContents.isDevToolsOpened()) win.hide()
  })
  // BRIEFLY_TAB=1..6 opens that tab on load (same as ⌘1–⌘6), so a take can start on Jobs or School.
  if (STAGE && /^[1-6]$/.test(process.env.BRIEFLY_TAB ?? '')) {
    const key = process.env.BRIEFLY_TAB as string
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['meta'] })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['meta'] })
      }, 800)
    })
  }
  // On stage, the popover sits above everything so the recorder and other windows can't cover it.
  if (STAGE) win.setAlwaysOnTop(true, 'floating')
  if (process.env.BRIEFLY_THEME === 'light' || process.env.BRIEFLY_THEME === 'dark') {
    const theme = process.env.BRIEFLY_THEME
    win.webContents.on('did-finish-load', () => {
      void win.webContents.executeJavaScript(
        `if (localStorage.getItem('briefly-theme') !== '${theme}') { localStorage.setItem('briefly-theme', '${theme}'); location.reload() }`
      )
    })
  }

  // The renderer only ever shows local UI: open links externally, never navigate in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function positionWindow(win: BrowserWindow): void {
  if (STAGE) {
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea
    win.setPosition(Math.round(x + (width - WINDOW_WIDTH) / 2), Math.round(y + (height - WINDOW_HEIGHT) / 2), false)
    return
  }
  if (!tray) return
  const trayBounds = tray.getBounds()
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - WINDOW_WIDTH / 2)
  const y = Math.round(trayBounds.y + trayBounds.height + 4)
  // Keep the popover on screen.
  const maxX = display.workArea.x + display.workArea.width - WINDOW_WIDTH - 8
  x = Math.min(Math.max(x, display.workArea.x + 8), maxX)
  win.setPosition(x, y, false)
}

function toggleWindow(): void {
  if (!window || window.isDestroyed()) window = createWindow()
  if (window.isVisible()) {
    window.hide()
  } else {
    positionWindow(window)
    window.show()
    window.focus()
  }
}

function trayIcon(): Electron.NativeImage {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const image = nativeImage.createFromPath(join(base, 'resources', 'trayTemplate.png'))
  image.setTemplateImage(true)
  return image
}

app.whenReady().then(() => {
  installFileLog()
  // Menu bar app: no dock icon.
  app.dock?.hide()

  registerIpc()

  tray = new Tray(trayIcon())
  tray.setToolTip('briefly — your notes, organized')
  tray.on('click', toggleWindow)
  setTray(tray)
  updateTrayCount()

  // ⌥B toggles the popover from anywhere. Non-fatal if another app owns it.
  if (!globalShortcut.register('Alt+B', toggleWindow)) {
    console.warn('briefly: could not register Alt+B global shortcut')
  }

  window = createWindow()
  initScheduler(() => window)
  scheduleAutoRescan()
  const openPopover = (): void => {
    if (!window || window.isDestroyed()) window = createWindow()
    if (!window.isVisible()) {
      positionWindow(window)
      window.show()
      window.focus()
    }
  }
  initNotifications(openPopover)
  initJobsScheduler(() => window, openPopover)
  initSchoolScheduler(() => window, openPopover)

  // Open the popover once on launch so the app is easy to locate.
  window.webContents.once('did-finish-load', () => {
    if (window && !window.isVisible()) {
      positionWindow(window)
      window.show()
      window.focus()
    }
  })
})

// Menu bar apps keep running with no windows open.
app.on('window-all-closed', () => {})

app.on('will-quit', () => globalShortcut.unregisterAll())

// Playwright kills its Chromium when we exit anyway; closing it first flushes the profile cleanly.
app.on('before-quit', () => void closeBrowser())
