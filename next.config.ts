import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fail the build on type errors rather than shipping a broken preview.
  typescript: { ignoreBuildErrors: false },
  /**
   * PGlite ships a WASM binary and is only reached by the opt-in local demo
   * database (`src/lib/growth/dev-db.ts`, `STEAMKID_DEV_DB=pglite`). Marking it
   * external keeps the bundler from trying to trace that binary into a server
   * bundle for a code path no deployed tier ever takes.
   */
  serverExternalPackages: ["@electric-sql/pglite"],
};

const sentryEnabled = Boolean(
  process.env.SENTRY_ORG && process.env.SENTRY_PROJECT && process.env.SENTRY_AUTH_TOKEN,
);

// Source-map upload only runs where the Sentry credentials exist, so a local
// checkout or a fork build never needs them.
export default sentryEnabled
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: true,
      // Strip uploaded source maps from the public bundle.
      sourcemaps: { deleteSourcemapsAfterUpload: true },
      disableLogger: true,
    })
  : nextConfig;
