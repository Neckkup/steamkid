/**
 * Smallest check that proves the rootless browser stack actually works.
 *
 * Launching is not enough on this runner: the image ships no fonts, so a
 * browser can start and still render every glyph as a tofu box. Since the
 * product UI is Thai, this renders Thai text with tone marks and asserts the
 * result is not blank, which is what a visual QA pass depends on.
 *
 * Run it through the wrapper so the sysroot env is in place:
 *   bash scripts/setup-browser.sh --check
 */

import { chromium } from 'playwright'

const SAMPLE = 'สวัสดี steamkid — Hello 123'

async function main() {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.setContent(
      `<body style="margin:0;font-family:sans-serif;font-size:24px">${SAMPLE}</body>`,
    )

    const text = await page.evaluate(() => document.body.innerText)
    if (text.trim() !== SAMPLE) {
      throw new Error(`unexpected page text: ${JSON.stringify(text)}`)
    }

    // A tofu-only render still reports text, so measure painted pixels instead.
    const inkedPixels = await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 390
      canvas.height = 60
      const ctx = canvas.getContext('2d')!
      ctx.font = '24px sans-serif'
      ctx.fillStyle = '#000'
      ctx.fillText(document.body.innerText, 0, 30)
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      let inked = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) inked += 1
      return inked
    })
    if (inkedPixels < 200) {
      throw new Error(`text rendered blank (${inkedPixels} inked pixels) — fonts are missing`)
    }

    /**
     * The child-facing UI is full of emoji. A missing emoji font still "renders"
     * — as a tofu box — so counting ink is not enough. Noto Color Emoji is a
     * colour bitmap font, so a correct render leaves saturated pixels behind;
     * tofu leaves only greyscale.
     */
    const colouredPixels = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 64
      const ctx = canvas.getContext('2d')!
      ctx.font = '48px sans-serif'
      ctx.fillStyle = '#000'
      ctx.fillText('🔬', 4, 48)
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      let coloured = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
        if (Math.max(r, g, b) - Math.min(r, g, b) > 24) coloured += 1
      }
      return coloured
    })
    if (colouredPixels < 50) {
      throw new Error(
        `emoji rendered as tofu (${colouredPixels} coloured pixels) — the emoji font is missing`,
      )
    }

    console.log(
      `chromium ${browser.version()} OK — Thai + Latin render (${inkedPixels} px inked), ` +
        `emoji render in colour (${colouredPixels} px)`,
    )
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(`browser-check failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
