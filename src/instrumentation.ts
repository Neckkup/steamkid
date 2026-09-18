import * as Sentry from "@sentry/nextjs";

import { baseSentryOptions, scrubEvent } from "@/lib/observability/sentry-options";

export async function register() {
  if (!baseSentryOptions.enabled) return;

  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({ ...baseSentryOptions, beforeSend: scrubEvent });
  }
}

export const onRequestError = Sentry.captureRequestError;
