/**
 * PRO-99 check: the teacher-route status contract, per tier.
 *
 * This is the executable form of the table in
 * `docs/adr/0006-teacher-route-status-codes.md`. It exists because the whole
 * point of PRO-99 was that "production must 404 on /teacher" could not be
 * asserted from outside the app — so the fix is not finished until the
 * assertion is written down somewhere a machine runs it.
 *
 * The two tiers assert deliberately different things, and that asymmetry is the
 * decision, not an oversight:
 *
 *   production      — a real 404 on the whole subtree. This is a privacy
 *                     control (no teacher sign-in yet, PRO-12), enforced in
 *                     `src/proxy.ts` before anything renders.
 *   local, preview  — 200 with a "not found" body. `src/app/teacher/loading.tsx`
 *                     streams before the page can set a status, and we keep the
 *                     skeleton. Assert the body here, never the status.
 *
 *   BASE_URL=https://... TIER=production npx tsx scripts/pro99-check.ts
 *
 * TIER defaults to `local`. `preview` behaves the same as `local`.
 */

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const TIER = process.env.TIER ?? 'local'

/** Well formed, and no row will ever carry it. */
const ABSENT_ID = '00000000-0000-7000-8000-000000000000'

const NOT_FOUND_COPY = 'ไม่เจอหน้านี้'

let failed = false

function ok(label: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failed = true
}

async function get(path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${BASE}${path}`, { redirect: 'manual' })
  return { status: response.status, body: await response.text() }
}

async function main(): Promise<void> {
  console.log(`PRO-99 teacher status contract — ${BASE} (TIER=${TIER})\n`)

  // Control. Without it, "everything 404s" reads as a passing guard when the
  // site is simply down.
  const learn = await get('/learn')
  ok('/learn serves the app', learn.status === 200, `status ${learn.status}`)

  const teacherPaths = [
    '/teacher',
    '/teacher/review',
    `/teacher/review/${ABSENT_ID}`,
    '/teacher/review/not-a-uuid',
    `/teacher/${ABSENT_ID}`,
  ]

  if (TIER === 'production') {
    for (const path of teacherPaths) {
      const { status } = await get(path)
      ok(`${path} is 404`, status === 404, `status ${status}`)
    }

    // The guard is only worth having if it does not announce itself. Compare
    // against the 404 any unknown URL gets: the teacher body may echo the path
    // the caller typed, but must not carry our copy for teachers or the
    // internal rewrite target.
    const hidden = await get(`/teacher/review/${ABSENT_ID}`)
    ok(
      'the production 404 does not reveal that teacher screens exist',
      !hidden.body.includes('surface-not-served') && !hidden.body.includes('ครู'),
    )
    return
  }

  // local and preview: the screens render, and a bad id is a soft 404.
  const root = await get('/teacher')
  ok('/teacher renders for review', root.status === 200, `status ${root.status}`)

  for (const path of [`/teacher/review/${ABSENT_ID}`, '/teacher/review/not-a-uuid']) {
    const { status, body } = await get(path)
    ok(`${path} says "${NOT_FOUND_COPY}"`, body.includes(NOT_FOUND_COPY))
    // Asserted, not ignored: a 404 here would mean someone extended the proxy
    // guard past production, or deleted the teacher loading skeletons.
    ok(
      `${path} is a soft 404 (200 by design, see ADR 0006)`,
      status === 200,
      `status ${status}`,
    )
  }
}

main()
  .then(() => {
    if (failed) process.exitCode = 1
    console.log(`\n${failed ? 'FAILED' : 'OK'}`)
  })
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
