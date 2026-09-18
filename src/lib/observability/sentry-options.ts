import type { ErrorEvent } from "@sentry/nextjs";

import { redactDeep, scrubText } from "@/lib/privacy/redact";

/**
 * Shared Sentry options for every runtime (client, server, edge).
 *
 * Sentry is an external service, so the same rule as Langfuse applies: no
 * child's name, email, photo, or free-text answer may reach it. `sendDefaultPii`
 * stays off and `beforeSend` scrubs what the SDK collects anyway (URLs, request
 * bodies, breadcrumb messages, exception values).
 */
export const baseSentryOptions = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.APP_ENV ?? "local",
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  // Never let the SDK attach IPs, cookies, or request bodies on its own.
  sendDefaultPii: false,
  tracesSampleRate: process.env.APP_ENV === "production" ? 0.1 : 1.0,
};

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  // A user identity on an error event would tie a crash to a specific child.
  // Keep only the pseudonymous id the app sets deliberately, if any.
  if (event.user) {
    event.user = event.user.id ? { id: String(event.user.id) } : undefined;
  }

  if (event.request) {
    event.request = {
      ...event.request,
      url: event.request.url ? scrubText(event.request.url) : undefined,
      query_string: undefined,
      data: undefined,
      cookies: undefined,
      headers: undefined,
    };
  }

  if (event.extra) event.extra = redactDeep(event.extra) as Record<string, unknown>;

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => ({
      ...crumb,
      message: crumb.message ? scrubText(crumb.message) : undefined,
      data: crumb.data ? (redactDeep(crumb.data) as Record<string, unknown>) : undefined,
    }));
  }

  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((value) => ({
      ...value,
      value: value.value ? scrubText(value.value) : undefined,
    }));
  }

  return event;
}
