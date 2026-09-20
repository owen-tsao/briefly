// Throwaway smoke test for the pure (non-Electron) job source adapters.
import { fetchApplyGuy } from '../src/main/jobs/sources/applyguy'
import { fetchSimplify } from '../src/main/jobs/sources/simplify'
import { fetchSpeedyApply } from '../src/main/jobs/sources/speedyapply'
import { fetchJobright } from '../src/main/jobs/sources/jobright'
import { extract } from '../src/main/jobs/extract'
import { classifyUrl } from '../src/main/jobs/normalize'

const main = async (): Promise<void> => {
  const results: Record<string, Awaited<ReturnType<typeof fetchApplyGuy>>> = {}
  for (const [name, fn] of [
    ['applyguy', fetchApplyGuy],
    ['simplify', fetchSimplify],
    ['speedyapply', fetchSpeedyApply],
    ['jobright', fetchJobright]
  ] as const) {
    const t = Date.now()
    try {
      const items = await fn(14)
      results[name] = items
      const ats = items.filter((i) => classifyUrl(i.url)).length
      const terms = items.reduce<Record<string, number>>((a, i) => ((a[i.term] = (a[i.term] ?? 0) + 1), a), {})
      console.log(`${name.padEnd(12)} ${String(items.length).padStart(4)} items  ats=${ats}  pay=${items.filter((i) => i.pay).length}  ${JSON.stringify(terms)}  ${Date.now() - t}ms`)
      console.log('   e.g.', items[0]?.company, '—', items[0]?.title, '|', items[0]?.url.slice(0, 80))
    } catch (e) {
      console.log(`${name.padEnd(12)} FAILED ${(e as Error).message}`)
    }
  }
  // Cross-feed dedupe: same canonical id from two sources?
  const ids = new Map<string, string[]>()
  for (const [name, items] of Object.entries(results)) for (const it of items) ids.set(it.id, [...(ids.get(it.id) ?? []), name])
  const shared = [...ids.values()].filter((v) => new Set(v).size > 1).length
  console.log(`\ncanonical ids: ${ids.size} unique, ${shared} seen in 2+ feeds`)

  // Extraction on 3 real items across ATSs
  console.log('\nextract:')
  const picks = ['greenhouse', 'lever', 'ashby', 'workday'].map((a) =>
    Object.values(results).flat().find((i) => classifyUrl(i.url)?.ats === a)
  )
  for (const p of picks) {
    if (!p) continue
    const ex = await extract(p.url, p.company)
    console.log(`  ${classifyUrl(p.url)?.ats?.padEnd(10)} ${String(ex.text.length).padStart(6)} chars  readable=${ex.descriptionAvailable}  loc=${ex.location}  ${p.company}`)
  }
}
main()
