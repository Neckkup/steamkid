/**
 * The build identifier that goes in `session.started.app_version`.
 *
 * A literal rather than a read of `process.env`: `src/lib/env.ts` is the single
 * place that touches the environment and it is a server module, so importing it
 * from a client component would drag server-only configuration into the bundle.
 * Bump this with each shipped change to the child-facing app; it is how a
 * behaviour anomaly gets tied to the release that caused it.
 */
export const APP_VERSION = "0.1.0-mvp";
