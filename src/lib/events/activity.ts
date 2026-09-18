/**
 * Active time — the difference between "a child was learning" and "a tab was
 * open while the family had dinner".
 *
 * Every growth formula in PRO-3 reads `active_ms`, never `dwell_ms`. Time only
 * accrues while the tab is visible *and* the child has interacted within the
 * last two minutes; a `lesson.closed` with 40 minutes of dwell and 3 minutes of
 * active time is a real and common shape, and reporting the 40 would quietly
 * corrupt every skill score built on top of it.
 *
 * Pure and clock-injected: no timers, no `document`, no globals. The browser
 * layer feeds it events, and the tests feed it numbers.
 */

/** No interaction for this long ends the active stretch. From PRO-3. */
export const INTERACTION_TIMEOUT_MS = 120_000;

/** `session.heartbeat` cadence from PRO-3. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

export interface ActivityClockOptions {
  /** A page that loads in a background tab starts inactive. */
  readonly visible?: boolean;
  readonly interactionTimeoutMs?: number;
}

export class ActivityClock {
  private accumulatedMs = 0;
  private takenMs = 0;
  private activeSince: number | null;
  private lastInteractionAt: number;
  private visible: boolean;
  private readonly timeoutMs: number;

  /** The page load that created the clock counts as the first interaction. */
  constructor(startedAt: number, options: ActivityClockOptions = {}) {
    this.visible = options.visible ?? true;
    this.timeoutMs = options.interactionTimeoutMs ?? INTERACTION_TIMEOUT_MS;
    this.lastInteractionAt = startedAt;
    this.activeSince = this.visible ? startedAt : null;
  }

  /** Any keypress, pointer, scroll or touch. Cheap enough to call on every one. */
  markInteraction(now: number): void {
    this.advance(now);
    this.lastInteractionAt = now;
    if (this.visible && this.activeSince === null) {
      this.activeSince = now;
    }
  }

  setVisible(visible: boolean, now: number): void {
    this.advance(now);
    this.visible = visible;
    if (!visible) {
      this.activeSince = null;
    } else if (now - this.lastInteractionAt < this.timeoutMs) {
      this.activeSince = now;
    }
  }

  isActive(now: number): boolean {
    return this.visible && now - this.lastInteractionAt < this.timeoutMs;
  }

  /** Total active milliseconds since the clock started. */
  activeMs(now: number): number {
    this.advance(now);
    return this.accumulatedMs;
  }

  /** Active milliseconds since the previous call — the heartbeat's delta. */
  takeActiveDelta(now: number): number {
    const total = this.activeMs(now);
    const delta = total - this.takenMs;
    this.takenMs = total;
    return delta;
  }

  private advance(now: number): void {
    if (this.activeSince === null) return;

    // The stretch ends where the child stopped interacting, not where the
    // clock happens to be read.
    const endsAt = Math.min(now, this.lastInteractionAt + this.timeoutMs);
    if (endsAt > this.activeSince) {
      this.accumulatedMs += endsAt - this.activeSince;
    }
    this.activeSince = this.isActive(now) ? now : null;
  }
}

/**
 * A stopwatch scoped to one thing on screen — a lesson section, a single
 * exercise item — sharing the session's notion of "active".
 */
export class ActiveSpan {
  private readonly startedAt: number;
  private readonly startActiveMs: number;

  constructor(
    private readonly clock: ActivityClock,
    now: number,
  ) {
    this.startedAt = now;
    this.startActiveMs = clock.activeMs(now);
  }

  /** Wall-clock milliseconds since the span opened. */
  dwellMs(now: number): number {
    return Math.max(0, now - this.startedAt);
  }

  /** Milliseconds the child was actually here. */
  activeMs(now: number): number {
    return Math.max(0, this.clock.activeMs(now) - this.startActiveMs);
  }
}
