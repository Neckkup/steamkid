/**
 * Teacher-surface guard — proxy shape and routing coverage.
 *
 * The proxy now uses session-based auth (PRO-197) rather than the production-
 * only 404 rewrite (ADR 0006, superseded by ADR 0010). These tests verify:
 *
 * 1. The matcher still covers every teacher route.
 * 2. The proxy redirects unsigned-in visitors to /signin.
 * 3. The proxy rewrites non-teachers to /forbidden (status 403).
 * 4. The proxy passes through for teachers.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { NextRequest, NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config, proxy } from "./proxy";

// Controllable session for the auth behaviour tests.
let authSession: { uid: string; role: string } | null = null;

vi.mock("@/auth", () => ({
  auth: vi.fn().mockImplementation(async () => authSession),
}));

const APP = join(fileURLToPath(new URL(".", import.meta.url)), "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry.startsWith(".")) return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

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

function makeRequest(path: string) {
  return new NextRequest(`https://steamkid.test${path}`);
}

afterEach(() => {
  authSession = null;
  vi.clearAllMocks();
});

describe("teacher proxy — matcher coverage", () => {
  const patterns = routePatterns();

  it("reads the app's routes", () => {
    expect(patterns.length).toBeGreaterThan(3);
  });

  it("matches every teacher route, not just the ones that exist today", () => {
    expect(config.matcher).toContain("/teacher");
    expect(config.matcher).toContain("/teacher/:path*");

    const teacherRoutes = patterns.filter((pattern) => pattern[0] === "teacher");
    expect(teacherRoutes.length).toBeGreaterThan(0);
  });
});

describe("teacher proxy — auth behaviour", () => {
  it("redirects an unauthenticated visitor to /signin", async () => {
    authSession = null;
    const response = await proxy(makeRequest("/teacher/review"));
    expect(response).toBeInstanceOf(NextResponse);
    expect(response?.status).toBe(307);
    const location = response?.headers.get("location") ?? "";
    expect(location).toContain("/signin");
    expect(location).toContain("callbackUrl");
  });

  it("rewrites a non-teacher to /forbidden with status 403", async () => {
    authSession = { uid: "uid-1", role: "guardian" };
    const response = await proxy(makeRequest("/teacher/review"));
    expect(response?.status).toBe(403);
  });

  it("passes through for a teacher", async () => {
    authSession = { uid: "uid-1", role: "teacher" };
    const response = await proxy(makeRequest("/teacher/review"));
    // NextResponse.next() has status 200
    expect(response?.status).toBe(200);
  });
});
