"use client";

/**
 * The browser end of the behaviour pipe.
 *
 * `BehaviorTracker` (PRO-7) is pure and clock-injected on purpose — it owns
 * validation, batching and retry, and knows nothing about the DOM. This module
 * is the only place that connects it to a real browser: timers, visibility,
 * interaction listeners, and the unload beacon. Keeping that split means the
 * rules that protect a child's data are unit-tested without a browser, and the
 * browser wiring stays small enough to read in one sitting.
 *
 * Three things here are product requirements, not implementation taste:
 *
 *   1. **Nothing is emitted without the `behaviour_events` scope.** The tracker
 *      is constructed with the guardian's answer and drops its queue the moment
 *      consent is withdrawn.
 *   2. **A tracking failure is never visible to a child.** Every path through
 *      this file swallows its errors. A lesson must not break because an
 *      analytics POST did.
 *   3. **The last events of a session are the ones most often lost.** The queue
 *      is flushed with `sendBeacon` on `pagehide`, because a child closing the
 *      tab is exactly when `session.ended` has to survive.
 */

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ActivityClock, HEARTBEAT_INTERVAL_MS } from "../activity";
import type { EventContext, EventEnvelope } from "../envelope";
import { BehaviorTracker, FLUSH_INTERVAL_MS, nextHeartbeat } from "../tracker";
import { APP_VERSION } from "./app-version";

const EVENTS_ENDPOINT = "/api/events";

export interface Tracking {
  /** Queue an event. Returns whether it was accepted; callers may ignore it. */
  track(
    eventName: string,
    payload?: Readonly<Record<string, unknown>>,
    context?: EventContext,
  ): boolean;
  /** Shared active-time clock, so every screen measures "active" the same way. */
  readonly clock: ActivityClock;
  readonly consentGranted: boolean;
}

/**
 * The no-op used before the provider mounts and in tests that render a screen
 * on its own. A missing provider must not crash a lesson, so this is a silent
 * default rather than a thrown "used outside provider".
 */
const NOOP: Tracking = {
  track: () => false,
  clock: new ActivityClock(0, { visible: false }),
  consentGranted: false,
};

const TrackingContext = createContext<Tracking>(NOOP);

export function useTracking(): Tracking {
  return useContext(TrackingContext);
}

async function postBatch(batch: readonly EventEnvelope[]): Promise<boolean> {
  const response = await fetch(EVENTS_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: batch }),
    keepalive: true,
  });
  // 4xx means this batch will never be accepted; retrying it forever would
  // block everything behind it. 5xx (including the 503 the endpoint returns
  // while the PRO-7 sink is missing) is retried, which is why those events are
  // still in the queue when the store arrives.
  return response.ok || (response.status >= 400 && response.status < 500);
}

export function TrackingProvider({
  consentGranted,
  children,
}: {
  readonly consentGranted: boolean;
  readonly children: ReactNode;
}) {
  /**
   * The session is built in a `useState` initializer, not in an effect.
   *
   * React runs a child's effects before its parent's, so a tracker created in
   * this provider's mount effect would not exist yet when a lesson screen's own
   * effect fires `lesson.opened`. Those events are unbackfillable, so the
   * tracker has to exist by the time children render. A lazy initializer is the
   * one place that can do that and still be read-only during render — assigning
   * to a ref here is what `react-hooks/refs` refuses, and rightly: under
   * StrictMode's double render it is a second tracker and a second session id.
   */
  const [session] = useState(() => {
    const startedAt = Date.now();
    return {
      startedAt,
      clock: new ActivityClock(startedAt, {
        // A page restored into a background tab has not been read.
        visible: typeof document === "undefined" || document.visibilityState === "visible",
      }),
      tracker: new BehaviorTracker({
        sessionId: crypto.randomUUID(),
        transport: { send: postBatch },
        consentGranted,
        onViolation: (violation) => {
          // Field names and event names only — never a value. This is what turns
          // a mistyped event into a same-day fix instead of a hole in the data.
          if (process.env.NODE_ENV !== "production") {
            console.warn("[tracking] refused", violation);
          }
        },
      }),
    };
  });

  const { tracker, clock } = session;
  const pathname = usePathname();

  // Read inside the pagehide handler and the heartbeat, neither of which should
  // be torn down and re-registered on every navigation just to learn the route.
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  // Consent can change mid-session from the guardian screen.
  useEffect(() => {
    tracker.setConsent(consentGranted);
  }, [tracker, consentGranted]);

  // Session lifecycle: start, visibility, heartbeat, flush, and the beacon that
  // gets the tail of the session out of a closing tab.
  useEffect(() => {
    const startedAt = session.startedAt;

    tracker.track("session.started", {
      device_class: deviceClass(),
      app_version: APP_VERSION,
      referrer_class: referrerClass(),
      tz_offset_min: -new Date().getTimezoneOffset(),
      client_clock_at: new Date(startedAt).toISOString(),
    });

    const markInteraction = () => clock.markInteraction(Date.now());
    const interactionEvents = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    for (const name of interactionEvents) {
      window.addEventListener(name, markInteraction, { passive: true });
    }

    const onVisibilityChange = () => {
      const visible = document.visibilityState === "visible";
      clock.setVisible(visible, Date.now());
      tracker.track("app.visibility_changed", { state: visible ? "visible" : "hidden" });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const heartbeat = window.setInterval(() => {
      const payload = nextHeartbeat(clock, Date.now());
      if (!payload) return;
      tracker.track("session.heartbeat", {
        active_ms_delta: payload.active_ms_delta,
        route: pathnameRef.current,
        lesson_id: null,
        item_id: null,
      });
    }, HEARTBEAT_INTERVAL_MS);

    const flush = window.setInterval(() => void tracker.flush(), FLUSH_INTERVAL_MS);

    const onPageHide = () => {
      const now = Date.now();
      tracker.track("session.ended", {
        reason: "navigate_away",
        duration_ms: now - startedAt,
        active_ms: clock.activeMs(now),
      });
      beacon(tracker.drain());
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      for (const name of interactionEvents) {
        window.removeEventListener(name, markInteraction);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.clearInterval(heartbeat);
      window.clearInterval(flush);
    };
    // Deliberately once per mounted app: this is the session, not the route.
  }, [session, tracker, clock]);

  const track = useCallback<Tracking["track"]>(
    (eventName, payload, context) => {
      try {
        return tracker.track(eventName, payload, context);
      } catch {
        // Belt and braces. The tracker does not throw; a child's lesson does
        // not depend on that staying true.
        return false;
      }
    },
    [tracker],
  );

  const value = useMemo<Tracking>(
    () => ({ track, clock, consentGranted }),
    [track, clock, consentGranted],
  );

  return <TrackingContext.Provider value={value}>{children}</TrackingContext.Provider>;
}

/**
 * `page.viewed` on every client route change.
 *
 * Mounted once, next to the provider, rather than remembered per page — a
 * screen that forgets this call is a screen missing from every funnel, and the
 * data cannot be backfilled.
 */
export function RouteTracker() {
  const { track } = useTracking();
  const pathname = usePathname();

  useEffect(() => {
    track("page.viewed", {
      route: pathname,
      lesson_id: null,
      entry_source: "browse",
    });
  }, [track, pathname]);

  return null;
}

function beacon(events: readonly EventEnvelope[]): void {
  if (events.length === 0) return;
  const body = JSON.stringify({ events });
  try {
    if (navigator.sendBeacon?.(EVENTS_ENDPOINT, new Blob([body], { type: "application/json" }))) {
      return;
    }
    void fetch(EVENTS_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // The tab is closing. There is nothing useful left to do.
  }
}

/** `session.started.device_class`, by viewport rather than by user-agent string. */
function deviceClass(): "mobile" | "tablet" | "desktop" {
  const width = window.innerWidth;
  if (width < 640) return "mobile";
  if (width < 1024) return "tablet";
  return "desktop";
}

/**
 * Referrer bucketed to a class, never the URL.
 *
 * A full referrer can carry a search query a child typed, and the registry
 * declares this event `piiClass: "none"`.
 */
function referrerClass(): "direct" | "search" | "path_email" | "unknown" {
  const referrer = document.referrer;
  if (!referrer) return "direct";
  try {
    const host = new URL(referrer).hostname;
    if (host === window.location.hostname) return "direct";
    if (/(^|\.)(google|bing|duckduckgo|yahoo)\./.test(host)) return "search";
    return "unknown";
  } catch {
    return "unknown";
  }
}
