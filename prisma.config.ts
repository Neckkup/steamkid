import { defineConfig } from "prisma/config";

import { resolveMigrateUrl, resolveRuntimeUrl } from "./src/lib/db/connection-env";

/**
 * Prisma CLI configuration (migrate, generate, studio).
 *
 * Migrations take the migrator URL, because a pooled connection cannot run DDL
 * reliably and because the runtime role is refused `42501` on every DDL
 * statement by design; they fall back to the runtime URL for a plain local
 * Postgres where the two are the same single-role database.
 *
 * Both halves accept two names — `MIGRATE_DATABASE_URL` before `DIRECT_URL`,
 * `RUNTIME_DATABASE_URL` before `DATABASE_URL`. See
 * `src/lib/db/connection-env.ts`; this file cannot import `src/lib/env.ts`,
 * which is why the precedence lives in a module with no dependencies.
 *
 * The URL is resolved leniently on purpose: `prisma generate` must work in CI
 * and in a fresh clone with no database configured. Commands that actually
 * touch the database still fail loudly when no variable is set.
 */
const url = (resolveMigrateUrl(process.env) ?? resolveRuntimeUrl(process.env))?.url;

export default defineConfig({
  schema: "prisma/schema.prisma",
  ...(url ? { datasource: { url } } : {}),
});
