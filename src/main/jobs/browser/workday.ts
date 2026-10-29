import type { Frame, Locator } from 'playwright'
import type { Candidate, Experience, MonthYear } from './candidate'
import type { FillReport } from './fill'

/**
 * Workday's "My Experience" step: repeating Work Experience and Education blocks behind "Add" /
 * "Add Another" buttons. The generic filler sees one flat list of controls and can't know that
 * "Job Title" belongs to the second job. This fills each block from resume.md — one block per job,
 * dates from the resume's own date range, the description being the resume's bullets verbatim —
 * and Education from answers.md. Workday keeps its `data-automation-id`s stable across tenants;
 * those are the hooks here. It never presses Save and Continue.
 */
export async function fillWorkdaySections(frame: Frame, c: Candidate, report: FillReport): Promise<void> {
  if (!/myworkdayjobs\.com|myworkdaysite\.com|\.workday\.com/i.test(frame.url())) return
  const before = report.filled.length
  const sections = await frame.locator('[data-automation-id$="Section"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-automation-id'))).catch(() => [] as (string | null)[])
  if (sections.length) console.log(`[fill] workday sections on page: ${sections.join(', ')}`)
  await fillWorkExperience(frame, c.experiences, report)
  await fillEducation(frame, c, report)
  const mine = report.filled.slice(before)
  if (mine.length || sections.some((x) => /workExperience|education/i.test(x ?? ''))) console.log(`[fill] workday blocks: ${mine.map((r) => r.label).join(' | ') || 'nothing filled'}`)
}

const record = (report: FillReport, label: string, value: string): void => {
  report.filled.push({ idx: -1, label, value: value.slice(0, 80), source: 'profile' })
}

async function fillWorkExperience(frame: Frame, jobs: Experience[], report: FillReport): Promise<void> {
  const section = frame.locator('[data-automation-id="workExperienceSection"]')
  if ((await section.count().catch(() => 0)) === 0 || jobs.length === 0) return
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]
    const panel = await ensurePanel(frame, section, `workExperience-${i + 1}`)
    if (!panel) {
      report.unfilled.push({ label: `Work Experience ${i + 1} (${job.company})`, reason: 'could not add a block' })
      continue
    }
    const label = `Work Experience ${i + 1}`
    if (await setText(control(panel, 'jobTitle'), job.title)) record(report, `${label} · Job Title`, job.title)
    if (await setText(control(panel, 'company'), job.company)) record(report, `${label} · Company`, job.company)
    if (job.location && (await setText(control(panel, 'location'), job.location))) record(report, `${label} · Location`, job.location)
    const current = control(panel, 'currentlyWorkHere')
    if ((await current.count().catch(() => 0)) > 0) {
      await current.setChecked(job.current, { timeout: 3000 }).catch(() => undefined)
      await frame.waitForTimeout(300)
    }
    if (job.start && (await setMonthYear(panel.locator('[data-automation-id="formField-startDate"]'), job.start))) record(report, `${label} · From`, fmt(job.start))
    if (!job.current && job.end && (await setMonthYear(panel.locator('[data-automation-id="formField-endDate"]'), job.end))) record(report, `${label} · To`, fmt(job.end))
    if (job.bullets.length) {
      const text = job.bullets.map((b) => `• ${b}`).join('\n')
      if (await setText(control(panel, 'description'), text)) record(report, `${label} · Role Description`, `${job.bullets.length} resume bullets`)
    }
  }
}

async function fillEducation(frame: Frame, c: Candidate, report: FillReport): Promise<void> {
  const section = frame.locator('[data-automation-id="educationSection"]')
  if ((await section.count().catch(() => 0)) === 0 || !c.school) return
  const panel = await ensurePanel(frame, section, 'education-1')
  if (!panel) {
    report.unfilled.push({ label: 'Education', reason: 'could not add a block' })
    return
  }
  // School: a plain box on some tenants, a search-and-pick on others.
  const school = control(panel, 'school')
  if ((await school.count().catch(() => 0)) > 0) {
    const chosen = (await isSearchBox(school)) ? await pickFromSearch(frame, school, c.school) : (await alreadyShows(school, c.school)) || (await setText(school, c.school)) ? c.school : null
    if (chosen) record(report, 'Education · School', chosen)
    else report.unfilled.push({ label: 'Education · School', reason: `no match for "${c.school}"` })
  }
  if (c.degree) {
    const degree = control(panel, 'degree')
    if ((await degree.count().catch(() => 0)) > 0) {
      const score = degreeMatcher(c.degree)
      const shown = (await degree.innerText().catch(() => '')).trim()
      // Already on the right option (a re-fill of this step): leave it.
      const chosen = score(shown) >= 3 ? shown : await pickFromListbox(frame, degree, score)
      if (chosen) record(report, 'Education · Degree', chosen)
      else report.unfilled.push({ label: 'Education · Degree', reason: `no option matching "${c.degree}"` })
    }
  }
  if (c.major) {
    const field = panel.locator('[data-automation-id="formField-fieldOfStudy"] input, [data-automation-id="fieldOfStudy"] input, input[data-automation-id="fieldOfStudy"]').first()
    if ((await field.count().catch(() => 0)) > 0) {
      const chosen = await pickFromSearch(frame, field, c.major)
      if (chosen) record(report, 'Education · Field of Study', chosen)
      else report.unfilled.push({ label: 'Education · Field of Study', reason: `no match for "${c.major}"` })
    }
  }
  if (c.gpa && (await setText(control(panel, 'gpa'), c.gpa))) record(report, 'Education · GPA', c.gpa)
  if (c.gradYear) {
    const end = panel.locator('[data-automation-id="formField-endDate"]')
    const month = c.gradMonth ? monthNumber(c.gradMonth) : 0
    if (await setMonthYear(end, { month, year: Number(c.gradYear) })) record(report, 'Education · To', `${c.gradMonth} ${c.gradYear}`.trim())
  }
}

/** The block `workExperience-N` / `education-N`, pressing the section's Add / Add Another until it exists. */
async function ensurePanel(frame: Frame, section: Locator, id: string): Promise<Locator | null> {
  const panel = section.locator(`[data-automation-id="${id}"]`)
  if ((await panel.count().catch(() => 0)) > 0) return panel.first()
  const add = section.locator('[data-automation-id="add-button"]').or(section.getByRole('button', { name: /^add( another)?$/i })).last()
  if ((await add.count().catch(() => 0)) === 0) return null
  await add.click({ timeout: 3000 }).catch(() => undefined)
  await panel.first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => undefined)
  await frame.waitForTimeout(400)
  return (await panel.count().catch(() => 0)) > 0 ? panel.first() : null
}

/** The control behind a Workday automation id: the element itself when it is one, else the input/textarea/button inside it. */
function control(panel: Locator, id: string): Locator {
  const el = panel.locator(`[data-automation-id="${id}"]`).first()
  return el.locator('xpath=self::input|self::textarea|self::button|self::select').or(el.locator('input, textarea, button, select').first()).first()
}

async function setText(loc: Locator, value: string): Promise<boolean> {
  if ((await loc.count().catch(() => 0)) === 0) return false
  try {
    await loc.fill(value, { timeout: 4000 })
    await loc.dispatchEvent('change').catch(() => undefined)
    return true
  } catch {
    return false
  }
}

/** Workday's split month / year boxes: two spinbuttons that take typed digits. */
async function setMonthYear(field: Locator, when: MonthYear): Promise<boolean> {
  if ((await field.count().catch(() => 0)) === 0) return false
  const month = field.locator('[data-automation-id="dateSectionMonth-input"]').first()
  const year = field.locator('[data-automation-id="dateSectionYear-input"]').first()
  let any = false
  if (when.month && (await month.count().catch(() => 0)) > 0) {
    await month.click({ timeout: 2000 }).catch(() => undefined)
    await month.press('ControlOrMeta+a').catch(() => undefined)
    await month.pressSequentially(String(when.month).padStart(2, '0'), { delay: 40 }).catch(() => undefined)
    any = true
  }
  if ((await year.count().catch(() => 0)) > 0) {
    await year.click({ timeout: 2000 }).catch(() => undefined)
    await year.press('ControlOrMeta+a').catch(() => undefined)
    await year.pressSequentially(String(when.year), { delay: 40 }).catch(() => undefined)
    any = true
  }
  if (any) await year.press('Tab').catch(() => undefined)
  return any
}

async function isSearchBox(loc: Locator): Promise<boolean> {
  return loc
    .evaluate((el) => el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list' || el.getAttribute('data-automation-id') === 'searchBox' || Boolean(el.closest('[data-automation-id*="multiselect" i], [data-automation-id*="prompt" i]')))
    .catch(() => false)
}

/** The field already holds `want` (a selected pill, or the value in the box) — a re-fill must not add it twice. */
async function alreadyShows(box: Locator, want: string): Promise<boolean> {
  const holder = box.locator('xpath=ancestor::*[starts-with(@data-automation-id,"formField-")][1]')
  const text = (await holder.innerText().catch(() => '')) || (await box.inputValue().catch(() => ''))
  return text.toLowerCase().replace(/\s+/g, ' ').includes(want.toLowerCase().replace(/\s+/g, ' '))
}

/** Type into a search-as-you-type box and click the option that best matches. Returns the option text, or null. */
async function pickFromSearch(frame: Frame, box: Locator, want: string): Promise<string | null> {
  if (await alreadyShows(box, want)) return want
  const options = frame.locator('[data-automation-id="promptOption"]:visible, [role="option"]:visible')
  for (const q of [want, want.split(/[,(]/)[0].trim()]) {
    await box.click({ timeout: 3000 }).catch(() => undefined)
    await box.fill('', { timeout: 2000 }).catch(() => undefined)
    await box.pressSequentially(q.slice(0, 60), { delay: 20 }).catch(() => undefined)
    await box.press('Enter').catch(() => undefined) // Workday searches on Enter
    await options.first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => undefined)
    const labels = (await options.allInnerTexts().catch(() => [] as string[])).map((t) => t.trim())
    const idx = bestMatch(labels, want)
    if (idx >= 0) {
      await options.nth(idx).click({ timeout: 3000 }).catch(() => undefined)
      await frame.waitForTimeout(300)
      return labels[idx]
    }
    if (q === want.split(/[,(]/)[0].trim()) break
  }
  await frame.page().keyboard.press('Escape').catch(() => undefined)
  return null
}

/** Open a Workday listbox button and click the first option the matcher accepts. */
async function pickFromListbox(frame: Frame, button: Locator, accept: (label: string) => number): Promise<string | null> {
  await button.click({ timeout: 3000 }).catch(() => undefined)
  const options = frame.locator('[role="option"]:visible, [role="listbox"] li:visible')
  await options.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined)
  const labels = (await options.allInnerTexts().catch(() => [] as string[])).map((t) => t.trim())
  let best = -1
  let bestScore = 0
  labels.forEach((l, i) => {
    const s = accept(l)
    if (s > bestScore) {
      bestScore = s
      best = i
    }
  })
  if (best < 0) {
    await frame.page().keyboard.press('Escape').catch(() => undefined)
    return null
  }
  await options.nth(best).click({ timeout: 3000 }).catch(() => undefined)
  return labels[best]
}

/**
 * "B.S." must land on "Bachelor of Science", not the alphabetically-first "Bachelor of Arts".
 * Scores: exact degree-and-field > generic "Bachelor's" > any bachelor's.
 */
export function degreeMatcher(degree: string): (label: string) => number {
  const d = degree.toLowerCase().replace(/\./g, '')
  const level = /^(bs|ba|bachelor)/.test(d) ? 'bachelor' : /^(ms|ma|master)/.test(d) ? 'master' : /phd|doctor/.test(d) ? 'doctor' : /associate/.test(d) ? 'associate' : d
  const field = /^(bs|ms)\b|science/.test(d) ? 'science' : /^(ba|ma)\b|\barts?\b/.test(d) ? 'arts' : ''
  return (label) => {
    const l = label.toLowerCase()
    if (!l.includes(level) && !(level === 'bachelor' && /\bb\.?[sa]\.?\b/.test(l)) && !(level === 'master' && /\bm\.?[sa]\.?\b/.test(l))) return 0
    if (field && (l.includes(field) || new RegExp(`\\b${level === 'bachelor' ? 'b' : 'm'}\\.?${field[0]}\\.?\\b`).test(l))) return 3
    if (/'s\b|degree$/.test(l) && !/arts|science|fine|business|engineering/.test(l)) return 2
    if (field && /arts|science/.test(l)) return 0 // the other field: wrong
    return 1
  }
}

function bestMatch(labels: string[], want: string): number {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const w = norm(want)
  let exact = labels.findIndex((l) => norm(l) === w)
  if (exact >= 0) return exact
  exact = labels.findIndex((l) => norm(l).startsWith(w) || w.startsWith(norm(l)))
  if (exact >= 0) return exact
  const words = w.split(' ').filter((x) => x.length > 2)
  const containsAll = labels.findIndex((l) => words.every((x) => norm(l).includes(x)))
  if (containsAll >= 0) return containsAll
  return labels.length === 1 ? 0 : -1
}

function fmt(m: MonthYear): string {
  return `${String(m.month).padStart(2, '0')}/${m.year}`
}

function monthNumber(name: string): number {
  const i = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(name.slice(0, 3).toLowerCase())
  return i + 1
}
