/**
 * One place that turns a Postgres URL into `pg` connection options.
 *
 * Why this file exists: `sslmode=require` means two different things to the two
 * clients we run against the same URL.
 *
 * - `prisma migrate deploy` (Rust engine) reads it the libpq way: encrypt the
 *   connection, do not verify the certificate.
 * - `pg` / `pg-connection-string` reads it as an alias for `verify-full`, so it
 *   also checks the chain against Node's trust store.
 *
 * Supabase's Supavisor pooler presents a self-signed chain. The result was that
 * `prisma migrate deploy` applied all four migrations against
 * `aws-0-ap-southeast-1.pooler.supabase.com` while every `pg` caller — the
 * registry seed, the behaviour sink behind `POST /api/events`, and the Prisma
 * *runtime* client, which uses the `@prisma/adapter-pg` driver adapter and so is
 * `pg` too — died with `SELF_SIGNED_CERT_IN_CHAIN`. Migrations passing told us
 * nothing about whether the app could connect (PRO-68).
 *
 * So `sslmode` is resolved here, once, and every `pg` caller goes through it.
 *
 * ## The security boundary
 *
 * Not verifying the chain means the connection is encrypted but not
 * authenticated: anything that can occupy the network path can present its own
 * certificate. That is an accepted risk *only* while this database holds
 * synthetic and CI data. Set `PGSSLROOTCERT` to Supabase's project CA and this
 * helper verifies properly instead — that is the intended end state and it is a
 * precondition of the PRO-16 gate, not an optional hardening.
 */

import { readFileSync } from "node:fs";

import type { ClientConfig } from "pg";

/** `pg` connection options, with SSL resolved from the URL's `sslmode`. */
export type PgConnectionOptions = Pick<ClientConfig, "connectionString" | "ssl">;

/**
 * Build `pg` options from a Postgres URL, reading `sslmode` the libpq way.
 *
 * `sslmode` is stripped from the string we hand to `pg` so that
 * `pg-connection-string` cannot re-apply its own stricter reading on top.
 */
export function pgConnectionOptions(url: string): PgConnectionOptions {
  const parsed = new URL(url);
  const sslmode = parsed.searchParams.get("sslmode");
  parsed.searchParams.delete("sslmode");

  return {
    connectionString: parsed.toString(),
    ssl: resolveSsl(sslmode),
  };
}

function resolveSsl(sslmode: string | null): ClientConfig["ssl"] {
  if (sslmode === "disable") return false;

  // A pinned CA turns every encrypted mode into a verified one. Read eagerly so
  // a bad path fails at connect time with a clear error rather than silently
  // falling back to an unverified connection.
  const caPath = process.env.PGSSLROOTCERT;
  if (caPath) {
    return { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
  }

  if (sslmode === "verify-full" || sslmode === "verify-ca") {
    // The caller explicitly asked for verification and gave us no CA to verify
    // against. Honour the request and let the connection fail loudly rather
    // than quietly downgrading what they asked for.
    return { rejectUnauthorized: true };
  }

  // `require`, `prefer`, `allow`, or unset: encrypt, do not verify. This is what
  // the Prisma CLI already does with the same URL.
  return { rejectUnauthorized: false };
}
