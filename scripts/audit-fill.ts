// DEV ONLY. Dry-run audit of the form filler: opens live postings headless (throwaway profile, never
// your logged-in one), scans each application form with the same scanner Prepare uses, and prints
// what decide() WOULD put in every field. Nothing is typed or submitted.
//
// Build + run (electron is stubbed so the profile reader works outside the app):
//   npx esbuild scripts/audit-fill.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/audit-fill.mjs --alias:electron=scripts/stub-electron.mjs --external:playwright \
//   && node /tmp/audit-fill.mjs [maxPerAts=6] [ats,ats,...]
import { chromium } from 'playwright'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { scanFormsScript, type FormField } from '../src/main/jobs/browser/forms'
import { decide, chooseOption, isUsBased, type FillContext } from '../src/main/jobs/browser/fill'
import { loadCandidate } from '../src/main/jobs/browser/candidate'

const maxPerAts = Number(process.argv[2] ?? 6)
const only = (process.argv[3] ?? 'greenhouse,ashby,lever').split(',')

type Ats = 'greenhouse' | 'ashby' | 'lever' | 'workday'
function atsOf(url: string): Ats | null {
  const h = new URL(url).hostname
  if (/greenhouse\.io$/.test(h)) return 'greenhouse'
  if (/ashbyhq\.com$/.test(h)) return 'ashby'
  if (/lever\.co$/.test(h)) return 'lever'
  if (/myworkday(jobs|site)\.com$/.test(h)) return 'workday'
  return null
}

// Live postings from the store, one per org so each form layout counts once.
const store = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/briefly/jobs.json'), 'utf8'))
const picks: Record<string, Map<string, { url: string; location: string | null; company: string }>> = {}
for (const it of store.items) {
  if (!it.active) continue
  let ats: Ats | null
  try {
    ats = atsOf(it.url)
  } catch {
    continue
  }
  if (!ats || !only.includes(ats)) continue
  const org = new URL(it.url).pathname.split('/')[1]
  picks[ats] ??= new Map()
  if (picks[ats].size < maxPerAts && !picks[ats].has(org)) picks[ats].set(org, { url: it.url, location: it.location ?? null, company: it.company })
}

const c = loadCandidate()
const profile = mkdtempSync(join(tmpdir(), 'briefly-audit-'))
const browser = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1200, height: 900 } })
const page = await browser.newPage()

async function reachForm(url: string, ats: Ats): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined)
  const hasField = async (): Promise<boolean> =>
    (await page.locator('input[type="email"], input[name*="email" i], input[autocomplete="given-name"], input#first_name, input[name*="first" i]').count()) > 0
  if (await hasField()) return
  if (ats === 'ashby') {
    const m = page.url().match(/^(https:\/\/jobs\.ashbyhq\.com\/[^/?#]+\/[0-9a-f-]{20,})/i)
    if (m) await page.goto(`${m[1]}/application`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined)
  } else if (ats === 'workday') {
    // Posting → Apply → "Apply Manually". Tenants that require an account bounce to a sign-in page here.
    const apply = page.locator('[data-automation-id="adventureButton"]')
    for (let i = 0; i < 10 && (await apply.count()) === 0; i++) await page.waitForTimeout(500)
    if ((await apply.count()) === 0) return
    await apply.first().click({ timeout: 5000 }).catch(() => undefined)
    const manual = page.locator('[data-automation-id="applyManually"]')
    for (let i = 0; i < 10 && (await manual.count()) === 0; i++) await page.waitForTimeout(500)
    if (await manual.count()) await manual.first().click({ timeout: 5000 }).catch(() => undefined)
    await page.waitForTimeout(3000)
    console.log(`  → ${page.url().replace(/^https:\/\/[^/]+/, '')}`)
  } else {
    const apply = page
      .getByRole('button', { name: /^apply( now| for this job| for this position)?$/i })
      .or(page.getByRole('link', { name: /^apply( now| for this job| for this position)?$/i }))
      .or(page.locator('a[href*="/apply"], a[href$="/application"], a.postings-btn'))
    if ((await apply.count()) > 0) await apply.first().click({ timeout: 5000 }).catch(() => undefined)
  }
  for (let i = 0; i < 16 && !(await hasField()); i++) await page.waitForTimeout(500)
}

const summary: Record<string, number> = {}
const unmatched = new Map<string, number>()
for (const [ats, orgs] of Object.entries(picks)) {
  for (const [org, { url, location, company }] of orgs) {
    console.log(`\n==== ${ats} · ${company} (${org}) · ${location ?? 'no location'}\n${url}`)
    try {
      await reachForm(url, ats)
      const fields: FormField[] = await page.evaluate(scanFormsScript)
      const ctx: FillContext = { usBased: isUsBased(location) }
      if (!fields.length) {
        console.log('  (no fields found — closed posting or login wall?)')
        continue
      }
      for (const f of fields) {
        if (f.kind === 'file') {
          console.log(`  [file] ${f.label.slice(0, 60)}`)
          continue
        }
        const d = decide(f, c, ctx)
        const opts = f.options.length ? ` {${f.options.slice(0, 8).map((o) => o.label.slice(0, 28)).join(' | ')}${f.options.length > 8 ? ' | …' : ''}}` : ''
        let shown = d === 'skip' ? '— skip' : d ? `${d.source}: "${d.value.slice(0, 50)}"` : '∅'
        if (d && d !== 'skip' && f.options.length) {
          const o = chooseOption(f, d.value)
          shown += o ? ` → ${o.label.slice(0, 40)}` : ' → NO OPTION'
        }
        const key = d === 'skip' ? 'skip' : d ? d.source : f.kind === 'textarea' ? 'draft' : 'unfilled'
        summary[key] = (summary[key] ?? 0) + 1
        if (!d && f.kind !== 'textarea') unmatched.set(f.label.slice(0, 90), (unmatched.get(f.label.slice(0, 90)) ?? 0) + 1)
        console.log(`  [${f.kind}${f.required ? '*' : ''}] ${f.label.slice(0, 70)}${opts}\n      ${shown}`)
      }
    } catch (err) {
      console.log(`  ERROR ${err instanceof Error ? err.message.split('\n')[0] : err}`)
    }
  }
}
console.log('\n==== totals', JSON.stringify(summary))
console.log('==== unmatched labels (count):')
for (const [l, n] of [...unmatched.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${l}`)
await browser.close()
rmSync(profile, { recursive: true, force: true })
