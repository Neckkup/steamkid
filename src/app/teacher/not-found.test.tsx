/**
 * The teacher 404 talks to an adult, and says the system is not broken.
 *
 * PRO-98 D2/D3: a mistyped verdict id used to reach Postgres, throw "invalid
 * input syntax for type uuid", and land in the error boundary — so a teacher
 * saw the *outage* screen for a typo. The fix routes it to `notFound()`
 * instead, which only helps if what renders there answers the question the
 * teacher now has: "did I mistype, or is steamkid down?". The app-wide 404
 * could not, because it is written to a ten-year-old ("หนู") and its only way
 * out is the child's lesson list.
 *
 * The production branch is a separate claim: on that tier `guard.ts` 404s every
 * teacher route, so this boundary is also what a stranger probing URLs sees.
 * It must not advertise the teacher surface or offer a link into it.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

async function renderAt(appEnv: string): Promise<string> {
  vi.stubEnv("APP_ENV", appEnv);
  vi.resetModules();
  const { default: TeacherNotFound } = await import("./not-found");
  return renderToStaticMarkup(<TeacherNotFound />);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the 404 a teacher lands on", () => {
  for (const appEnv of ["local", "preview"]) {
    it(`sends the teacher back to their own queue on ${appEnv}`, async () => {
      const markup = await renderAt(appEnv);

      expect(markup).toContain('href="/teacher/review"');
      // The child's lesson list is not where a teacher's work is.
      expect(markup).not.toContain('href="/learn"');
    });

    it(`does not call a teacher "หนู" on ${appEnv}`, async () => {
      expect(await renderAt(appEnv)).not.toContain("หนู");
    });

    it(`says a bad link is not an outage on ${appEnv}`, async () => {
      // The distinction the error boundary could not make. If this copy is
      // reworded, keep a sentence that separates "wrong link" from "down".
      expect(await renderAt(appEnv)).toContain("ไม่ใช่ระบบล่ม");
    });
  }

  it("offers nothing about teacher screens in production", async () => {
    const markup = await renderAt("production");

    expect(markup).not.toContain("/teacher");
    expect(markup).toContain('href="/"');
  });
});
