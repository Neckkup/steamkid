/**
 * Where a child's work is kept.
 *
 * PRO-3 `data-schema` puts this in `app.attempt`, `app.submission` and
 * `app.submission_draft`, and Backend creates them in PRO-7. This checkout has
 * no Postgres, so the same pattern `src/lib/events/sink.ts` uses is repeated
 * here: an interface, an in-memory implementation, and a single wiring point.
 *
 * Two properties are carried over from the SQL because they are behavioural,
 * not incidental, and losing them in the swap would be a silent regression:
 *
 *   - attempts are **append-only** and numbered per (learner, item); a retry is
 *     a new row, never an edit of the old one
 *   - every draft is kept, so `submission_draft` can show how a piece of work
 *     actually developed — that history is the training signal, not the
 *     final text
 *
 * `learnerRef` is the pseudonymous id from the session cookie. Nothing in here
 * takes a name, an email, or anything else a guardian typed.
 */

import { randomUUID } from "node:crypto";

import type { ItemResult } from "./grade";
import { answerCharCount } from "./text";

export interface AttemptRecord {
  readonly id: string;
  readonly learnerRef: string;
  readonly itemId: string;
  readonly lessonId: string;
  readonly attemptNo: number;
  readonly answer: unknown;
  readonly result: ItemResult | null;
  readonly normalizedScore: number | null;
  /** `deterministic` now; `ai` once PRO-8 grades written items. */
  readonly source: "deterministic" | "ai";
  readonly pendingAi: boolean;
  readonly timeOnItemMs: number;
  readonly activeTimeOnItemMs: number;
  readonly answerChanges: number;
  readonly hintsUsed: number;
  /** Becomes the Langfuse trace id when this work reaches the grader. */
  readonly correlationId: string;
  readonly submittedAt: string;
}

export interface DraftRecord {
  readonly draftNo: number;
  readonly content: string;
  readonly charCount: number;
  readonly createdAt: string;
}

export interface SubmissionRecord {
  readonly id: string;
  readonly learnerRef: string;
  readonly lessonId: string;
  readonly itemId: string;
  readonly drafts: readonly DraftRecord[];
  readonly submittedAt: string | null;
  readonly totalActiveMs: number;
  readonly correlationId: string;
  /** Null until the PRO-8 grading engine writes one. Never a placeholder score. */
  readonly verdict: null;
}

export interface ConsentState {
  readonly policyVersion: string;
  readonly scopes: readonly string[];
  readonly grantedAt: string;
}

export interface LearningStore {
  nextAttemptNo(learnerRef: string, itemId: string): Promise<number>;
  recordAttempt(attempt: AttemptRecord): Promise<void>;
  listAttempts(learnerRef: string, lessonId: string): Promise<readonly AttemptRecord[]>;

  /** Creates the submission on the first draft; appends on every later one. */
  saveDraft(input: {
    learnerRef: string;
    lessonId: string;
    itemId: string;
    submissionId: string | null;
    content: string;
    activeMsDelta: number;
  }): Promise<SubmissionRecord>;
  submit(learnerRef: string, submissionId: string): Promise<SubmissionRecord | undefined>;
  getSubmission(learnerRef: string, submissionId: string): Promise<SubmissionRecord | undefined>;
  listSubmissions(learnerRef: string, lessonId: string): Promise<readonly SubmissionRecord[]>;

  getConsent(learnerRef: string): Promise<ConsentState | undefined>;
  setConsent(learnerRef: string, consent: ConsentState | null): Promise<void>;
}

export class MemoryLearningStore implements LearningStore {
  private readonly attempts: AttemptRecord[] = [];
  private readonly submissions = new Map<string, SubmissionRecord>();
  private readonly consents = new Map<string, ConsentState>();

  async nextAttemptNo(learnerRef: string, itemId: string): Promise<number> {
    const existing = this.attempts.filter(
      (attempt) => attempt.learnerRef === learnerRef && attempt.itemId === itemId,
    );
    return existing.length + 1;
  }

  async recordAttempt(attempt: AttemptRecord): Promise<void> {
    this.attempts.push(attempt);
  }

  async listAttempts(learnerRef: string, lessonId: string): Promise<readonly AttemptRecord[]> {
    return this.attempts.filter(
      (attempt) => attempt.learnerRef === learnerRef && attempt.lessonId === lessonId,
    );
  }

  async saveDraft(input: {
    learnerRef: string;
    lessonId: string;
    itemId: string;
    submissionId: string | null;
    content: string;
    activeMsDelta: number;
  }): Promise<SubmissionRecord> {
    const existing = input.submissionId ? this.submissions.get(input.submissionId) : undefined;
    const base: SubmissionRecord = existing ?? {
      id: randomUUID(),
      learnerRef: input.learnerRef,
      lessonId: input.lessonId,
      itemId: input.itemId,
      drafts: [],
      submittedAt: null,
      totalActiveMs: 0,
      correlationId: randomUUID(),
      verdict: null,
    };

    if (base.learnerRef !== input.learnerRef) {
      // A submission id from someone else's browser. Start a fresh one rather
      // than appending a child's work to another child's record.
      return this.saveDraft({ ...input, submissionId: null });
    }

    const draft: DraftRecord = {
      draftNo: base.drafts.length + 1,
      content: input.content,
      charCount: answerCharCount(input.content),
      createdAt: new Date().toISOString(),
    };

    const updated: SubmissionRecord = {
      ...base,
      drafts: [...base.drafts, draft],
      totalActiveMs: base.totalActiveMs + Math.max(0, input.activeMsDelta),
    };
    this.submissions.set(updated.id, updated);
    return updated;
  }

  async submit(learnerRef: string, submissionId: string): Promise<SubmissionRecord | undefined> {
    const existing = this.submissions.get(submissionId);
    if (!existing || existing.learnerRef !== learnerRef) return undefined;
    const updated: SubmissionRecord = { ...existing, submittedAt: new Date().toISOString() };
    this.submissions.set(updated.id, updated);
    return updated;
  }

  async getSubmission(
    learnerRef: string,
    submissionId: string,
  ): Promise<SubmissionRecord | undefined> {
    const existing = this.submissions.get(submissionId);
    return existing && existing.learnerRef === learnerRef ? existing : undefined;
  }

  async listSubmissions(
    learnerRef: string,
    lessonId: string,
  ): Promise<readonly SubmissionRecord[]> {
    return [...this.submissions.values()].filter(
      (submission) => submission.learnerRef === learnerRef && submission.lessonId === lessonId,
    );
  }

  async getConsent(learnerRef: string): Promise<ConsentState | undefined> {
    return this.consents.get(learnerRef);
  }

  async setConsent(learnerRef: string, consent: ConsentState | null): Promise<void> {
    if (consent) this.consents.set(learnerRef, consent);
    else this.consents.delete(learnerRef);
  }
}

/**
 * Held on `globalThis` so the dev server's module reloads do not throw away a
 * child's work mid-lesson. The Postgres implementation replaces this whole
 * block; nothing else in the app knows which one it is talking to.
 */
const GLOBAL_KEY = Symbol.for("steamkid.learningStore");
type GlobalWithStore = typeof globalThis & { [GLOBAL_KEY]?: LearningStore };

export function getLearningStore(): LearningStore {
  const holder = globalThis as GlobalWithStore;
  holder[GLOBAL_KEY] ??= new MemoryLearningStore();
  return holder[GLOBAL_KEY];
}

export function setLearningStore(store: LearningStore): void {
  (globalThis as GlobalWithStore)[GLOBAL_KEY] = store;
}
