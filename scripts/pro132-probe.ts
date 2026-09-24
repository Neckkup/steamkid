/**
 * PRO-132 probe: drive the practice page through "answer -> send -> locked" and
 * measure what the row actually looks like on either side of that line.
 *
 * It exists because PRO-132 was invisible to every test we have: the logic was
 * already right — the fieldset was disabled and a second tap changed nothing —
 * and only the paint was wrong, so the evidence has to be computed styles and
 * pixels. `visual:audit` cannot reach this state either; it captures routes as
 * they load, and the locked row only exists after an answer has been sent.
 *
 * It prints, per viewport, the row colours and cursor before and after the
 * lock, whether hover still lights a locked row, and whether the lock holds.
 *
 *   npm run db:local && npm run dev          # in another shell
 *   eval "$(bash scripts/setup-browser.sh)" && npx tsx scripts/pro132-probe.ts
 *
 *   PROBE_BASE_URL   default http://localhost:3000
 *   PROBE_OUT        default .cache/pro132
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { chromium, type Page } from 'playwright'

import { CONSENT_POLICY_VERSION } from '@/lib/learning/consent'

const BASE = process.env.PROBE_BASE_URL ?? 'http://localhost:3000'
const ROUTE = '/learn/what-is-force/practice'
const OUT = resolve(process.env.PROBE_OUT ?? '.cache/pro132')

/** The row's colours as a child sees them, plus the cursor over its centre. */
async function readRow(page: Page, index: number) {
  return page.evaluate((i) => {
    const label = document.querySelectorAll('fieldset label')[i] as HTMLElement
    const circle = label.querySelector('span[aria-hidden="true"]') as HTMLElement
    const dot = circle.querySelector('span')
    const input = label.querySelector('input') as HTMLInputElement
    const cs = getComputedStyle(label)
    return {
      border: cs.borderTopColor,
      background: cs.backgroundColor,
      text: cs.color,
      labelCursor: cs.cursor,
      inputCursor: getComputedStyle(input).cursor,
      circleBorder: getComputedStyle(circle).borderTopColor,
      dot: dot ? getComputedStyle(dot).backgroundColor : null,
      checked: input.checked,
      disabled: input.disabled,
    }
  }, index)
}

/**
 * Park the pointer off every row and let `transition-colors` finish. Without
 * this the first read after a state change catches a half-blended border and
 * reports a colour nobody ever sees.
 */
async function settle(page: Page) {
  await page.mouse.move(0, 0)
  await page.waitForTimeout(500)
}

/** Hover the row and report whether anything about it lit up. */
async function hoverRow(page: Page, index: number) {
  await settle(page)
  const before = await readRow(page, index)
  await page.locator('fieldset label').nth(index).hover()
  await page.waitForTimeout(250)
  const after = await readRow(page, index)
  return {
    border: `${before.border} -> ${after.border}`,
    changed: before.border !== after.border || before.background !== after.background,
    cursor: after.inputCursor,
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const report: string[] = []

  for (const vp of [
    { name: 'mobile-390', width: 390, height: 844 },
    { name: 'desktop-1280', width: 1280, height: 800 },
  ]) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const consent = await context.request.post(`${BASE}/api/consent`, {
      data: {
        scopes: ['service_operation', 'ai_grading', 'behaviour_events'],
        policyVersion: CONSENT_POLICY_VERSION,
      },
    })
    if (consent.status() !== 201) {
      throw new Error(`consent grant failed: HTTP ${consent.status()} ${await consent.text()}`)
    }

    const page = await context.newPage()
    await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'networkidle' })
    if (new URL(page.url()).pathname !== ROUTE) {
      throw new Error(`never reached ${ROUTE}; landed on ${page.url()}`)
    }
    await page.locator('fieldset label').first().waitFor()
    await settle(page)

    report.push(`\n=== ${vp.name} ===`)
    report.push(`ENABLED row0 : ${JSON.stringify(await readRow(page, 0))}`)
    report.push(`ENABLED hover row0: ${JSON.stringify(await hoverRow(page, 0))}`)
    await settle(page)
    await page.screenshot({ path: `${OUT}/${vp.name}-enabled.png`, fullPage: true })

    // Answer with the last choice so the "selected" and "not selected" rows are
    // both on screen in the locked shot.
    const rows = await page.locator('fieldset label').count()
    await page.locator('fieldset label').nth(rows - 1).click()
    await page.getByRole('button', { name: 'ส่งคำตอบ' }).click()
    await page.getByRole('button', { name: /ข้อต่อไป|ดูผลรวม|ลองอีกครั้ง|กลับ/ }).first().waitFor({ timeout: 60_000 })

    await settle(page)
    report.push(`LOCKED row0 (not chosen): ${JSON.stringify(await readRow(page, 0))}`)
    report.push(`LOCKED row${rows - 1} (chosen): ${JSON.stringify(await readRow(page, rows - 1))}`)
    report.push(`LOCKED hover row0: ${JSON.stringify(await hoverRow(page, 0))}`)

    // The lock must hold, not just look locked.
    const checkedBefore = await page.locator('fieldset input:checked').count()
    await page.locator('fieldset label').nth(0).click({ force: true })
    await page.waitForTimeout(200)
    const stillChosen = await page.locator('fieldset label').nth(rows - 1).locator('input').isChecked()
    report.push(`LOCKED re-tap row0: checkedCount=${checkedBefore} chosenStillChecked=${stillChosen}`)

    await settle(page)
    await page.screenshot({ path: `${OUT}/${vp.name}-locked.png`, fullPage: true })
    await context.close()
  }

  await browser.close()
  console.log(report.join('\n'))
  console.log(`\nscreenshots in ${OUT}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
