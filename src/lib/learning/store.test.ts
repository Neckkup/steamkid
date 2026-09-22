/**
 * PRO-42: reopening a project screen showed an empty box, so a child had no
 * route back to work they had just sent.
 *
 * The screen resumes from `latestSubmissionFor`. Picking the wrong record here
 * is worse than picking none — it would hand a child someone else's paragraph
 * to edit — so the selection rules are pinned rather than assumed.
 */

import { describe, expect, it } from "vitest";

import { latestSubmissionFor, type SubmissionRecord } from "./store";

let seq = 0;

function submission(
  overrides: Partial<SubmissionRecord> & { readonly draftsAt?: readonly string[] } = {},
): SubmissionRecord {
  const { draftsAt = ["2026-09-20T10:00:00.000Z"], ...rest } = overrides;
  seq += 1;
  return {
    id: `sub-${seq}`,
    learnerRef: "learner-1",
    lessonId: "lesson-1",
    itemId: "item-1",
    drafts: draftsAt.map((createdAt, index) => ({
      draftNo: index + 1,
      content: `draft ${index + 1} of sub-${seq}`,
      charCount: 10,
      createdAt,
    })),
    submittedAt: null,
    totalActiveMs: 0,
    correlationId: `corr-${seq}`,
    verdict: null,
    ...rest,
  };
}

describe("latestSubmissionFor", () => {
  it("finds nothing when the child has not written yet", () => {
    expect(latestSubmissionFor([], "item-1")).toBeUndefined();
  });

  it("ignores work written for a different project in the same lesson", () => {
    const other = submission({ itemId: "item-2" });

    expect(latestSubmissionFor([other], "item-1")).toBeUndefined();
  });

  it("picks the submission with the newest draft, not the first one stored", () => {
    const older = submission({ draftsAt: ["2026-09-20T10:00:00.000Z"] });
    const newer = submission({
      draftsAt: ["2026-09-20T09:00:00.000Z", "2026-09-21T18:00:00.000Z"],
    });

    // Either order in, same record out: a store may return rows unsorted.
    expect(latestSubmissionFor([older, newer], "item-1")?.id).toBe(newer.id);
    expect(latestSubmissionFor([newer, older], "item-1")?.id).toBe(newer.id);
  });

  it("skips a submission with no drafts, which has nothing to show a child", () => {
    const empty = submission({ draftsAt: [] });
    const written = submission({ draftsAt: ["2026-09-19T08:00:00.000Z"] });

    expect(latestSubmissionFor([empty], "item-1")).toBeUndefined();
    expect(latestSubmissionFor([empty, written], "item-1")?.id).toBe(written.id);
  });

  it("returns a submitted record so the screen can link to its result page", () => {
    const sent = submission({ submittedAt: "2026-09-21T18:05:00.000Z" });

    expect(latestSubmissionFor([sent], "item-1")?.submittedAt).toBe("2026-09-21T18:05:00.000Z");
  });
});
