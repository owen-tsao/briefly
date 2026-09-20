import type { JobItem, JobVerdict } from '../../shared/jobs'
import { completeJson } from '../llm'
import { readProfileFile } from './profile'

const SYSTEM = `You screen internship postings for one specific candidate. You are given their resume,
their preferences (including hard blockers and soft flags), and one or more postings. For each
posting decide whether they should apply.

Rules
- "apply": no hard blocker from the preferences applies, and the role is real engineering work.
- "skip": at least one hard blocker clearly applies. Name it in blockers, quoting the posting.
- "flagged": you are unsure, the posting text is missing or too thin to judge, or only soft flags apply.
- Never invent requirements. If the posting does not state a grad-date window, degree level,
  citizenship, or pay, do not assume one. Unknown pay is fine.
- If the resume is empty, judge on the preferences alone and add the flag "Resume not filled in".
- blockers/flags/matched/missing are short phrases, max 6 each. summary is 1–2 plain sentences
  written to the candidate ("you"), stating the single most decision-relevant fact first.
- If a posting's text is unavailable, its decision is "flagged" and flags includes
  "Posting text unreadable — triage only".

Return only a JSON array with exactly one object per posting, in the same order, each shaped:
{"index":0,"decision":"apply|flagged|skip","blockers":[],"flags":[],"matched":[],"missing":[],"summary":""}`

const DECISIONS = new Set(['apply', 'flagged', 'skip'])
/** Per-posting text budget when several share one call; keeps a 4-posting call near 4k tokens. */
const TEXT_PER_POSTING = 2_400
const KEY_LINE = /qualif|requir|eligib|must|graduat|degree|citizen|authoriz|sponsor|clearance|pay|salary|compensation|\$\s?\d|hour|per year|start date|duration|\b(20)?2[67]\b/i

/**
 * Fit a posting into the budget without losing the lines that decide eligibility. Keep the
 * opening (role summary), then prefer lines that mention qualifications, dates, pay, and status.
 */
export function trimPosting(text: string, budget = TEXT_PER_POSTING): string {
  const t = text.trim()
  if (t.length <= budget) return t
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean)
  const headBudget = Math.floor(budget * 0.35)
  const head: string[] = []
  let used = 0
  let i = 0
  for (; i < lines.length && used + lines[i].length + 1 <= headBudget; i++) {
    head.push(lines[i])
    used += lines[i].length + 1
  }
  const key: string[] = []
  for (const l of lines.slice(i)) {
    if (!KEY_LINE.test(l)) continue
    if (used + l.length + 1 > budget) break
    key.push(l)
    used += l.length + 1
  }
  return [...head, key.length ? '…' : '', ...key].filter(Boolean).join('\n')
}

function clean(list: unknown, max = 6): string[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((s) => s.trim().slice(0, 140))
    .slice(0, max)
}

function normalize(raw: Partial<JobVerdict> | undefined, hasText: boolean): JobVerdict {
  const decision = raw && typeof raw.decision === 'string' && DECISIONS.has(raw.decision) ? raw.decision : 'flagged'
  const flags = clean(raw?.flags)
  if (!hasText && !flags.some((f) => /unreadable/i.test(f))) flags.unshift('Posting text unreadable — triage only')
  return {
    decision: !hasText && decision === 'apply' ? 'flagged' : decision,
    blockers: clean(raw?.blockers),
    flags,
    matched: clean(raw?.matched),
    missing: clean(raw?.missing),
    summary: raw && typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 400) : ''
  }
}

function postingBlock(index: number, item: JobItem, text: string): string {
  return [
    `### Posting ${index}`,
    `Company: ${item.company}`,
    `Title: ${item.title}`,
    item.location ? `Location: ${item.location}` : '',
    item.pay ? `Pay (from feed): ${item.pay}` : '',
    item.deadline ? `Deadline: ${item.deadline}` : '',
    `Term: ${item.term}`,
    item.referralNote ? `Source note: ${item.referralNote}` : '',
    text ? trimPosting(text) : '(posting text unavailable)'
  ]
    .filter((l) => l !== '')
    .join('\n')
}

/**
 * Score several postings in one call. Returns verdicts in input order. Throws on LLM
 * failure so the caller can back off; a malformed array falls back to "flagged" per posting.
 */
export async function scoreBatch(batch: { item: JobItem; text: string }[]): Promise<JobVerdict[]> {
  const resume = readProfileFile('resume.md').trim()
  const prefs = readProfileFile('preferences.md').trim()
  const user = [
    '## Candidate resume',
    resume || '(empty — the candidate has not filled in resume.md yet)',
    '',
    '## Candidate preferences',
    prefs || '(empty)',
    '',
    `## Postings (${batch.length})`,
    ...batch.map((b, i) => postingBlock(i, b.item, b.text.trim()))
  ].join('\n')

  const raw = await completeJson<unknown>(SYSTEM, user)
  type Indexed = Partial<JobVerdict> & { index?: number }
  const arr: Indexed[] = Array.isArray(raw) ? (raw as Indexed[]) : [raw as Indexed]
  return batch.map((b, i) => {
    const byIndex = arr.find((v) => v && typeof v === 'object' && v.index === i)
    return normalize(byIndex ?? arr[i], b.text.trim().length > 0)
  })
}
