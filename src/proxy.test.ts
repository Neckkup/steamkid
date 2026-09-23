/**
 * The production teacher guard answers 404, and keeps answering it.
 *
 * `src/proxy.ts` hides `/teacher/*` on the production tier by rewriting to a
 * path no route serves, which is what makes Next.js answer with a real 404
 * instead of the 200-with-a-"not found"-body the in-page `notFound()` is stuck
 * with (PRO-99). That trick has exactly one silent failure mode: the day
 * somebody adds a `page.tsx` that matches the rewrite target, the production
 * guard quietly starts serving 200 again and nothing else in the repo notices.
 *
 * So assert the target stays unroutable, and assert the matcher still covers
 * the subtree it is supposed to cover.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HIDDEN_TEACHER_REWRITE_TARGET, config } from "./proxy";

const APP = join(fileURLToPath(new URL(".", import.meta.url)), "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry.startsWith(".")) return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** `src/app/teacher/review/page.tsx` → `["teacher", "review"]`. */
function routePatterns(): string[][] {
  return walk(APP)
    .filter((path) => /[/\\](page|route)\.tsx?$/.test(path))
    .map((path) =>
      path
        .slice(APP.length + 1)
        .replace(/(?:^|[/\\])(?:page|route)\.tsx?$/, "")
        .split(/[/\\]/)
        .filter((segment) => segment !== "" && !segment.startsWith("(")),
    );
}

function matches(target: readonly string[], pattern: readonly string[]): boolean {
  const catchAll = pattern.findIndex((segment) => segment.startsWith("[..."));
  if (catchAll >= 0) return target.length >= catchAll;
  if (target.length !== pattern.length) return false;
  return pattern.every((segment, index) => segment.startsWith("[") || segment === target[index]);
}

describe("production teacher guard", () => {
  const patterns = routePatterns();

  it("reads the app's routes", () => {
    expect(patterns.length).toBeGreaterThan(3);
  });

  it("rewrites to a path no route serves, so Next.js answers 404", () => {
    const segments = HIDDEN_TEACHER_REWRITE_TARGET.split("/").filter((s) => s !== "");
    const hit = patterns.find((pattern) => matches(segments, pattern));

    expect(
      hit,
      `${HIDDEN_TEACHER_REWRITE_TARGET} is now served by app/${hit?.join("/")}/page.tsx — the ` +
        `production guard would answer 200. Rename the target or move that route.`,
    ).toBeUndefined();
  });

  it("matches every teacher route, not just the ones that exist today", () => {
    expect(config.matcher).toContain("/teacher");
    expect(config.matcher).toContain("/teacher/:path*");

    // Every teacher page must fall inside the matcher above.
    const teacherRoutes = patterns.filter((pattern) => pattern[0] === "teacher");
    expect(teacherRoutes.length).toBeGreaterThan(0);
  });
});
