import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Mirror console output to ~/Library/Logs/briefly/main.log so a packaged build is diagnosable:
 * `open` sends stdout nowhere. One file, rotated once at 2 MB; never contains form values —
 * callers already log counts and labels only.
 */
export function installFileLog(): void {
  let dir: string
  try {
    dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
  } catch {
    return
  }
  const file = join(dir, 'main.log')
  try {
    if (statSync(file).size > 2 * 1024 * 1024) renameSync(file, `${file}.1`)
  } catch {
    /* no file yet */
  }
  const write = (level: string, args: unknown[]): void => {
    const line = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a))).join(' ')
    try {
      appendFileSync(file, `${new Date().toISOString()} ${level} ${line}\n`)
    } catch {
      /* disk full or unwritable; stdout still has it */
    }
  }
  for (const level of ['log', 'warn', 'error'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      orig(...args)
      write(level.toUpperCase(), args)
    }
  }
}
