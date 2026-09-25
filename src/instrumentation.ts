import * as Sentry from "@sentry/nextjs";

import { baseSentryOptions, scrubEvent } from "@/lib/observability/sentry-options";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Wire the Postgres-backed learning store before the first request is handled.
    // Safe to import here: pg is a Node.js module and cannot load in the edge runtime.
    const { initLearningStore } = await import("@/lib/learning/store-runtime");
    initLearningStore();
  }

  if (!baseSentryOptions.enabled) return;

  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({ ...baseSentryOptions, beforeSend: scrubEvent });
  }
}

export const onRequestError = Sentry.captureRequestError;
