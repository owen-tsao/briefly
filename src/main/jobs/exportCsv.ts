import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import type { JobRow } from '../../shared/jobs'
import { JOB_STATUS_LABELS, TRACKED_STATUSES } from '../../shared/jobs'
import { localDay } from '../../shared/dates'

const COLUMNS = ['Company', 'Role', 'Status', 'Applied', 'Last updated', 'Location', 'Term', 'Source', 'URL', 'Note']

/** Quote for CSV and neutralise spreadsheet formula injection (a note starting with `=` would execute in Excel). */
function cell(v: string | null | undefined): string {
  let s = (v ?? '').replace(/\r?\n/g, ' ').trim()
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function day(iso: string | null | undefined): string {
  return iso ? localDay(iso) : ''
}

export function trackedRows(rows: JobRow[]): JobRow[] {
  return rows
    .filter((r) => r.state && TRACKED_STATUSES.includes(r.state.status))
    .sort((a, b) => {
      const ka = a.state?.appliedAt ?? a.state?.updatedAt ?? ''
      const kb = b.state?.appliedAt ?? b.state?.updatedAt ?? ''
      return kb.localeCompare(ka)
    })
}

/** Pure so it can be checked without Electron. One line per tracked posting, newest first. */
export function buildTrackerCsv(rows: JobRow[]): string {
  const lines = [COLUMNS.join(',')]
  for (const r of trackedRows(rows)) {
    const st = r.state!
    const snap = st.snapshot
    lines.push(
      [
        r.item?.company ?? snap.company,
        r.item?.title ?? snap.title,
        JOB_STATUS_LABELS[st.status],
        day(st.appliedAt),
        day(st.updatedAt),
        r.item?.location ?? '',
        r.item?.term ?? snap.term,
        r.item?.source ?? snap.source,
        r.item?.url ?? snap.url,
        st.note
      ]
        .map(cell)
        .join(',')
    )
  }
  return lines.join('\n') + '\n'
}

/** Writes to ~/Downloads and reveals it. No save dialog: the popover hides on blur, which would swallow one. */
export function exportTrackerCsv(rows: JobRow[]): string {
  const path = join(homedir(), 'Downloads', `briefly-applications-${localDay()}.csv`)
  writeFileSync(path, buildTrackerCsv(rows), 'utf8')
  shell.showItemInFolder(path)
  return path
}
