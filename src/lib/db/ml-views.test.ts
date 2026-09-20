/**
 * The export surface carries no identity, by construction.
 *
 * data-schema §6: a training export must exclude identity *structurally*, not
 * by remembering to leave a column out of a SELECT. The structure that enforces
 * it is the `ml` schema — every exported view projects `public_ref` and joins
 * consent, so "did we filter identity out of this file" is a property of the
 * view definition rather than a property of the query someone wrote that day.
 *
 * This file is the check that the structure still holds. It reads the catalog of
 * the database the migrations actually produce, so a future migration that adds
 * `display_name` to an export, or adds a whole new `ml` view that forgets the
 * consent join, fails here instead of in a file we have already handed over.
 *
 * `prisma/migrations/20260919000300_app_domain_ml_views/migration.sql` and
 * `migrations.ts` both name this file as the thing that enforces the rule.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "./test-database";

/**
 * The one view allowed to expose `learner_id`.
 *
 * It is a join key, not an export: the other views need something to join on,
 * and `public_ref` cannot be that key because nothing in `app` or `events` has a
 * foreign key pointing at it. Its own comment says INTERNAL JOIN SURFACE.
 */
const JOIN_SURFACE = "v_consented_learner";

/**
 * Columns that identify a child or a guardian rather than describing learning.
 *
 * Deliberately matched by name against every `ml` column, because the failure
 * this guards against is someone adding one of these to a view in good faith —
 * a debugging aid that ships, and then an export file with a child's name in it.
 */
const IDENTITY_COLUMNS = [
  "display_name",
  "email",
  "birth_year_month",
  "birth_date",
  "auth_subject_id",
  "auth_provider",
  "guardian_user_id",
  "user_id",
  "ip_hash",
  "ua_hash",
  "evidence",
];

let db: TestDatabase;
let views: { view_name: string; definition: string }[];
let columns: { view_name: string; column_name: string }[];

beforeAll(async () => {
  db = await createTestDatabase();

  views = (
    await db.query<{ view_name: string; definition: string }>(
      `SELECT c.relname AS view_name, pg_get_viewdef(c.oid, true) AS definition
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'ml' AND c.relkind IN ('v', 'm')
       ORDER BY c.relname`,
    )
  ).rows;

  columns = (
    await db.query<{ view_name: string; column_name: string }>(
      `SELECT table_name AS view_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'ml'
       ORDER BY table_name, ordinal_position`,
    )
  ).rows;
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("the ml export surface", () => {
  it("exists, so the rest of these assertions are about something", () => {
    // If a rename empties this list the file would otherwise pass vacuously.
    expect(views.map((view) => view.view_name)).toContain(JOIN_SURFACE);
    expect(views.length).toBeGreaterThan(1);
    expect(columns.length).toBeGreaterThan(0);
  });

  it("exposes learner_id from the join surface and nowhere else", () => {
    const leaking = columns
      .filter((column) => column.column_name === "learner_id")
      .map((column) => column.view_name)
      .filter((viewName) => viewName !== JOIN_SURFACE);

    expect(leaking).toEqual([]);
  });

  it("names no identity column in any export view", () => {
    const leaking = columns
      .filter((column) => IDENTITY_COLUMNS.includes(column.column_name))
      .map((column) => `${column.view_name}.${column.column_name}`);

    expect(leaking).toEqual([]);
  });

  it("identifies the learner by public_ref in every export view", () => {
    const exports = views.filter((view) => view.view_name !== JOIN_SURFACE);

    for (const view of exports) {
      const own = columns.filter((column) => column.view_name === view.view_name);
      // `learner_ref` is the projected alias of `public_ref`; either name means
      // the rotatable pseudonym rather than an internal key.
      const refs = own.filter((column) => /^(learner_ref|public_ref)$/.test(column.column_name));
      expect(refs, `${view.view_name} must carry a pseudonymous learner reference`).toHaveLength(1);
    }
  });

  /**
   * The consent filter has to be in the view, not in the caller.
   *
   * Every export joins `v_consented_learner`, which is itself gated on a current
   * `training_use` grant. A new view that selected from `app.learner` directly
   * would still compile, still look right, and quietly export a child whose
   * guardian opted out — so the join is asserted rather than assumed.
   */
  it("routes every export through the consent-gated join surface", () => {
    const exports = views.filter((view) => view.view_name !== JOIN_SURFACE);
    expect(exports.length).toBeGreaterThan(0);

    for (const view of exports) {
      expect(view.definition, `${view.view_name} must join ml.${JOIN_SURFACE}`).toContain(
        JOIN_SURFACE,
      );
    }
  });

  it("gates the join surface on a current training_use grant", () => {
    const joinSurface = views.find((view) => view.view_name === JOIN_SURFACE)!;

    expect(joinSurface.definition).toContain("training_use");
    // Read through `consent_current`, never off the raw append-only log: the
    // latest row is the answer, and an earlier `granted = true` is not.
    expect(joinSurface.definition).toContain("consent_current");
  });
});
