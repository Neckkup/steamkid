/**
 * Loads the real app in a real browser and captures the evidence a visual QA
 * pass needs: a full-page screenshot per route per viewport, plus the
 * mechanical checks that are objective enough to automate (horizontal
 * overflow, clipped text, tap-target size, blank paint).
 *
 * This is a capture harness, not a verdict. It reports measurements and
 * screenshots; judging whether a screen is right for a child is QA's call.
 *
 * Run it through the wrapper so the rootless browser env is in place:
 *   eval "$(bash scripts/setup-browser.sh)" && npx tsx scripts/visual-audit.ts
 *
 * Options:
 *   --base-url=<url>   default http://localhost:3000
 *   --out=<dir>        default .cache/visual-audit
 *   --routes=/a,/b     override the default route list
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium, type Page } from 'playwright'

/** iPhone 14 width is the founder's "on a phone" case; 1280 is the desk case. */
const VIEWPORTS = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'desktop-1280', width: 1280, height: 800 },
]

const DEFAULT_ROUTES = ['/', '/consent', '/learn', '/me', '/teacher']

/** Below this, a child's finger misses. The WCAG 2.2 minimum is 24px; Apple and Material both say 44. */
const MIN_TAP_TARGET_PX = 44

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

type Finding = { route: string; viewport: string; kind: string; detail: string }

/**
 * tsx compiles with esbuild's `keepNames`, which rewrites every nested function
 * into a `__name(...)` call. That helper is defined in the Node module scope,
 * not in the page, so any `page.evaluate` callback containing a nested function
 * dies with `ReferenceError: __name is not defined`. Defining a no-op in the
 * page is the smallest fix and keeps the callbacks type-checked TypeScript.
 */
const KEEP_NAMES_SHIM = 'globalThis.__name ??= (fn) => fn'

/**
 * Everything below runs inside the page because it needs live layout boxes;
 * computing this from the DOM snapshot outside the browser would miss wrapping.
 */
async function measure(page: Page) {
  return page.evaluate((minTap) => {
    const docWidth = document.documentElement.clientWidth
    const overflowing: string[] = []
    const clipped: string[] = []
    const smallTargets: string[] = []

    const describe = (el: Element) => {
      const tag = el.tagName.toLowerCase()
      const id = el.id ? `#${el.id}` : ''
      const cls = el.className && typeof el.className === 'string'
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : ''
      const text = (el.textContent ?? '').trim().slice(0, 40)
      return `${tag}${id}${cls}${text ? ` "${text}"` : ''}`
    }

    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const box = el.getBoundingClientRect()
      if (box.width === 0 && box.height === 0) continue

      // Right edge past the viewport means the child has to scroll sideways.
      if (box.right > docWidth + 1) {
        overflowing.push(`${describe(el)} (right=${Math.round(box.right)} > ${docWidth})`)
      }

      // scrollWidth beyond clientWidth on a non-scrollable box means text is cut off.
      const style = getComputedStyle(el)
      const scrollable = style.overflowX === 'auto' || style.overflowX === 'scroll'
      if (!scrollable && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        clipped.push(`${describe(el)} (scrollWidth=${el.scrollWidth} > ${el.clientWidth})`)
      }

      const interactive =
        el.matches('a[href], button, input, select, textarea, [role="button"]') &&
        style.display !== 'none'
      if (interactive && (box.height < minTap || box.width < minTap)) {
        smallTargets.push(`${describe(el)} (${Math.round(box.width)}x${Math.round(box.height)})`)
      }
    }

    return {
      docWidth,
      scrollWidth: document.documentElement.scrollWidth,
      textLength: (document.body.innerText ?? '').trim().length,
      overflowing: overflowing.slice(0, 10),
      clipped: clipped.slice(0, 10),
      smallTargets: smallTargets.slice(0, 10),
    }
  }, MIN_TAP_TARGET_PX)
}

async function main() {
  const baseUrl = arg('base-url', 'http://localhost:3000').replace(/\/$/, '')
  const outDir = resolve(arg('out', '.cache/visual-audit'))
  const routes = arg('routes', DEFAULT_ROUTES.join(',')).split(',').filter(Boolean)

  mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch()
  const findings: Finding[] = []
  const rows: string[] = []

  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        isMobile: viewport.name.startsWith('mobile'),
      })
      await context.addInitScript(KEEP_NAMES_SHIM)

      for (const route of routes) {
        const page = await context.newPage()
        const consoleErrors: string[] = []
        page.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200))
        })

        const response = await page.goto(`${baseUrl}${route}`, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        })
        const status = response?.status() ?? 0

        const shot = join(outDir, `${viewport.name}${route.replace(/\//g, '_') || '_root'}.png`)
        await page.screenshot({ path: shot, fullPage: true })

        const m = await measure(page)
        rows.push(
          `${route} @ ${viewport.name}: HTTP ${status}, ${m.textLength} chars, ` +
            `scrollWidth ${m.scrollWidth}/${m.docWidth} -> ${shot}`,
        )

        const push = (kind: string, detail: string) =>
          findings.push({ route, viewport: viewport.name, kind, detail })

        if (status >= 400) push('http', `HTTP ${status}`)
        // A page that paints almost no text is the white-screen case.
        if (m.textLength < 20) push('blank', `only ${m.textLength} characters of text`)
        if (m.scrollWidth > m.docWidth + 1) {
          push('horizontal-scroll', `scrollWidth ${m.scrollWidth} > viewport ${m.docWidth}`)
        }
        for (const d of m.overflowing) push('overflow', d)
        for (const d of m.clipped) push('clipped-text', d)
        if (viewport.name.startsWith('mobile')) {
          for (const d of m.smallTargets) push('small-tap-target', d)
        }
        for (const d of consoleErrors) push('console-error', d)

        await page.close()
      }

      await context.close()
    }
  } finally {
    await browser.close()
  }

  const report = [
    `# visual audit — ${baseUrl}`,
    '',
    '## captured',
    ...rows.map((r) => `- ${r}`),
    '',
    `## findings (${findings.length})`,
    ...(findings.length === 0
      ? ['- none']
      : findings.map((f) => `- [${f.kind}] ${f.route} @ ${f.viewport}: ${f.detail}`)),
    '',
  ].join('\n')

  writeFileSync(join(outDir, 'report.md'), report)
  console.log(report)
  console.log(`screenshots + report: ${outDir}`)
}

main().catch((err) => {
  console.error(`visual-audit failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
