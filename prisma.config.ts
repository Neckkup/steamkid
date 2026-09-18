import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration (migrate, generate, studio).
 *
 * Migrations prefer `DIRECT_URL`, because a pooled connection cannot run DDL
 * reliably; they fall back to `DATABASE_URL` for a plain local Postgres where
 * the two are the same.
 *
 * The URL is resolved leniently on purpose: `prisma generate` must work in CI
 * and in a fresh clone with no database configured. Commands that actually
 * touch the database still fail loudly when neither variable is set.
 */
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  ...(url ? { datasource: { url } } : {}),
});
