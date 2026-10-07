import { dialog, ipcMain, shell } from 'electron'
import type { LmsKind, QuickAddInput, RuleInput, SchoolView, SyllabusParseResult, SyllabusSuggestion } from '../../shared/school'
import { addDays, localDay } from '../../shared/dates'
import { getLlmProvider } from '../settings'
import {
  addItem,
  deleteItem,
  deleteRule,
  getView,
  hasSimilarItem,
  hasSimilarRule,
  onFeedChanged,
  pollFeed,
  saveRule,
  setCourse,
  setDone,
  setHidden,
  syncTasks
} from './school'
import { parseSyllabus } from './syllabus'
import { connectLms, disconnectLms, resolveAnnouncementSuggestion, syncLms } from './lms'

const LMS_KINDS: LmsKind[] = ['gradescope', 'canvas']

type Result<T = Record<string, never>> = ({ ok: true } & T & { view: SchoolView }) | { ok: false; error: string; view: SchoolView }

function ok<T>(extra: T): Result<T> {
  return { ok: true, ...extra, view: getView() }
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err), view: getView() }
}

export function registerSchoolIpc(): void {
  // Opening the tab reconciles with Tasks first, so a task you ticked off there shows done here.
  ipcMain.handle('school:get', () => {
    syncTasks()
    return getView()
  })

  ipcMain.handle('school:pollNow', async () => {
    const r = await pollFeed(true)
    return r.ok ? ok({ added: r.added }) : fail(new Error(r.error ?? 'Poll failed.'))
  })

  /** Settings saved a new feed: fetch right away so the tab isn't empty until the next tick. */
  ipcMain.handle('school:feedChanged', async () => {
    await onFeedChanged()
    return getView()
  })

  ipcMain.handle('school:addItem', (_e, input: QuickAddInput) => {
    if (!input || typeof input !== 'object') return fail(new Error('Bad input.'))
    try {
      const item = addItem(input)
      return ok({ id: item.id })
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('school:setDone', (_e, id: string, done: boolean) => {
    if (typeof id === 'string') setDone(id, Boolean(done))
    return getView()
  })

  ipcMain.handle('school:setHidden', (_e, id: string, hidden: boolean) => {
    if (typeof id === 'string') setHidden(id, Boolean(hidden))
    return getView()
  })

  ipcMain.handle('school:deleteItem', (_e, id: string) => {
    if (typeof id === 'string') deleteItem(id)
    return getView()
  })

  ipcMain.handle('school:saveRule', (_e, input: RuleInput) => {
    if (!input || typeof input !== 'object') return fail(new Error('Bad input.'))
    try {
      const rule = saveRule(input)
      return ok({ id: rule.id })
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('school:deleteRule', (_e, id: string) => {
    if (typeof id === 'string') deleteRule(id)
    return getView()
  })

  ipcMain.handle('school:setCourse', (_e, course: string, patch: { name?: string; hidden?: boolean; hideEvents?: boolean }) => {
    if (typeof course === 'string' && patch && typeof patch === 'object') setCourse(course, patch)
    return getView()
  })

  ipcMain.handle('school:openUrl', (_e, url: string) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url)) void shell.openExternal(url)
  })

  /**
   * Syllabus: pick a file through the OS dialog (the renderer never sees a filesystem path it
   * didn't choose) or pass pasted text; returns proposals only. Nothing is stored here.
   */
  ipcMain.handle('school:parseSyllabus', async (_e, input: { useDialog?: boolean; text?: string; courseHint?: string }): Promise<SyllabusParseResult> => {
    if (!input || typeof input !== 'object') return { ok: false, error: 'Bad input.' }
    let path: string | undefined
    if (input.useDialog) {
      const pdfOk = getLlmProvider() === 'bedrock'
      const r = await dialog.showOpenDialog({
        title: 'Choose a syllabus',
        properties: ['openFile'],
        filters: [{ name: 'Syllabus', extensions: pdfOk ? ['pdf', 'txt', 'md', 'html', 'htm'] : ['txt', 'md', 'html', 'htm'] }]
      })
      if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' }
      path = r.filePaths[0]
    }
    return parseSyllabus({
      path,
      text: typeof input.text === 'string' ? input.text.slice(0, 200_000) : undefined,
      courseHint: typeof input.courseHint === 'string' ? input.courseHint.slice(0, 40) : undefined
    })
  })

  /** Store the suggestions you kept. Rules get the term bounds the parser found, or a 15-week default. */
  ipcMain.handle(
    'school:acceptSuggestions',
    (_e, input: { suggestions: SyllabusSuggestion[]; termStart?: string; termEnd?: string }) => {
      if (!input || !Array.isArray(input.suggestions)) return fail(new Error('Bad input.'))
      const start = typeof input.termStart === 'string' && input.termStart ? input.termStart : localDay()
      const end = typeof input.termEnd === 'string' && input.termEnd ? input.termEnd : addDays(start, 105)
      const errors: string[] = []
      let added = 0
      let skipped = 0
      for (const s of input.suggestions.slice(0, 200)) {
        try {
          if (s.type === 'item' && s.due) {
            // Canvas or an earlier import may already carry this one; don't show it twice.
            if (hasSimilarItem(s.course, s.due, s.title)) {
              skipped++
              continue
            }
            addItem({ course: s.course, title: s.title, due: s.due, time: s.time ?? null, kind: s.kind }, 'syllabus')
          } else if (s.type === 'rule' && s.weekday !== undefined) {
            if (hasSimilarRule(s.course, s.weekday, s.title)) {
              skipped++
              continue
            }
            saveRule({ course: s.course, title: s.title, kind: s.kind, weekday: s.weekday, time: s.time ?? '23:59', startDate: start, endDate: end })
          } else {
            continue
          }
          added++
        } catch (err) {
          errors.push(`${s.title}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return ok({ added, skipped, errors })
    }
  )

  /** Opens the LMS sign-in in briefly's browser and waits for you; resolves once the first sync has run. */
  ipcMain.handle('school:connectLms', async (_e, kind: LmsKind) => {
    if (!LMS_KINDS.includes(kind)) return fail(new Error('Unknown LMS.'))
    const r = await connectLms(kind)
    return r.ok ? ok({ warning: r.error ?? null }) : fail(new Error(r.error ?? 'Could not connect.'))
  })

  ipcMain.handle('school:syncLms', async (_e, kind: LmsKind) => {
    if (!LMS_KINDS.includes(kind)) return fail(new Error('Unknown LMS.'))
    const r = await syncLms(kind, true)
    return r.ok ? ok({ added: r.added, updated: r.updated, suggested: r.suggested }) : fail(new Error(r.error ?? 'Sync failed.'))
  })

  ipcMain.handle('school:disconnectLms', (_e, kind: LmsKind) => {
    if (LMS_KINDS.includes(kind)) disconnectLms(kind)
    return getView()
  })

  /** Yes/no on a deadline the model read out of an announcement. Yes stores it as a Canvas item. */
  ipcMain.handle('school:resolveAnnouncement', (_e, id: string, accept: boolean) => {
    if (typeof id !== 'string') return fail(new Error('Bad input.'))
    const s = resolveAnnouncementSuggestion(id, Boolean(accept))
    if (!s) return ok({})
    try {
      addItem({ course: s.course, title: s.title, due: s.due ?? '', time: s.time ?? null, kind: s.kind, url: s.url }, 'canvas')
      return ok({})
    } catch (err) {
      return fail(err)
    }
  })
}
