import * as Sentry from "@sentry/nextjs";

import { baseSentryOptions, scrubEvent } from "@/lib/observability/sentry-options";

if (baseSentryOptions.enabled) {
  Sentry.init({
    ...baseSentryOptions,
    beforeSend: scrubEvent,
    // Session Replay records what a child typed on screen. Off, permanently.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
