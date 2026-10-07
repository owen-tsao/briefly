import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'

/**
 * One real, visible Chromium with a persistent profile at ~/.briefly/browser. Every browser-based
 * feature (prepared applications, jobright resolver, Gradescope sync) shares it, so a login you do
 * once (MyGreenhouse, Workday tenant, Gradescope) is remembered. Launched lazily, closed when the
 * user closes the window; never headless, because the point is that you can see and finish what
 * it started.
 */

let context: BrowserContext | null = null
let launching: Promise<BrowserContext> | null = null

export function browserProfileDir(): string {
  return join(homedir(), '.briefly', 'browser')
}

/** Playwright's own Chromium if downloaded, else the Google Chrome channel, else null. */
export function availableBrowser(): { kind: 'chromium' | 'chrome'; path: string } | null {
  try {
    const p = chromium.executablePath()
    if (p && existsSync(p)) return { kind: 'chromium', path: p }
  } catch {
    /* fall through */
  }
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (existsSync(chrome)) return { kind: 'chrome', path: chrome }
  return null
}

export class BrowserUnavailableError extends Error {
  constructor() {
    super('No browser found. Install Google Chrome, or run `npx playwright install chromium` in the briefly folder.')
    this.name = 'BrowserUnavailableError'
  }
}

export async function getContext(): Promise<BrowserContext> {
  if (context) return context
  if (launching) return launching
  launching = (async () => {
    const which = availableBrowser()
    if (!which) throw new BrowserUnavailableError()
    // The profile holds live sessions (Gradescope, Canvas, ATS accounts). Owner-only on disk, and
    // Chromium's cookie encryption must use the real keychain: Playwright's defaults add
    // --use-mock-keychain / --password-store=basic, which encrypt cookies with a fixed public key.
    mkdirSync(browserProfileDir(), { recursive: true, mode: 0o700 })
    try {
      chmodSync(browserProfileDir(), 0o700)
    } catch {
      /* best effort */
    }
    const ctx = await chromium.launchPersistentContext(browserProfileDir(), {
      headless: false,
      channel: which.kind === 'chrome' ? 'chrome' : undefined,
      viewport: null,
      // Keep the window recognisable and out of the way of bot heuristics that key on automation flags.
      ignoreDefaultArgs: ['--enable-automation', '--use-mock-keychain', '--password-store=basic'],
      args: ['--window-size=1180,920', '--disable-blink-features=AutomationControlled']
    })
    // The context fires `close` when the user quits the window; drop our handle so the next call relaunches.
    ctx.on('close', () => {
      if (context === ctx) context = null
    })
    context = ctx
    return ctx
  })()
  try {
    return await launching
  } finally {
    launching = null
  }
}

/** Open a URL in a fresh tab and bring it forward. Throws if no browser is available. */
export async function openPage(url: string): Promise<Page> {
  const page = await openBackgroundPage(url)
  await page.bringToFront().catch(() => undefined)
  return page
}

/**
 * A tab for background reads (jobright resolution, Gradescope). Same profile, no bringToFront.
 * A tab whose first navigation fails is closed before the error propagates, so a slow or blocked
 * site does not leave a blank tab behind in the visible window.
 */
export async function openBackgroundPage(url: string): Promise<Page> {
  const ctx = await getContext()
  const page = await ctx.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  } catch (err) {
    await page.close().catch(() => undefined)
    throw err
  }
  return page
}

export function browserIsOpen(): boolean {
  return context !== null
}

export async function closeBrowser(): Promise<void> {
  const ctx = context
  context = null
  if (ctx) await ctx.close().catch(() => undefined)
}
