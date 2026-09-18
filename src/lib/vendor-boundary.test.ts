import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Executable guard for the hard exclusions in `docs/adr/0003-managed-postgres-provider.md`.
 *
 * We host Postgres on Supabase, but we use it as a plain Postgres endpoint: one
 * connection string, consumed by Prisma. The moment Supabase Auth, Storage,
 * Realtime, or PostgREST enters the dependency tree, the provider stops being a
 * swap (`pg_dump`, change two env vars) and becomes the vendor coupling that
 * ADR 0001 rejected on purpose — with children's data on the wrong side of it.
 *
 * That boundary is worth more as a failing test than as a paragraph nobody reads,
 * so this asserts it in CI rather than trusting review to catch the import.
 */

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const declaredDependencies = [
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
];

describe("database vendor boundary (ADR 0003)", () => {
  it("does not depend on the Supabase client bundle", () => {
    const offenders = declaredDependencies.filter(
      (name) => name === "@supabase" || name.startsWith("@supabase/"),
    );

    expect(
      offenders,
      "Supabase is our Postgres host, not our application platform. Adopting the " +
        "Supabase SDK couples auth/storage to the vendor and breaks the low " +
        "migration cost recorded in ADR 0003. Reach the database through Prisma " +
        "and DATABASE_URL/DIRECT_URL instead, or amend ADR 0003 first.",
    ).toEqual([]);
  });

  it("still reaches Postgres through the Prisma pg adapter", () => {
    // If this ever flips, the ADR 0003 migration-cost table is no longer true and
    // the exclusion test above is guarding a door that has already moved.
    expect(declaredDependencies).toContain("@prisma/adapter-pg");
    expect(declaredDependencies).toContain("pg");
  });
});
