/**
 * Synthetic learners and a synthetic lesson, for tests and local demos.
 *
 * Every value here is invented. No row from a real child appears in this repo,
 * in a test, in a comment or in a log — the whole point of `public_ref` is that
 * we never have to make that judgement call twice.
 */

import { uuidv7 } from "@/lib/ids";
import type { SqlExecutor } from "@/lib/db/sql";

import { HEARTBEAT_INTERVAL_MS } from "./activity";
import type { EventEnvelope } from "./envelope";
import { compileEventPayloadSchema } from "./payload-schema";
import { REGISTRY_VERSION } from "./registry";
import registryFile from "./event-registry.v1.json";

export interface SeededLearner {
  readonly learnerId: string;
  readonly publicRef: string;
  readonly guardianUserId: string;
}

/** Seed `events.event_registry` the way `scripts/seed-event-registry.ts` does. */
export async function seedEventRegistry(sql: SqlExecutor): Promise<number> {
  const file = registryFile as unknown as {
    events: readonly Parameters<typeof compileEventPayloadSchema>[0][];
  };

  for (const definition of file.events) {
    await sql.query(
      `INSERT INTO events.event_registry (
         event_name, event_version, event_group, trigger_description, payload_schema,
         pii_class, retention_days, exportable, required_consent_scope, registry_version
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
       ON CONFLICT (event_name, event_version) DO NOTHING`,
      [
        definition.name,
        definition.version,
        definition.group,
        definition.trigger,
        JSON.stringify(compileEventPayloadSchema(definition)),
        definition.piiClass,
        definition.retentionDays,
        definition.exportable,
        definition.requiredConsentScope ?? "behaviour_events",
        REGISTRY_VERSION,
      ],
    );
  }
  return file.events.length;
}

/**
 * A guardian, a learner, and whichever consent scopes were granted.
 *
 * `scopes` is the whole point of the helper: a test that wants "this child's
 * guardian said no to behaviour tracking" says so by leaving the scope out,
 * and the database then behaves exactly as it would for a real family.
 */
export async function seedLearner(
  sql: SqlExecutor,
  options: {
    readonly email: string;
    readonly scopes: readonly string[];
    readonly gradeBand?: string;
    readonly displayName?: string;
  },
): Promise<SeededLearner> {
  const guardianUserId = uuidv7();
  const learnerId = uuidv7();
  const publicRef = uuidv7();

  await sql.query(
    `INSERT INTO identity.user_account (id, role, email, auth_provider, auth_subject_id, display_name)
     VALUES ($1::uuid, 'guardian', $2, 'fixture', $3, $4)`,
    [guardianUserId, options.email, `fixture:${guardianUserId}`, "ผู้ปกครองทดสอบ"],
  );

  await sql.query(
    `INSERT INTO app.learner (id, public_ref, grade_band) VALUES ($1::uuid, $2::uuid, $3)`,
    [learnerId, publicRef, options.gradeBand ?? "p5"],
  );

  await sql.query(
    `INSERT INTO identity.learner_profile (learner_id, display_name, birth_year_month)
     VALUES ($1::uuid, $2, $3::date)`,
    [learnerId, options.displayName ?? "น้องทดสอบ", "2015-06-01"],
  );

  await sql.query(
    `INSERT INTO app.guardian_link (guardian_user_id, learner_id, relationship, verified_at)
     VALUES ($1::uuid, $2::uuid, 'parent', now())`,
    [guardianUserId, learnerId],
  );

  for (const scope of options.scopes) {
    await sql.query(
      `INSERT INTO app.consent_record
         (id, learner_id, guardian_user_id, policy_version, scope, granted, method, evidence)
       VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-09-19.1', $4, true,
               'guardian_web_verified_email', $5::jsonb)`,
      [
        uuidv7(),
        learnerId,
        guardianUserId,
        scope,
        JSON.stringify({ ip_hash: "fixture-ip-hash", ua_hash: "fixture-ua-hash", ui_version: "1" }),
      ],
    );
  }

  return { learnerId, publicRef, guardianUserId };
}

/** How long the synthetic visit lasts, wall clock. */
const JOURNEY_DURATION_MS = 320_000;

const HEARTBEAT_MS = HEARTBEAT_INTERVAL_MS;

/** The one heartbeat window where the child's attention wandered. */
const DISTRACTED_AT_MS = 90_000;
const DISTRACTED_ACTIVE_MS = 8_000;

/**
 * What the heartbeats add up to, and therefore what `session.ended.active_ms`
 * must claim.
 *
 * Kept as a derived constant so the client's own figure agrees with the server's
 * reconstruction: a disagreement is a `client_active_ms_mismatch` anomaly, and a
 * fixture should not manufacture one it does not mean to demonstrate.
 */
const JOURNEY_ACTIVE_MS = (() => {
  let total = 0;
  for (let at = HEARTBEAT_MS; at <= JOURNEY_DURATION_MS - HEARTBEAT_MS; at += HEARTBEAT_MS) {
    total += at === DISTRACTED_AT_MS ? DISTRACTED_ACTIVE_MS : HEARTBEAT_MS;
  }
  return total;
})();

/** The ids one visit refers to. Minted together so a journey is reproducible. */
export interface JourneyIds {
  readonly sessionId: string;
  readonly lessonId: string;
  readonly itemId: string;
  readonly exerciseSetId: string;
  readonly attemptId: string;
  readonly submissionId: string;
  readonly verdictId: string;
  /** The id that also becomes the Langfuse trace id for the grading call. */
  readonly correlationId: string;
}

export function journeyIds(atMs: number): JourneyIds {
  return {
    sessionId: uuidv7(atMs),
    lessonId: uuidv7(atMs),
    itemId: uuidv7(atMs),
    exerciseSetId: uuidv7(atMs),
    attemptId: uuidv7(atMs),
    submissionId: uuidv7(atMs),
    verdictId: uuidv7(atMs),
    correlationId: uuidv7(atMs),
  };
}

/**
 * One child's visit, in the order it happened: arrive, open a lesson, watch the
 * video, scroll, start the exercise, hesitate, change their mind, ask for a
 * hint, answer, read the feedback, revise, submit, leave.
 *
 * Shared between `pg-sink.test.ts` and `scripts/verify-behaviour-pipeline.ts` so
 * the journey the suite asserts on and the journey the verification script
 * prints are the same eighteen events. Two copies would drift, and the printed
 * one is what we show people as evidence.
 *
 * Every value is invented. `t0` is passed in so partition boundaries are never a
 * coin toss.
 */
export function buildLearnerJourney(t0: number, ids: JourneyIds): EventEnvelope[] {
  const { sessionId, lessonId, itemId, submissionId, correlationId } = ids;
  const session = { session_id: sessionId };
  const ctx = { session_id: sessionId, lesson_id: lessonId };
  const item = { ...ctx, item_id: itemId };

  const actions = [
    makeEvent(t0 + 0, 1, "session.started", {
      device_class: "tablet",
      app_version: "0.1.0",
      referrer_class: "direct",
      tz_offset_min: 420,
      client_clock_at: new Date(t0).toISOString(),
    }, session),
    makeEvent(t0 + 1_000, 2, "auth.signed_in", { method: "profile_switch", guardian_assisted: true }, session),
    makeEvent(t0 + 4_000, 3, "page.viewed", { route: "/lesson/force-and-motion", lesson_id: lessonId, entry_source: "browse" }, ctx),
    makeEvent(t0 + 5_000, 4, "lesson.opened", { lesson_id: lessonId, content_version: 1, entry_source: "browse", open_index_for_learner: 1 }, ctx),
    makeEvent(t0 + 20_000, 5, "media.play", { media_id: "intro-clip", lesson_id: lessonId, position_ms: 0, duration_ms: 90_000 }, ctx),
    makeEvent(t0 + 65_000, 6, "media.progress", { media_id: "intro-clip", lesson_id: lessonId, pct: 50, position_ms: 45_000 }, ctx),
    makeEvent(t0 + 112_000, 7, "media.completed", { media_id: "intro-clip", lesson_id: lessonId, watched_ratio: 0.98, seek_count: 0, pause_count: 1, replay_index: 0 }, ctx),
    makeEvent(t0 + 130_000, 8, "lesson.scroll_depth", { lesson_id: lessonId, pct: 75, ms_since_open: 125_000, active_ms_since_open: 118_000 }, ctx),
    makeEvent(t0 + 150_000, 9, "exercise.started", { lesson_id: lessonId, exercise_set_id: ids.exerciseSetId, item_count: 3, attempt_of_set: 1 }, ctx),
    makeEvent(t0 + 152_000, 10, "item.presented", { item_id: itemId, attempt_no: 1, difficulty: 2, skill_weights: { "SCI.EXPLAIN_EVIDENCE": 1 } }, item),
    makeEvent(t0 + 171_000, 11, "item.first_input", { item_id: itemId, attempt_no: 1, latency_ms_since_presented: 19_000, active_latency_ms: 17_500 }, item),
    makeEvent(t0 + 188_000, 12, "item.answer_changed", { item_id: itemId, attempt_no: 1, change_index: 1, from_hash: "a1b2c3d4e5f60718", to_hash: "1728394a5b6c7d8e", ms_since_presented: 36_000, char_delta: 12 }, item),
    makeEvent(t0 + 205_000, 13, "hint.requested", { item_id: itemId, attempt_no: 1, hint_index: 1, ms_since_presented: 53_000, active_ms_since_presented: 49_000, had_input: true }, item),
    makeEvent(t0 + 232_000, 14, "item.answer_submitted", { item_id: itemId, attempt_id: ids.attemptId, attempt_no: 1, time_on_item_ms: 80_000, active_time_on_item_ms: 71_000, answer_changes: 1, hints_used: 1, correlation_id: correlationId }, { ...item, correlation_id: correlationId }),
    makeEvent(t0 + 236_000, 15, "feedback.viewed", { verdict_id: ids.verdictId, subject_type: "attempt", subject_id: itemId, ms_since_result_shown: 3_200, correlation_id: correlationId }, { ...ctx, correlation_id: correlationId }),
    makeEvent(t0 + 260_000, 16, "submission.draft_saved", { submission_id: submissionId, lesson_id: lessonId, draft_no: 1, char_count: 148, content_hash: "9f8e7d6c5b4a3210", active_ms_since_last_draft: 21_000 }, { ...ctx, submission_id: submissionId }),
    makeEvent(t0 + 300_000, 17, "submission.submitted", { submission_id: submissionId, lesson_id: lessonId, draft_count: 2, total_active_ms: 61_000, ms_since_first_draft: 40_000, correlation_id: correlationId }, { ...ctx, submission_id: submissionId, correlation_id: correlationId }),
    makeEvent(t0 + JOURNEY_DURATION_MS, 18, "session.ended", { reason: "explicit_logout", duration_ms: JOURNEY_DURATION_MS, active_ms: JOURNEY_ACTIVE_MS }, session),
  ];

  const merged = [...actions, ...journeyHeartbeats(t0, ids)].sort(
    (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at),
  );

  // `client_seq` is the per-session counter the server orders by, so it has to
  // be assigned across the merged stream. The placeholder numbers above only
  // keep the action list readable.
  return merged.map((event, index) => ({ ...event, client_seq: index + 1 }));
}

/**
 * The heartbeats a real tablet would have sent during that visit.
 *
 * Without them the journey is not a realistic session, and saying so matters:
 * `reconstructSession` builds active time *only* from heartbeat deltas, and
 * `isScorableSession` requires at least one. A fixture with no heartbeats
 * reconstructs to zero active milliseconds, is therefore unscorable, and is
 * therefore excluded from `ml.v_behaviour_sequences` — so a pipeline that works
 * would look like one that exports nothing.
 */
function journeyHeartbeats(t0: number, ids: JourneyIds): EventEnvelope[] {
  const beats: EventEnvelope[] = [];

  for (let at = HEARTBEAT_MS; at <= JOURNEY_DURATION_MS - HEARTBEAT_MS; at += HEARTBEAT_MS) {
    beats.push(
      makeEvent(
        t0 + at,
        // Renumbered by the caller once the streams are merged.
        0,
        "session.heartbeat",
        {
          // One window where the child looked away. Every delta stays inside the
          // wall-clock gap that produced it, so none of them is clamped.
          active_ms_delta: at === DISTRACTED_AT_MS ? DISTRACTED_ACTIVE_MS : HEARTBEAT_MS,
          route: "/lesson/force-and-motion",
          // Before the lesson is open there is no lesson to attribute time to.
          lesson_id: at >= 5_000 ? ids.lessonId : null,
          item_id: at >= 152_000 && at <= 232_000 ? ids.itemId : null,
        },
        { session_id: ids.sessionId, lesson_id: at >= 5_000 ? ids.lessonId : null },
      ),
    );
  }

  return beats;
}

/** Build an envelope with a UUIDv7 `event_id` stamped at `atMs`. */
export function makeEvent(
  atMs: number,
  clientSeq: number,
  eventName: string,
  payload: Record<string, unknown>,
  context: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    event_id: uuidv7(atMs),
    client_seq: clientSeq,
    event_name: eventName,
    event_version: 1,
    occurred_at: new Date(atMs).toISOString(),
    session_id: context.session_id ?? uuidv7(atMs),
    registry_version: REGISTRY_VERSION,
    payload,
    ...context,
  };
}
