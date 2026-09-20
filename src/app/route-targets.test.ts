/**
 * Every internal link and `router.push` in the app points at a route that exists.
 *
 * PRO-47: `project-editor.tsx` pushed a child to `/results/${submissionId}`
 * for weeks while no such route existed, so the last step of the main flow —
 * pressing "ส่งงานของหนู" after twenty minutes of writing — was Next.js's bare
 * English 404. Nothing failed: not the build, not the types, not the tests. A
 * dead link is invisible to every check the repo had.
 *
 * This is the cheap check that makes it visible. It reads the app directory as
 * the source of truth for what routes exist, collects the targets the code
 * navigates to, and fails if one has nowhere to land. A `${...}` in a target is
 * a wildcard and only matches a dynamic segment.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const APP = join(SRC, "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry.startsWith(".")) return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** `src/app/learn/[slug]/project/page.tsx` → `["learn", "[slug]", "project"]`. */
function routePatterns(): string[][] {
  return walk(APP)
    .filter((path) => /[/\\]page\.tsx$/.test(path))
    .map((path) =>
      path
        .slice(APP.length + 1)
        // The root route is `page.tsx` with no leading segment at all.
        .replace(/(?:^|[/\\])page\.tsx$/, "")
        .split(/[/\\]/)
        // Route groups — `(marketing)` — are not part of the URL.
        .filter((segment) => segment !== "" && !segment.startsWith("(")),
    );
}

interface Target {
  readonly href: string;
  readonly file: string;
}

/**
 * `href="/learn"`, ``href={`/learn/${slug}`}`` and `router.push(...)` of both
 * shapes. Anything built from a variable alone is out of reach of a regex and
 * is left to review — the point is to catch the hard-coded dead link, which is
 * what PRO-47 was.
 */
const TARGET = /(?:href=\{?|router\.(?:push|replace)\()\s*(?:"([^"]*)"|`([^`]*)`)/g;

function linkTargets(): Target[] {
  const targets: Target[] = [];
  for (const file of walk(SRC)) {
    if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(TARGET)) {
      const href = match[1] ?? match[2] ?? "";
      // External links, anchors and API routes are somebody else's problem.
      if (!href.startsWith("/") || href.startsWith("/api/")) continue;
      targets.push({ href, file: file.slice(SRC.length) });
    }
  }
  return targets;
}

function matches(target: readonly string[], pattern: readonly string[]): boolean {
  const catchAll = pattern.findIndex((segment) => segment.startsWith("[..."));
  if (catchAll >= 0) return target.length >= catchAll;
  if (target.length !== pattern.length) return false;
  return pattern.every((segment, index) => {
    const dynamic = segment.startsWith("[");
    return dynamic ? true : segment === target[index];
  });
}

describe("internal navigation targets", () => {
  const patterns = routePatterns();

  it("finds the app's routes", () => {
    expect(patterns.length).toBeGreaterThan(3);
  });

  it.each(linkTargets())("$href in $file has a route", ({ href }) => {
    const segments = href
      .split("?")[0]
      .split("#")[0]
      .split("/")
      .filter((segment) => segment !== "");
    // A `${...}` interpolation can only be a dynamic segment's value.
    const normalized = segments.map((segment) => (segment.includes("${") ? "[x]" : segment));
    const wildcards = normalized.map((segment) => segment === "[x]");

    const hit = patterns.some(
      (pattern) =>
        matches(normalized, pattern) &&
        pattern.every((segment, index) => !wildcards[index] || segment.startsWith("[")),
    );
    expect(hit, `no route matches ${href}`).toBe(true);
  });
});
