import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { JobSource, JobStatus, JobTerm } from '../../shared/jobs'
import {
  MAX_EMAIL_BYTES,
  applyEmailImport,
  commitEmailResult,
  companiesMatch,
  emailTrackerId,
  matchRowsFrom,
  parseEmailUpdatesDocument,
  planEmailDocument,
  readEmailUpdates,
  recordTaskResults,
  rolesMatch,
  shouldTouchJobs,
  type EmailCommitStore,
  type EmailLedgerEntry,
  type MatchRow,
  type TaskSnap
} from './emailUpdates'

const NOW = new Date('2026-11-04T18:00:00Z')

function doc(entries: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, ...extra, entries })
}

function row(partial: Partial<MatchRow> & Pick<MatchRow, 'id' | 'company' | 'title'>): MatchRow {
  return {
    status: 'applied',
    updatedAt: '2026-08-01T12:00:00.000Z',
    manual: false,
    note: '',
    appliedAt: '2026-08-01T12:00:00',
    url: 'https://boards.example/job',
    term: 'summer-2027' as JobTerm,
    source: 'ats' as JobSource,
    location: 'Seattle, WA',
    hasState: true,
    ...partial
  }
}

function stateFor(r: MatchRow, extra: Record<string, unknown> = {}): EmailCommitStore['state'][string] {
  return {
    status: r.status,
    note: r.note,
    appliedAt: r.appliedAt,
    ...(r.manual ? { inherited: false as const } : {}),
    updatedAt: r.updatedAt,
    promotedTaskId: null,
    openedInAsideAt: null,
    snapshot: {
      company: r.company,
      title: r.title,
      url: r.url,
      term: r.term,
      source: r.source,
      location: r.location
    },
    ...extra
  }
}

describe('parse and validation', () => {
  it('keeps a good entry and skips a bad one', () => {
    const parsed = parseEmailUpdatesDocument(
      doc([
        { id: 'ok', company: 'Stripe', role: 'SWE Intern', status: 'Interviewing', eventAt: '2026-11-01', subject: 'Next steps' },
        { id: '', company: 'Nope', status: 'applied', eventAt: '2026-11-01' },
        { company: 'Also nope', status: 'applied', eventAt: '2026-11-01' },
        { id: 'bad-status', company: 'X', status: 'maybe', eventAt: '2026-11-01' }
      ])
    )
    assert.equal(parsed.ok, true)
    assert.equal(parsed.entries.length, 1)
    assert.equal(parsed.entries[0].status, 'interview')
    assert.equal(parsed.skipped.length, 3)
    assert.equal(shouldTouchJobs(parsed), true)
  })

  it('rejects a truncated file, a wrong version, and a missing entries array without throwing', () => {
    for (const text of ['{', '', '[]', 'null', '{"version":1}', '{"version":2,"entries":[]}', '{"entries":[]}']) {
      const parsed = parseEmailUpdatesDocument(text)
      assert.equal(parsed.ok, false, text)
      assert.equal(parsed.entries.length, 0)
      assert.equal(shouldTouchJobs(parsed), false)
      const plan = planEmailDocument(text, [], {}, [], NOW)
      assert.equal(plan.applied, false)
    }
  })

  it('rejects an oversized document before treating it as data', () => {
    const parsed = parseEmailUpdatesDocument(doc([]), MAX_EMAIL_BYTES + 1)
    assert.equal(parsed.ok, false)
    assert.match(parsed.error ?? '', /left the tracker untouched/)
  })

  it('collapses duplicate ids to the newest event', () => {
    const parsed = parseEmailUpdatesDocument(
      doc([
        { id: 'same', company: 'Notion', role: 'Intern', status: 'applied', eventAt: '2026-09-01' },
        { id: 'same', company: 'Notion', role: 'Intern', status: 'rejected', eventAt: '2026-10-02' }
      ])
    )
    assert.equal(parsed.duplicates, 1)
    assert.equal(parsed.entries.length, 1)
    assert.equal(parsed.entries[0].status, 'rejected')
  })

  it('drops a deadline with no timezone and still keeps the status', () => {
    const parsed = parseEmailUpdatesDocument(
      doc([
        {
          id: 'tz',
          company: 'Ramp',
          role: 'Software Engineer Intern',
          status: 'oa',
          eventAt: '2026-11-01',
          deadline: { at: '2026-11-12T21:00:00', platform: 'CodeSignal' }
        }
      ])
    )
    assert.equal(parsed.ok, true)
    assert.equal(parsed.entries.length, 1)
    assert.equal(parsed.entries[0].deadline, undefined)
    assert.ok(parsed.warnings.some((w) => w.includes('deadline')))
  })

  it('accepts a date-only deadline and a zoned instant', () => {
    const parsed = parseEmailUpdatesDocument(
      doc([
        {
          id: 'when',
          company: 'Susquehanna',
          role: 'Trading Intern',
          status: 'OA',
          eventAt: '2026-10-04',
          deadline: { at: '2026-12-03T14:58:00-08:00', platform: 'CodeSignal', display: 'Dec 3, 2:58 PM PT' }
        }
      ])
    )
    const deadline = parsed.entries[0].deadline
    assert.ok(deadline)
    assert.equal(deadline.dateOnly, false)
    assert.equal(deadline.dueAt, '2026-12-03T22:58:00.000Z')
    assert.equal(deadline.day, '2026-12-03')
    assert.equal(deadline.display, 'Dec 3, 2:58 PM PT')
  })

  it('does not read jobs.json when the file on disk is truncated or missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'briefly-email-'))
    try {
      const missing = readEmailUpdates(join(dir, 'nope.json'))
      assert.equal(missing.missing, true)
      assert.equal(shouldTouchJobs(missing), false)
      const torn = join(dir, 'email-updates.json')
      writeFileSync(torn, '{"version":1,"entries":[{"id":"a"')
      const parsed = readEmailUpdates(torn)
      assert.equal(parsed.ok, false)
      assert.equal(shouldTouchJobs(parsed), false)
      assert.equal(parsed.entries.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('matching', () => {
  it('normalizes company and role wording', () => {
    assert.equal(companiesMatch('Bain & Company', 'Bain'), true)
    assert.equal(companiesMatch('J.P. Morgan', 'JPMorgan Chase'), true)
    assert.equal(companiesMatch('Stripe, Inc.', 'Stripe'), true)
    assert.equal(companiesMatch('Atlassian', 'Atlasian'), true)
    assert.equal(companiesMatch('Meta', 'Metallic'), false)
    assert.equal(companiesMatch('Amazon', 'Amazon Web Services'), false)
    assert.equal(rolesMatch('SWE Intern', 'Software Engineer Intern'), true)
    assert.equal(rolesMatch('R171519 2027 Intern - Machine Learning Engineer', 'Intern - Machine Learning Engineer'), true)
    assert.equal(rolesMatch('Software Engineering Intern (Summer 2027)', 'Software Engineer Intern'), true)
    assert.equal(rolesMatch('SE Interns 2026-2027', 'Software Engineer Intern'), true)
    assert.equal(rolesMatch('Software Development Engineer Intern', 'Software Engineer Intern'), true)
    assert.equal(rolesMatch('Software Engineer Intern', 'Software Engineer Intern, Infrastructure'), false)
    assert.equal(rolesMatch('Software Development Engineer Intern', 'Security Engineer Internship'), false)
  })

  it('updates the existing row instead of creating a second one', () => {
    const existing = row({ id: 'feed-1', company: 'Adobe', title: '2027 Intern - Machine Learning Engineer' })
    const plan = planEmailDocument(
      doc([
        {
          id: 'adobe-ml',
          company: 'Adobe',
          role: 'R171519 2027 Intern - Machine Learning Engineer',
          status: 'rejected',
          eventAt: '2026-10-20'
        }
      ]),
      [existing],
      {},
      [],
      NOW
    )
    assert.equal(plan.applied, true)
    if (!plan.applied) return
    assert.equal(plan.outcome.created, 0)
    assert.equal(plan.outcome.patches.length, 1)
    assert.equal(plan.outcome.patches[0].id, 'feed-1')
    assert.equal(plan.outcome.patches[0].status, 'rejected')
  })

  it('does not merge two different roles at the same company', () => {
    const plan = planEmailDocument(
      doc([
        { id: 'amz-sde', company: 'Amazon', role: 'Software Development Engineer Intern', status: 'rejected', eventAt: '2026-10-07' },
        { id: 'amz-sec', company: 'Amazon', role: 'Security Engineer Internship', status: 'applied', eventAt: '2026-09-23' }
      ]),
      [],
      {},
      [],
      NOW
    )
    assert.equal(plan.applied, true)
    if (!plan.applied) return
    assert.equal(plan.outcome.created, 2)
    assert.equal(plan.outcome.patches[0].id === plan.outcome.patches[1].id, false)
  })

  it('picks the closer PayPal title when two listings share a role, and creates when none do', () => {
    const rows = [
      row({ id: 'paypal-swe-generic', company: 'PayPal', title: 'Software Engineer Intern', status: 'new', appliedAt: null }),
      row({ id: 'paypal-swe-summer', company: 'PayPal', title: 'Software Engineer Intern - Summer 2027', status: 'new', appliedAt: null }),
      row({ id: 'paypal-mle-summer', company: 'PayPal', title: 'Machine Learning Engineer Intern - Summer 2027', status: 'new', appliedAt: null }),
      row({ id: 'paypal-mle-generic', company: 'PayPal', title: 'Machine Learning Engineer Intern', status: 'new', appliedAt: null })
    ]
    const plan = planEmailDocument(
      doc([
        { id: 'paypal-swe', company: 'PayPal', role: 'SWE Intern (Summer 2027)', status: 'applied', eventAt: '2026-09-04' },
        { id: 'paypal-mle', company: 'PayPal', role: 'MLE Intern - Summer 2027', status: 'applied', eventAt: '2026-09-05' },
        { id: 'paypal-cyber', company: 'PayPal', role: 'Cybersecurity Intern', status: 'applied', eventAt: '2026-09-06' }
      ]),
      rows,
      {},
      [],
      NOW
    )
    assert.equal(plan.applied, true)
    if (!plan.applied) return
    assert.equal(plan.outcome.ambiguous, 0)
    assert.equal(plan.outcome.statusUpdated, 2)
    assert.equal(plan.outcome.created, 1)
    assert.equal(plan.outcome.patches.find((p) => p.id === 'paypal-swe-summer')?.status, 'applied')
    assert.equal(plan.outcome.patches.find((p) => p.id === 'paypal-mle-summer')?.status, 'applied')
    assert.equal(
      plan.outcome.patches.some((p) => p.id === 'paypal-swe-generic' || p.id === 'paypal-mle-generic'),
      false
    )
    assert.equal(plan.outcome.ledger['paypal-swe'].trackerId, 'paypal-swe-summer')
    assert.equal(plan.outcome.ledger['paypal-mle'].trackerId, 'paypal-mle-summer')
    assert.equal(plan.outcome.ledger['paypal-swe'].status, 'applied')
    assert.equal(plan.outcome.ledger['paypal-mle'].status, 'applied')
    const cyber = plan.outcome.patches.find((p) => p.id === emailTrackerId('paypal-cyber'))
    assert.equal(cyber?.status, 'applied')
    assert.equal(cyber?.create?.title, 'Cybersecurity Intern')
    assert.equal(plan.outcome.ledger['paypal-cyber'].status, 'applied')
  })

  it('prefers an exact title over another hit that only matches after expansion', () => {
    const rows = [
      row({ id: 'expanded', company: 'PayPal', title: 'Software Engineer Intern - Summer 2027', status: 'new', appliedAt: null }),
      row({ id: 'exact', company: 'PayPal', title: 'SWE Intern (Summer 2027)', status: 'new', appliedAt: null })
    ]
    const plan = planEmailDocument(
      doc([{ id: 'paypal-swe', company: 'PayPal', role: 'SWE Intern (Summer 2027)', status: 'applied', eventAt: '2026-09-04' }]),
      rows,
      {},
      [],
      NOW
    )
    assert.equal(plan.applied, true)
    if (!plan.applied) return
    assert.equal(plan.outcome.ambiguous, 0)
    assert.equal(plan.outcome.patches.find((p) => p.id === 'exact')?.status, 'applied')
    assert.equal(plan.outcome.patches.some((p) => p.id === 'expanded'), false)
    assert.equal(plan.outcome.ledger['paypal-swe'].trackerId, 'exact')
  })

  it('stays ambiguous when two titles are equally close to the email', () => {
    const rows = [
      row({ id: 'summer', company: 'PayPal', title: 'Software Engineer Intern - Summer 2027', status: 'new', appliedAt: null }),
      row({ id: 'winter', company: 'PayPal', title: 'Software Engineer Intern - Winter 2027', status: 'new', appliedAt: null })
    ]
    const plan = planEmailDocument(
      doc([{ id: 'either', company: 'PayPal', role: 'Software Engineer Intern', status: 'applied', eventAt: '2026-09-04' }]),
      rows,
      {},
      [],
      NOW
    )
    assert.equal(plan.applied, true)
    if (!plan.applied) return
    assert.equal(plan.outcome.ambiguous, 1)
    assert.equal(plan.outcome.created, 0)
    assert.equal(plan.outcome.patches.length, 0)
    assert.equal(plan.outcome.ledger.either, undefined)
  })

  it('refuses an ambiguous company match instead of guessing or duplicating', () => {
    const rows = [
      row({ id: 'a', company: 'Aurora', title: 'Software Engineer Intern' }),
      row({ id: 'b', company: 'Aurora', title: 'Machine Learning Intern' })
    ]
    const plan = planEmailDocument(doc([{ id: 'blank', company: 'Aurora', role: '', status: 'rejected', eventAt: '2026-10-01' }]), rows, {}, [], NOW)
    assert.equal(plan.applied, true)
    if (!plan.applied) return
    assert.equal(plan.outcome.ambiguous, 1)
    assert.equal(plan.outcome.patches.length, 0)
    assert.equal(plan.outcome.ledger.blank, undefined)
  })

  it('keeps two blank-role emails at the same company as two rows', () => {
    const plan = planEmailDocument(
      doc([
        { id: 'au-1', company: 'Aurora', role: '', status: 'applied', eventAt: '2026-10-26' },
        { id: 'au-2', company: 'Aurora', role: '', status: 'applied', eventAt: '2026-10-27' }
      ]),
      [],
      {},
      [],
      NOW
    )
    assert.equal(plan.applied, true)
    if (!plan.applied) return
    assert.equal(plan.outcome.created, 2)
    assert.equal(plan.outcome.patches[0].id, emailTrackerId('au-1'))
    assert.equal(plan.outcome.patches[1].id, emailTrackerId('au-2'))
  })
})

describe('status precedence', () => {
  it('moves forward and allows rejected or offer, including over each other', () => {
    const applied = row({ id: 'r', company: 'Stripe', title: 'Software Engineer Intern', status: 'applied' })
    const oa = applyOne(applied, { status: 'oa', eventAt: '2026-10-12' })
    assert.equal(oa.status, 'oa')
    const interview = applyOne({ ...applied, status: 'oa' }, { status: 'interview', eventAt: '2026-10-20' })
    assert.equal(interview.status, 'interview')
    const rejected = applyOne({ ...applied, status: 'interview' }, { status: 'rejected', eventAt: '2026-10-28' })
    assert.equal(rejected.status, 'rejected')
    const offer = applyOne({ ...applied, status: 'rejected' }, { status: 'offer', eventAt: '2026-11-02' })
    assert.equal(offer.status, 'offer')
    const back = applyOne({ ...applied, status: 'offer' }, { status: 'interview', eventAt: '2026-11-03' })
    assert.equal(back.status, undefined)
  })

  it('does not downgrade interviewing to applied', () => {
    const patch = applyOne(
      row({ id: 'r', company: 'Stripe', title: 'Software Engineer Intern', status: 'interview', updatedAt: '2026-10-01T12:00:00.000Z' }),
      { status: 'applied', eventAt: '2026-11-01' }
    )
    assert.equal(patch.status, undefined)
  })

  it('does not let a stale rejection overwrite a newer interview', () => {
    const existing = row({ id: 'r', company: 'Stripe', title: 'Software Engineer Intern', status: 'interview' })
    const ledger: Record<string, EmailLedgerEntry> = {
      newer: {
        fingerprint: 'already',
        trackerId: 'r',
        status: 'interview',
        eventAt: '2026-11-02',
        statusEventAt: '2026-11-02',
        taskId: null,
        taskClosed: false,
        dueKey: null
      }
    }
    const plan = planEmailDocument(
      doc([{ id: 'older', company: 'Stripe', role: 'Software Engineer Intern', status: 'rejected', eventAt: '2026-10-01' }]),
      [existing],
      ledger,
      [],
      NOW
    )
    assert.equal(plan.applied, true)
    if (!plan.applied) return
    assert.equal(plan.outcome.patches.find((p) => p.status)?.status, undefined)
    assert.equal(plan.outcome.ledger.newer.statusEventAt, '2026-11-02')
  })

  it('lets a newer manual edit beat an older offer, and lets a non-manual row take a historical rejection', () => {
    const manual = applyOne(
      row({
        id: 'r',
        company: 'Stripe',
        title: 'Software Engineer Intern',
        status: 'interview',
        manual: true,
        updatedAt: '2026-11-04T15:00:00.000Z'
      }),
      { status: 'offer', eventAt: '2026-11-04' }
    )
    assert.equal(manual.status, undefined)

    const imported = applyOne(
      row({
        id: 'g',
        company: 'Amazon',
        title: 'Software Development Engineer Intern',
        status: 'applied',
        manual: false,
        updatedAt: '2026-11-04T18:00:00.000Z'
      }),
      { status: 'rejected', eventAt: '2026-10-07', id: 'amz', company: 'Amazon', role: 'Software Development Engineer Intern' }
    )
    assert.equal(imported.status, 'rejected')
    assert.equal(imported.clearManual, false)
  })

  it('clears the manual flag once a newer email is the status we kept', () => {
    const patch = applyOne(
      row({
        id: 'r',
        company: 'Stripe',
        title: 'Software Engineer Intern',
        status: 'applied',
        manual: true,
        updatedAt: '2026-10-01T12:00:00.000Z'
      }),
      { status: 'oa', eventAt: '2026-10-20T15:00:00Z' }
    )
    assert.equal(patch.status, 'oa')
    assert.equal(patch.clearManual, true)
  })
})

describe('tasks', () => {
  it('creates a task for a future deadline and skips past, rejected, completed, and deleted ones', () => {
    const future = planEmailDocument(
      doc([
        {
          id: 'soon',
          company: 'Stripe',
          role: 'Software Engineer Intern',
          status: 'oa',
          eventAt: '2026-11-04',
          deadline: { at: '2026-11-12', platform: 'HackerRank', display: 'Nov 12' }
        }
      ]),
      [],
      {},
      [],
      NOW
    )
    assert.equal(future.applied, true)
    if (!future.applied) return
    assert.equal(future.outcome.taskWrites.length, 1)
    assert.equal(future.outcome.taskWrites[0].action, 'create')
    assert.equal(future.outcome.taskWrites[0].deadline, '2026-11-12')
    assert.equal(future.outcome.taskWrites[0].externalId, 'soon')
    assert.match(future.outcome.taskWrites[0].text, /HackerRank/)

    const past = planEmailDocument(
      doc([{ id: 'old', company: 'Stripe', role: 'Software Engineer Intern', status: 'oa', eventAt: '2026-09-01', deadline: { at: '2026-09-05' } }]),
      [],
      {},
      [],
      NOW
    )
    assert.equal(past.applied, true)
    if (!past.applied) return
    assert.equal(past.outcome.taskWrites.length, 0)

    const rejected = planEmailDocument(
      doc([{ id: 'no', company: 'Stripe', role: 'Software Engineer Intern', status: 'rejected', eventAt: '2026-11-01', deadline: { at: '2026-11-20' } }]),
      [],
      {},
      [],
      NOW
    )
    assert.equal(rejected.applied, true)
    if (!rejected.applied) return
    assert.equal(rejected.outcome.taskWrites.length, 0)

    const done: TaskSnap = {
      id: 't-done',
      externalId: 'soon',
      state: 'done',
      deadline: '2026-11-12',
      dueAt: null,
      text: 'old',
      touched: true
    }
    const again = applyEmailImport([], {}, [done], future.file.entries, NOW)
    assert.equal(again.taskWrites.length, 0)
    assert.equal(again.ledger.soon.taskClosed, true)

    const deleted = applyEmailImport(
      [],
      { soon: { ...again.ledger.soon, taskClosed: false, taskId: 't-gone' } },
      [],
      future.file.entries,
      NOW
    )
    assert.equal(deleted.taskWrites.length, 0)
    assert.equal(deleted.ledger.soon.taskClosed, true)
  })

  it('updates the due time when a newer entry changes it, and not when the entry is older or unchanged', () => {
    const base = {
      id: 'soon',
      company: 'Stripe',
      role: 'Software Engineer Intern',
      status: 'oa' as const,
      eventAt: '2026-11-04',
      deadline: { at: '2026-11-12T21:00:00Z', platform: 'HackerRank' }
    }
    const first = parseEmailUpdatesDocument(doc([base]))
    const open: TaskSnap = {
      id: 't1',
      externalId: 'soon',
      state: 'open',
      deadline: '2026-11-12',
      dueAt: '2026-11-12T21:00:00.000Z',
      text: 'OA: Stripe',
      touched: false
    }
    const ledger = applyEmailImport([], {}, [open], first.entries, NOW).ledger
    assert.equal(ledger.soon.taskId, 't1')

    const moved = parseEmailUpdatesDocument(
      doc([{ ...base, eventAt: '2026-11-05', deadline: { at: '2026-11-20T18:00:00Z', platform: 'HackerRank' } }])
    )
    const update = applyEmailImport([], ledger, [open], moved.entries, NOW)
    assert.equal(update.taskWrites.length, 1)
    assert.equal(update.taskWrites[0].action, 'update')
    assert.equal(update.taskWrites[0].deadline, '2026-11-20')
    assert.equal(update.taskWrites[0].updateText, true)

    const rewound = parseEmailUpdatesDocument(
      doc([{ ...base, eventAt: '2026-11-01', deadline: { at: '2026-11-08T18:00:00Z' } }])
    )
    const stale = applyEmailImport([], update.ledger, [{ ...open, deadline: '2026-11-20', dueAt: '2026-11-20T18:00:00.000Z' }], rewound.entries, NOW)
    assert.equal(stale.taskWrites.length, 0)

    const handEdited: TaskSnap = { ...open, deadline: '2026-11-30', touched: true }
    const untouched = applyEmailImport([], ledger, [handEdited], first.entries, NOW)
    assert.equal(untouched.taskWrites.length, 0)
  })

  it('is idempotent: a second run with the same file changes nothing', () => {
    const text = doc([
      {
        id: 'soon',
        company: 'Stripe',
        role: 'Software Engineer Intern',
        status: 'oa',
        eventAt: '2026-11-04',
        note: 'bring a laptop',
        deadline: { at: '2026-11-12', platform: 'HackerRank' }
      }
    ])
    const store: EmailCommitStore & { items: { id: string }[]; events: number[] } = {
      items: [{ id: 'leave-me' }],
      events: [1],
      state: {},
      emailImports: {}
    }
    const items = store.items
    const first = planEmailDocument(text, [], {}, [], NOW)
    assert.equal(first.applied, true)
    if (!first.applied) return
    commitEmailResult(store, first.outcome)
    const created = first.outcome.taskWrites[0]
    const tasks: TaskSnap[] = [
      {
        id: 't1',
        externalId: 'soon',
        state: 'open',
        deadline: created.deadline,
        dueAt: created.dueAt,
        text: created.text,
        touched: false
      }
    ]
    recordTaskResults(store.emailImports ?? {}, [{ externalId: 'soon', action: 'created', taskId: 't1' }])
    const rows = matchRowsFrom({ items: [], state: store.state })
    const second = planEmailDocument(text, rows, store.emailImports ?? {}, tasks, NOW)
    assert.equal(second.applied, true)
    if (!second.applied) return
    assert.equal(second.outcome.dirty, false)
    assert.equal(second.outcome.patches.length, 0)
    assert.equal(second.outcome.taskWrites.length, 0)
    assert.equal(store.items, items)
    assert.deepEqual(store.events, [1])
    const note = store.state[emailTrackerId('soon')].note
    assert.match(note, /bring a laptop/)
    assert.equal(note.split('bring a laptop').length, 2)
  })
})

describe('store safety', () => {
  it('does not drop unrelated rows, items, or fields when applying a valid file', () => {
    const keep = row({ id: 'keep', company: 'Keep Co', title: 'Analyst Intern', status: 'interview' as JobStatus })
    const store: EmailCommitStore & { items: { id: string }[] } = {
      items: [{ id: 'keep' }],
      state: { keep: stateFor(keep, { promotedTaskId: 'prom-1', prepared: { at: 'yesterday' } }) },
      emailImports: {}
    }
    const plan = planEmailDocument(
      doc([{ id: 'other', company: 'Figma', role: 'Software Engineer Intern', status: 'applied', eventAt: '2026-10-02' }]),
      [keep],
      {},
      [],
      NOW
    )
    assert.equal(plan.applied, true)
    if (!plan.applied) return
    const items = store.items
    commitEmailResult(store, plan.outcome)
    assert.equal(store.items, items)
    assert.equal(store.state.keep.status, 'interview')
    assert.equal(store.state.keep.promotedTaskId, 'prom-1')
    assert.deepEqual((store.state.keep as { prepared?: { at: string } }).prepared, { at: 'yesterday' })
    assert.equal(store.state.keep.snapshot.title, 'Analyst Intern')
    assert.ok(store.state[emailTrackerId('other')])
    assert.equal(Object.keys(store.state).length, 2)
  })

  it('a rejected document produces no plan to commit', () => {
    const store = { state: { keep: { status: 'interview' as const } }, emailImports: { old: { fingerprint: 'f' } } }
    const plan = planEmailDocument('{"version":1,"entries":', [], {}, [], NOW)
    assert.equal(plan.applied, false)
    assert.equal(store.state.keep.status, 'interview')
    assert.equal(store.emailImports.old.fingerprint, 'f')
  })
})

describe('fixture from the Gmail export', () => {
  it('parses the checked-in sample and keeps known rows', () => {
    const text = readFileSync(join(import.meta.dirname, '../../../fixtures/email-updates.sample.json'), 'utf8')
    const parsed = parseEmailUpdatesDocument(text)
    assert.equal(parsed.ok, true, parsed.error ?? '')
    assert.ok(parsed.entries.length >= 300)
    assert.ok(parsed.entries.every((e) => e.company && e.status && e.eventAt && e.id))
    const susq = parsed.entries.find((e) => e.company === 'Susquehanna' && e.deadline?.dueAt)
    assert.ok(susq, 'expected a clock-time OA for Susquehanna')
    assert.match(susq.deadline?.platform ?? '', /CodeSignal/)
    const amazon = parsed.entries.filter((e) => companiesMatch(e.company, 'Amazon') && e.status === 'rejected')
    assert.ok(amazon.length >= 1)
  })
})

function applyOne(existing: MatchRow, entry: Record<string, unknown>): { status?: JobStatus; clearManual?: boolean } {
  const plan = planEmailDocument(
    doc([
      {
        id: 'e',
        company: existing.company,
        role: existing.title,
        eventAt: '2026-11-01',
        ...entry
      }
    ]),
    [existing],
    {},
    [],
    NOW
  )
  assert.equal(plan.applied, true)
  if (!plan.applied) return {}
  const patch = plan.outcome.patches.find((p) => p.id === existing.id)
  return { status: patch?.status, clearManual: patch?.clearManual }
}
