// DEV ONLY — Phase 0 spike. Opens one Greenhouse posting in a headed, persistent-profile Chromium,
// fills the contact block with obviously fake values, uploads the resume PDF, screenshots, and stops.
// Never clicks Submit. Usage: node scripts/spike-greenhouse.mjs [url]
import { chromium } from 'playwright'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const url = process.argv[2] ?? 'https://job-boards.greenhouse.io/togetherai/jobs/5238031007'
const profile = join(homedir(), '.briefly', 'browser-spike')
const resume = join(homedir(), '.briefly', 'profile', 'resume.pdf')

const ctx = await chromium.launchPersistentContext(profile, { headless: false, viewport: { width: 1200, height: 900 } })
const page = ctx.pages()[0] ?? (await ctx.newPage())
const t0 = Date.now()
await page.goto(url, { waitUntil: 'domcontentloaded' })
console.log('loaded', page.url(), 'in', Date.now() - t0, 'ms | title:', await page.title())

const blocked = await page.locator('text=/verify you are human|access denied|unusual traffic/i').count()
console.log('bot-wall text present:', blocked > 0)

// Greenhouse job-boards: the form is on the same page under #application-form (new boards) or
// after an "Apply" click (older embeds). Try both.
const apply = page.getByRole('button', { name: /^apply$/i }).or(page.getByRole('link', { name: /^apply$/i }))
if ((await apply.count()) > 0 && (await page.locator('input[name*="first_name"], #first_name').count()) === 0) {
  await apply.first().click()
}
await page.waitForSelector('input#first_name, input[name*="first_name"], input[autocomplete="given-name"]', { timeout: 15_000 })

const fill = async (sel, value) => {
  const loc = page.locator(sel).first()
  if ((await loc.count()) === 0) return console.log('  missing', sel)
  await loc.fill(value)
  console.log('  filled', sel)
}
await fill('input#first_name, input[name*="first_name"], input[autocomplete="given-name"]', 'Spike')
await fill('input#last_name, input[name*="last_name"], input[autocomplete="family-name"]', 'Test')
await fill('input#email, input[type="email"]', 'spike-test@example.invalid')
await fill('input#phone, input[type="tel"], input[name*="phone"]', '000-000-0000')

// Resume upload: Greenhouse hides the <input type=file> behind "Attach" buttons; set files directly.
const fileInputs = page.locator('input[type="file"]')
console.log('file inputs on page:', await fileInputs.count())
if ((await fileInputs.count()) > 0 && existsSync(resume)) {
  await fileInputs.first().setInputFiles(resume)
  await page.waitForTimeout(2500)
  const attached = await page.locator('text=/resume\\.pdf/i').count()
  console.log('resume.pdf name visible after upload:', attached > 0)
}

const labels = await page.locator('#application-form label, form label').allInnerTexts()
console.log('question labels (first 30):')
for (const l of labels.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30)) console.log('   -', l.slice(0, 90))

const shot = '/tmp/spike-greenhouse.png'
await page.screenshot({ path: shot, fullPage: false })
console.log('screenshot:', shot)
console.log('STOPPED BEFORE SUBMIT. Closing in 3s.')
await page.waitForTimeout(3000)
await ctx.close()
