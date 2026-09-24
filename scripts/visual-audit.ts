/**
 * Loads the real app in a real browser and captures the evidence a visual QA
 * pass needs: a full-page screenshot per route per viewport, plus the
 * mechanical checks that are objective enough to automate (horizontal
 * overflow, clipped text, tap-target size, blank paint).
 *
 * This is a capture harness, not a verdict. It reports measurements and
 * screenshots; judging whether a screen is right for a child is QA's call.
 *
 * **It must never claim to have audited a screen it did not open** (PRO-126).
 * Before this rule existed, every consent-gated route 302'd to `/consent`, the
 * harness wrote that screenshot under the requested route's name, and the
 * report said `captured` — so a silent run looked like a clean app when it was
 * really an app nobody had looked at. Two mechanisms hold the line now:
 *
 *   - the landing URL is compared to the requested route, and a mismatch is a
 *     `route-mismatch` finding and a non-zero exit, never a capture
 *   - the run grants consent up front (`--consent=grant`, the default) so the
 *     gated screens can actually be reached instead of being skipped
 *
 * Run it through the wrapper so the rootless browser env is in place:
 *   eval "$(bash scripts/setup-browser.sh)" && npx tsx scripts/visual-audit.ts
 *
 * Options:
 *   --base-url=<url>        default http://localhost:3000
 *   --out=<dir>             default .cache/visual-audit
 *   --routes=/a,/b          override the default route list
 *   --consent=grant|skip    default grant: POST /api/consent before capturing
 *   --consent-scopes=a,b    override the scopes granted
 *   --storage-state=<file>  Playwright storageState JSON to start each context from
 *   --allow-redirect        report route mismatches but still exit 0
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'

import { CONSENT_POLICY_VERSION } from '@/lib/learning/consent'

/** iPhone 14 width is the founder's "on a phone" case; 1280 is the desk case. */
const VIEWPORTS = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'desktop-1280', width: 1280, height: 800 },
]

const DEFAULT_ROUTES = ['/', '/consent', '/learn', '/me', '/teacher']

/**
 * The required scopes, plus `behaviour_events` because the growth UI renders
 * nothing without it and an audit that cannot see the growth UI is the same
 * blind spot in a smaller shape. `training_use` is deliberately left off: a
 * throwaway audit learner has no business opting into the training set, and no
 * screen depends on it.
 */
const DEFAULT_CONSENT_SCOPES = ['service_operation', 'ai_grading', 'behaviour_events']

/** Below this, a child's finger misses. The WCAG 2.2 minimum is 24px; Apple and Material both say 44. */
const MIN_TAP_TARGET_PX = 44

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

type Finding = { route: string; viewport: string; kind: string; detail: string }

type Capture = {
  route: string
  viewport: string
  file: string
  hash: string
}

/**
 * tsx compiles with esbuild's `keepNames`, which rewrites every nested function
 * into a `__name(...)` call. That helper is defined in the Node module scope,
 * not in the page, so any `page.evaluate` callback containing a nested function
 * dies with `ReferenceError: __name is not defined`. Defining a no-op in the
 * page is the smallest fix and keeps the callbacks type-checked TypeScript.
 */
const KEEP_NAMES_SHIM = 'globalThis.__name ??= (fn) => fn'

/** `/learn/x/practice` -> `_learn_x_practice`, and `/` -> `_root`. */
function slug(route: string): string {
  return routePath(route).replace(/\//g, '_') || '_root'
}

/**
 * The path a route asks for, with the trailing slash and any query dropped so
 * `/learn` and `/learn/` do not read as a redirect. A redirect that only adds a
 * query string is not the failure this guard exists for; a redirect that lands
 * on a different path is.
 */
function routePath(route: string): string {
  const path = new URL(route, 'http://audit.invalid').pathname
  return path.length > 1 ? path.replace(/\/$/, '') : path === '/' ? '' : path
}

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

    /**
     * The `sr-only` recipe deliberately collapses a box to 1x1 and clips it, so
     * its text always "overflows" its client box. Reporting that as clipped
     * text points at the one fix that is actually wrong — deleting the
     * screen-reader label, PRO-128. Nothing painted, nothing to clip.
     */
    const screenReaderOnly = (el: Element) => {
      if (el.classList.contains('sr-only')) return true
      const s = getComputedStyle(el)
      return (s.clipPath !== 'none' || s.clip !== 'auto') && el.clientWidth <= 1
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
      if (
        !scrollable &&
        !screenReaderOnly(el) &&
        el.scrollWidth > el.clientWidth + 1 &&
        el.clientWidth > 0
      ) {
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

/**
 * Give this context a consented learner.
 *
 * `context.request` shares cookie storage with the browser, so the `sk_learner`
 * cookie the route handler sets is the same one the pages then read. A failure
 * here aborts the run: continuing would produce exactly the silent
 * every-route-is-really-/consent report that PRO-126 is about.
 */
async function grantConsent(context: BrowserContext, baseUrl: string, scopes: string[]) {
  const response = await context.request.post(`${baseUrl}/api/consent`, {
    data: { scopes, policyVersion: CONSENT_POLICY_VERSION },
  })
  if (response.status() !== 201) {
    throw new Error(
      `consent grant failed: POST /api/consent -> HTTP ${response.status()} ` +
        `${(await response.text()).slice(0, 200)}`,
    )
  }
}

async function main() {
  const baseUrl = arg('base-url', 'http://localhost:3000').replace(/\/$/, '')
  const outDir = resolve(arg('out', '.cache/visual-audit'))
  const routes = arg('routes', DEFAULT_ROUTES.join(',')).split(',').filter(Boolean)
  const consentMode = arg('consent', 'grant')
  const consentScopes = arg('consent-scopes', DEFAULT_CONSENT_SCOPES.join(',')).split(',').filter(Boolean)
  const storageStatePath = arg('storage-state', '')
  const allowRedirect = flag('allow-redirect')

  if (consentMode !== 'grant' && consentMode !== 'skip') {
    throw new Error(`--consent must be "grant" or "skip", got "${consentMode}"`)
  }
  if (storageStatePath && !existsSync(storageStatePath)) {
    throw new Error(`--storage-state file not found: ${storageStatePath}`)
  }

  mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch()
  const findings: Finding[] = []
  const captured: string[] = []
  const notCaptured: string[] = []
  const shots: Capture[] = []

  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        isMobile: viewport.name.startsWith('mobile'),
        ...(storageStatePath ? { storageState: storageStatePath } : {}),
      })
      await context.addInitScript(KEEP_NAMES_SHIM)
      if (consentMode === 'grant') await grantConsent(context, baseUrl, consentScopes)

      for (const route of routes) {
        const page = await context.newPage()
        const consoleErrors: string[] = []
        page.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200))
        })

        const push = (kind: string, detail: string) =>
          findings.push({ route, viewport: viewport.name, kind, detail })

        // One unreachable route used to abort the whole run; now it is a
        // finding about that route and the rest of the sweep still happens.
        let status = 0
        try {
          const response = await page.goto(`${baseUrl}${route}`, {
            waitUntil: 'networkidle',
            timeout: 30_000,
          })
          status = response?.status() ?? 0
        } catch (err) {
          const detail = err instanceof Error ? err.message.split('\n')[0] : String(err)
          push('unreachable', detail)
          notCaptured.push(`${route} @ ${viewport.name}: NOT CAPTURED — navigation failed: ${detail}`)
          await page.close()
          continue
        }

        const landed = routePath(new URL(page.url()).pathname)
        const wanted = routePath(route)

        const body = await page.screenshot({ fullPage: true })
        const hash = createHash('sha256').update(body).digest('hex')

        if (landed !== wanted) {
          /**
           * The screenshot is still kept — it is evidence of the redirect — but
           * its filename says where the browser actually ended up, so no later
           * reader can mistake it for the route that was asked for. The
           * page-level measurements are deliberately *not* run: they would
           * describe the landing page and get filed under the requested route,
           * which is the same lie in a different column.
           */
          const file = join(outDir, `${viewport.name}${slug(route)}__REDIRECTED-TO${slug(landed || '/')}.png`)
          writeFileSync(file, body)
          push('route-mismatch', `requested ${wanted || '/'} but landed on ${landed || '/'}`)
          notCaptured.push(
            `${route} @ ${viewport.name}: NOT CAPTURED — redirected to ${landed || '/'} ` +
              `(HTTP ${status}) -> ${file}`,
          )
          await page.close()
          continue
        }

        const file = join(outDir, `${viewport.name}${slug(route)}.png`)
        writeFileSync(file, body)
        shots.push({ route, viewport: viewport.name, file, hash })

        const m = await measure(page)
        captured.push(
          `${route} @ ${viewport.name}: HTTP ${status}, ${m.textLength} chars, ` +
            `scrollWidth ${m.scrollWidth}/${m.docWidth} -> ${file}`,
        )

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

  /**
   * Two different routes rendering byte-identical pixels is either a redirect
   * the URL check somehow missed or two screens that really are the same. Both
   * are worth saying out loud — the founder spotted the original bug from five
   * identical `1543 chars` lines, and the harness should have spotted it first.
   */
  const byHash = new Map<string, Capture[]>()
  for (const shot of shots) {
    const key = `${shot.viewport}:${shot.hash}`
    byHash.set(key, [...(byHash.get(key) ?? []), shot])
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue
    const [first, ...rest] = group
    findings.push({
      route: first.route,
      viewport: first.viewport,
      kind: 'duplicate-screenshot',
      detail: `pixel-identical to ${rest.map((s) => s.route).join(', ')}`,
    })
  }

  const mismatches = findings.filter((f) => f.kind === 'route-mismatch' || f.kind === 'unreachable')

  const report = [
    `# visual audit — ${baseUrl}`,
    '',
    `consent: ${consentMode === 'grant' ? consentScopes.join(', ') : 'skipped'}` +
      (storageStatePath ? ` | storage-state: ${storageStatePath}` : ''),
    '',
    `## captured (${captured.length} of ${routes.length * VIEWPORTS.length})`,
    ...(captured.length === 0 ? ['- none'] : captured.map((r) => `- ${r}`)),
    '',
    `## not captured (${notCaptured.length})`,
    ...(notCaptured.length === 0 ? ['- none'] : notCaptured.map((r) => `- ${r}`)),
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

  if (mismatches.length > 0 && !allowRedirect) {
    console.error(
      `\n${mismatches.length} route(s) were never audited. This run does not tell you ` +
        `anything about them. Re-run with a session that can reach them, or pass ` +
        `--allow-redirect if you meant to.`,
    )
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(`visual-audit failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
