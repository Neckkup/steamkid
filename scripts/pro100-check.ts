/**
 * PRO-100 check: a mistyped teacher link must read as a bad link, not an outage.
 *
 * Verifies the D2/D3 fix from commit b00475b in a real browser, at both
 * viewports. Deliberately does NOT check the HTTP status — D1 (200 vs 404) is
 * confirmed, deferred, and tracked on PRO-99.
 *
 *   eval "$(bash scripts/setup-browser.sh)" && npx tsx scripts/pro100-check.ts
 */

import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const OUT = '.cache/pro100'

const VIEWPORTS = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'desktop-1280', width: 1280, height: 900 },
]

const ROUTES = [
  { key: 'review-malformed', path: '/teacher/review/not-a-uuid' },
  { key: 'learner-malformed', path: '/teacher/not-a-uuid' },
  { key: 'review-absent', path: '/teacher/review/01999999-0000-7000-8000-000000000000' },
]

function ok(label: string, condition: boolean): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
  if (!condition) process.exitCode = 1
}

/** `next dev`'s HMR socket keeps the network busy; settle explicitly. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(900)
}

async function text(page: Page): Promise<string> {
  await settle(page)
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ')
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()

    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200))
    })

    // --- the three not-found routes ---------------------------------------
    for (const route of ROUTES) {
      await page.goto(`${BASE}${route.path}`, { waitUntil: 'networkidle' })
      const body = await text(page)
      await page.screenshot({
        path: `${OUT}/${route.key}-${viewport.name}.png`,
        fullPage: true,
      })
      const tag = `[${viewport.name}] ${route.path}`

      // 1/2 — the defect itself.
      ok(`${tag} no Postgres uuid error`, !body.includes('invalid input syntax for type uuid'))
      ok(`${tag} no raw "uuid" text at all`, !/uuid/i.test(body))
      ok(`${tag} not the outage screen`, !body.includes('ตอนนี้อ่านข้อมูลการเติบโตไม่ได้'))
      ok(`${tag} no retry-the-outage button`, !body.includes('ลองอีกครั้ง'))

      // 4 — it must be the teacher's not-found, not the child's.
      ok(`${tag} says not found`, body.includes('ไม่เจอหน้านี้'))
      ok(`${tag} never calls the reader หนู`, !body.includes('หนู'))
      ok(`${tag} no child lesson button`, !body.includes('ดูบทเรียนทั้งหมด'))
      ok(`${tag} offers the review queue`, body.includes('กลับไปรายการงานที่รอครูดู'))
      ok(`${tag} says this is not an outage`, body.includes('ไม่ใช่ระบบล่ม'))

      // 6 — mechanical.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      )
      ok(`${tag} no horizontal overflow`, !overflow)

      const small = await page.evaluate(() => {
        const out: string[] = []
        for (const el of Array.from(document.querySelectorAll('button, a, select, input, textarea'))) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) continue
          if (r.height < 44) out.push(`${el.tagName}:${(el.textContent ?? '').slice(0, 30)} h=${Math.round(r.height)}`)
        }
        return out
      })
      ok(`${tag} every control >= 44px tall`, small.length === 0)
      if (small.length) console.log('   small targets:', small.slice(0, 8))

      // The back link must actually go where it claims.
      const href = await page.locator('a', { hasText: 'กลับไปรายการงานที่รอครูดู' }).first().getAttribute('href')
      ok(`${tag} back link points at /teacher/review`, href === '/teacher/review')
    }

    // --- 7: the working screens still work --------------------------------
    await page.goto(`${BASE}/teacher/review`, { waitUntil: 'networkidle' })
    const queue = await text(page)
    await page.screenshot({ path: `${OUT}/queue-${viewport.name}.png`, fullPage: true })
    ok(`[${viewport.name}] queue still lists the waiting group`, /รอครูอยู่จริง ๆ \( ?2 ?\)/.test(queue))
    ok(`[${viewport.name}] queue still names the refusal`, queue.includes('AI ไม่ยอมตรวจ'))
    ok(`[${viewport.name}] queue still lists the unscorable`, queue.includes('ตรวจไม่ได้'))
    ok(`[${viewport.name}] queue still lists a graded item`, queue.includes('AI ตรวจแล้ว'))
    ok(`[${viewport.name}] queue is not a not-found`, !queue.includes('ไม่เจอหน้านี้'))

    const links = await page.locator('li a').evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLAnchorElement).getAttribute('href')).filter((h): h is string => !!h),
    )
    const verdictLinks = links.filter((h) => /^\/teacher\/review\/[0-9a-f-]{36}$/.test(h))
    ok(`[${viewport.name}] queue links to 3 real verdicts`, verdictLinks.length === 3)

    // All three real verdict ids must still open.
    for (const [i, href] of verdictLinks.entries()) {
      await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle' })
      const body = await text(page)
      ok(`[${viewport.name}] real verdict ${i + 1} opens`, !body.includes('ไม่เจอหน้านี้'))
      ok(`[${viewport.name}] real verdict ${i + 1} is not the outage screen`, !body.includes('ตอนนี้อ่านข้อมูลการเติบโตไม่ได้'))
      ok(`[${viewport.name}] real verdict ${i + 1} shows the child's answer`, body.includes('คำตอบของเด็ก'))
      ok(`[${viewport.name}] real verdict ${i + 1} never says 0 คะแนน`, !body.includes('0 คะแนน') || body.includes('ไม่ใช่ 0 คะแนน'))
    }

    ok(`[${viewport.name}] no console errors`, consoleErrors.length === 0)
    if (consoleErrors.length) console.log('   console:', consoleErrors.slice(0, 5))

    await context.close()
  }

  await browser.close()
  console.log(process.exitCode ? '\nsome checks FAILED' : '\nall checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
