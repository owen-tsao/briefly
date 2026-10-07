// DEV ONLY. Reproduces reachForm + scanForm on one ATS URL using a scratch profile (the app's
// profile is locked while briefly runs). Usage: node scripts/spike-reach-form.mjs <url>
import { chromium } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2]
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'briefly-spike-')), {
  headless: false,
  viewport: null,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--window-size=1180,920', '--disable-blink-features=AutomationControlled']
})
const page = await ctx.newPage()
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => console.log('(networkidle timeout)'))
console.log('body text length:', (await page.evaluate(() => document.body.innerText.length)))
const hasField = async () =>
  (await page.locator('input[type="email"], input[name*="email" i], input[autocomplete="given-name"], input#first_name, input[name*="first" i], [data-automation-id="legalNameSection_firstName"]').count()) > 0
console.log('url', page.url(), 'hasField at load:', await hasField())
const apply = page
  .getByRole('button', { name: /^apply( now| for this job)?$/i })
  .or(page.getByRole('link', { name: /^apply( now| for this job)?$/i }))
  .or(page.locator('a[href*="/apply"], a.postings-btn, [data-automation-id="adventureButton"]'))
console.log('apply controls:', await apply.count())
for (const el of await page.getByRole('button').all()) {
  const n = (await el.innerText().catch(() => '')).trim()
  if (/apply/i.test(n)) console.log('  button:', JSON.stringify(n))
}
for (const el of await page.getByRole('link').all()) {
  const n = (await el.innerText().catch(() => '')).trim()
  const h = await el.getAttribute('href')
  if (/apply|application/i.test(n + ' ' + h)) console.log('  link:', JSON.stringify(n), h)
}
if ((await apply.count()) > 0) {
  await apply.first().click({ timeout: 5000 }).catch((e) => console.log('click failed', e.message))
  await page.waitForLoadState('domcontentloaded').catch(() => undefined)
}
await page.waitForTimeout(800)
for (let i = 0; i < 10 && !(await hasField()); i++) await page.waitForTimeout(500)
console.log('after reach:', page.url(), 'hasField:', await hasField())
const inputs = await page.locator('input, textarea, select, [role=combobox]').evaluateAll((els) =>
  els.slice(0, 40).map((e) => `${e.tagName.toLowerCase()} type=${e.getAttribute('type')} name=${e.getAttribute('name')} id=${e.id} ac=${e.getAttribute('autocomplete')} aria=${e.getAttribute('aria-label')}`)
)
console.log(inputs.join('\n'))
await ctx.close()
