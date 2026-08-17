import { app, BrowserWindow, Tray, nativeImage, screen, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'

const WINDOW_WIDTH = 400
const WINDOW_HEIGHT = 580

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
    if (!win.webContents.isDevToolsOpened()) win.hide()
  })

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
  // Menu bar app: no dock icon.
  app.dock?.hide()

  registerIpc()

  tray = new Tray(trayIcon())
  tray.setTitle(' briefly')
  tray.setToolTip('briefly — your notes, organized')
  tray.on('click', toggleWindow)

  window = createWindow()

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
