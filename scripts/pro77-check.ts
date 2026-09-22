/**
 * PRO-77 end-to-end check, in a real browser.
 *
 * Walks the flow the acceptance criteria describe: open the queue, take the
 * demo teacher identity, open a graded verdict, change one skill's level, save,
 * reload, and confirm the new level survived with the AI's original still
 * beside it. Also opens the two no-score verdicts and asserts the page never
 * says "0 คะแนน" about them.
 *
 * Throwaway harness for one ticket; delete once QA has a browser test.
 *   eval "$(bash scripts/setup-browser.sh)" && npx tsx scripts/pro77-check.ts
 */

import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const OUT = '.cache/pro77'

const VIEWPORTS = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'desktop-1280', width: 1280, height: 900 },
]

function ok(label: string, condition: boolean): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
  if (!condition) process.exitCode = 1
}

/**
 * `networkidle` alone resolves against the *previous* document under `next
 * dev`, whose HMR socket keeps the network busy — every assertion then reads
 * the page it just navigated away from. Settle explicitly instead.
 */
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

    await page.goto(`${BASE}/teacher/review`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: `${OUT}/queue-${viewport.name}.png`, fullPage: true })

    const queueText = await text(page)
    ok(`[${viewport.name}] queue lists the waiting group first`, /รอครูอยู่จริง ๆ \( ?2 ?\)/.test(queueText))
    ok(`[${viewport.name}] queue names the refusal as a refusal`, queueText.includes('AI ไม่ยอมตรวจ'))
    ok(`[${viewport.name}] queue never calls a refusal a zero`, !queueText.includes('0 คะแนน'))

    // Take the demo teacher identity.
    const signIn = page.getByRole('button', { name: 'ถือตัวตนครูตัวอย่าง' })
    if (await signIn.count()) {
      await signIn.click()
      await settle(page)
    }
    ok(`[${viewport.name}] demo teacher identity held`, (await text(page)).includes('ปล่อยตัวตนครู'))

    // --- the two no-score cases -------------------------------------------
    for (const label of ['AI ไม่ยอมตรวจ', 'ตรวจไม่ได้']) {
      await page.goto(`${BASE}/teacher/review`, { waitUntil: 'networkidle' })
      await page.locator('li a', { hasText: label }).first().click()
      await page.waitForURL(/\/teacher\/review\/[0-9a-f-]{36}/)
      const body = await text(page)

      ok(`[${viewport.name}] "${label}" says there is no score`, body.includes('ยังไม่มีคะแนนสำหรับงานชิ้นนี้ — ไม่ใช่ 0 คะแนน'))
      ok(`[${viewport.name}] "${label}" shows no percentage`, !/\b0%/.test(body))
      ok(`[${viewport.name}] "${label}" shows the child's answer`, body.includes('คำตอบของเด็ก'))
      ok(`[${viewport.name}] "${label}" offers no level to override`, body.includes('ยังไม่มีระดับให้แก้'))
      await page.screenshot({
        path: `${OUT}/detail-${label === 'ตรวจไม่ได้' ? 'unscorable' : 'blocked'}-${viewport.name}.png`,
        fullPage: true,
      })
    }

    // --- the graded case, and a real correction ---------------------------
    await page.goto(`${BASE}/teacher/review`, { waitUntil: 'networkidle' })
    await page.locator('li a', { hasText: 'AI ตรวจแล้ว' }).first().click()
    await page.waitForURL(/\/teacher\/review\/[0-9a-f-]{36}/)
    await settle(page)
    const gradedUrl = page.url()

    let body = await text(page)
    ok(`[${viewport.name}] graded page shows both scores`, body.includes('คะแนนที่ใช้จริงตอนนี้') && body.includes('คะแนนที่ AI ให้ไว้ตอนแรก'))
    ok(`[${viewport.name}] graded page says the AI is not final`, body.includes('ครูแก้ระดับได้ทุกทักษะ'))
    ok(`[${viewport.name}] graded page shows the evidence quote`, body.includes('ข้อความที่ AI ยกมาเป็นหลักฐาน'))
    await page.screenshot({ path: `${OUT}/detail-graded-${viewport.name}.png`, fullPage: true })

    // Only run the write once; the second viewport verifies it persisted.
    const alreadyCorrected = body.includes('ระดับนี้ครูเป็นคนให้')

    if (!alreadyCorrected) {
      await page.getByRole('button', { name: /^แก้ระดับของ/ }).first().click()
      await page.screenshot({ path: `${OUT}/override-open-${viewport.name}.png`, fullPage: true })

      // Save must stay disabled until a reason code is chosen.
      const save = page.getByRole('button', { name: /^บันทึกระดับ/ })
      ok(`[${viewport.name}] save is blocked without a reason code`, await save.isDisabled())

      await page.getByRole('radio').nth(0).check() // level 0
      await page.locator('select').first().selectOption('too_harsh')
      await page.locator('textarea').first().fill('ทดสอบ: เด็กเขียนเหตุผลไว้ในประโยคสุดท้ายแล้ว')
      ok(`[${viewport.name}] save is enabled once a reason is chosen`, await save.isEnabled())

      await save.click()
      await settle(page)
    }

    // The reload is the acceptance criterion: does it still hold?
    await page.goto(gradedUrl, { waitUntil: 'networkidle' })
    body = await text(page)
    ok(`[${viewport.name}] the correction survived a reload`, body.includes('ระดับนี้ครูเป็นคนให้'))
    ok(`[${viewport.name}] the AI's original level is still visible`, body.includes('AI เคยให้'))
    ok(`[${viewport.name}] the correction history is kept`, body.includes('ประวัติการแก้ของทักษะนี้'))
    ok(`[${viewport.name}] untouched skills are still marked as the AI's`, body.includes('ระดับนี้ AI เป็นคนให้'))
    await page.screenshot({ path: `${OUT}/detail-corrected-${viewport.name}.png`, fullPage: true })

    // The queue must show the correction too.
    await page.goto(`${BASE}/teacher/review`, { waitUntil: 'networkidle' })
    ok(`[${viewport.name}] queue marks the corrected verdict`, (await text(page)).includes('ครูแก้แล้ว'))

    // --- mechanical checks -------------------------------------------------
    await page.goto(gradedUrl, { waitUntil: 'networkidle' })
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    ok(`[${viewport.name}] no horizontal overflow on the detail page`, !overflow)

    const small = await page.evaluate(() => {
      const out: string[] = []
      for (const el of Array.from(document.querySelectorAll('button, a, select, input, textarea'))) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        if (r.height < 44) out.push(`${el.tagName}:${(el.textContent ?? '').slice(0, 24)} h=${Math.round(r.height)}`)
      }
      return out
    })
    ok(`[${viewport.name}] every control is at least 44px tall`, small.length === 0)
    if (small.length) console.log('   small targets:', small.slice(0, 8))

    await context.close()
  }

  await browser.close()
  console.log(process.exitCode ? '\nsome checks FAILED' : '\nall checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
