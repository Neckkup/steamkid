"use client";

/**
 * The long-form piece of work for a lesson.
 *
 * Two things this screen owes a child, in order of importance:
 *
 *   1. **Never lose their writing.** Autosave every 30 seconds of active
 *      editing, and a failed save says so without clearing the box. A child who
 *      loses a paragraph does not write a second one.
 *   2. **Tell the truth about grading.** Submitting stores the work; there is
 *      no grader yet (PRO-8). The confirmation says the work is safely in, and
 *      does not imply a score is coming today.
 *   3. **Give their writing back when they return.** `resumed` is the work the
 *      server already holds for this child and this project. Without it the
 *      screen opened on "เขียนแล้ว 0 ตัวอักษร" seconds after a child pressed
 *      send, and nothing on it admitted the work existed (PRO-42).
 *
 * `submission.draft_saved` carries a hash and a character count. The text goes
 * to `POST /api/submissions` and nowhere else.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, ButtonLink, Card, PageShell } from "@/components/ui";
import type { PublicLongTextItem } from "@/content/public";
import { ActiveSpan } from "@/lib/events/activity";
import { useTracking } from "@/lib/events/client/tracking-provider";
import { answerHash } from "@/lib/events/hash";

/** PRO-3 registry trigger: "autosave every 30s of active editing". */
const AUTOSAVE_INTERVAL_MS = 30_000;

/** Work the server already holds for this child and this project. */
export interface ResumedWork {
  readonly submissionId: string;
  readonly text: string;
  readonly draftCount: number;
  /** Thai, formatted on the server. Null while the work is still a draft. */
  readonly submittedAtLabel: string | null;
}

export function ProjectEditor({
  lessonId,
  lessonSlug,
  lessonTitle,
  item,
  resumed,
}: {
  readonly lessonId: string;
  readonly lessonSlug: string;
  readonly lessonTitle: string;
  readonly item: PublicLongTextItem;
  readonly resumed?: ResumedWork;
}) {
  const router = useRouter();
  const { track, clock } = useTracking();

  const [text, setText] = useState(resumed?.text ?? "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);

  // Seeded from `resumed` so the next save appends to the submission the child
  // already has instead of opening a second one beside it, and so autosave sees
  // the restored text as already saved rather than as an unsaved change.
  const submissionIdRef = useRef<string | null>(resumed?.submissionId ?? null);
  const draftCountRef = useRef(resumed?.draftCount ?? 0);
  const textRef = useRef(resumed?.text ?? "");
  const savedTextRef = useRef(resumed?.text ?? "");
  const spanRef = useRef<ActiveSpan | null>(null);
  const lastDraftActiveMsRef = useRef(0);
  const firstDraftAtRef = useRef<number | null>(null);
  const trackRef = useRef(track);

  // Both refs exist so the autosave timer and the submit handler read the latest
  // value without being rebuilt on every keystroke. The writes belong in an
  // effect, not in render: `react-hooks/refs` refuses a ref write during render,
  // and both of these run again under StrictMode's double render.
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    trackRef.current = track;
  }, [track]);

  useEffect(() => {
    spanRef.current = new ActiveSpan(clock, Date.now());
  }, [clock]);

  const persist = useCallback(
    async (action: "draft" | "submit"): Promise<string | null> => {
      const content = textRef.current;
      if (content.trim().length === 0) return null;

      const now = Date.now();
      const totalActive = spanRef.current?.activeMs(now) ?? 0;
      const activeMsDelta = Math.max(0, Math.round(totalActive - lastDraftActiveMsRef.current));

      const response = await fetch("/api/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId: item.id,
          submissionId: submissionIdRef.current,
          content,
          activeMsDelta,
          action,
        }),
      });
      if (!response.ok) throw new Error("save_failed");

      const body = (await response.json()) as {
        submissionId: string;
        draftNo: number;
        draftCount: number;
        charCount: number;
        totalActiveMs: number;
        correlationId: string;
      };

      submissionIdRef.current = body.submissionId;
      draftCountRef.current = body.draftCount;
      savedTextRef.current = content;
      lastDraftActiveMsRef.current = totalActive;
      firstDraftAtRef.current ??= now;

      trackRef.current(
        "submission.draft_saved",
        {
          submission_id: body.submissionId,
          lesson_id: lessonId,
          draft_no: body.draftNo,
          char_count: body.charCount,
          content_hash: await answerHash(content),
          active_ms_since_last_draft: activeMsDelta,
        },
        { lesson_id: lessonId, submission_id: body.submissionId },
      );

      if (action === "submit") {
        trackRef.current(
          "submission.submitted",
          {
            submission_id: body.submissionId,
            lesson_id: lessonId,
            draft_count: body.draftCount,
            total_active_ms: Math.round(body.totalActiveMs),
            ms_since_first_draft: now - (firstDraftAtRef.current ?? now),
            correlation_id: body.correlationId,
          },
          {
            lesson_id: lessonId,
            submission_id: body.submissionId,
            correlation_id: body.correlationId,
          },
        );
      }

      return body.submissionId;
    },
    [item.id, lessonId],
  );

  // Autosave. Only when the text actually changed since the last save, so an
  // idle tab does not manufacture drafts and inflate `BEH.PERSISTENCE`.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (textRef.current === savedTextRef.current) return;
      if (textRef.current.trim().length === 0) return;
      setSaveState("saving");
      persist("draft")
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("failed"));
    }, AUTOSAVE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [persist]);

  async function submit() {
    setSubmitting(true);
    setSubmitFailed(false);
    try {
      const submissionId = await persist("submit");
      if (!submissionId) {
        setSubmitFailed(true);
        return;
      }
      router.push(`/results/${submissionId}`);
    } catch {
      setSubmitFailed(true);
    } finally {
      setSubmitting(false);
    }
  }

  const charCount = [...text.trim()].length;
  const longEnough = charCount >= item.minChars;

  return (
    <PageShell>
      <p className="text-base font-semibold text-brand-strong">ชิ้นงานของบท: {lessonTitle}</p>
      <h1 className="mt-2 text-2xl font-bold leading-snug">{item.prompt}</h1>

      {resumed?.submittedAtLabel ? (
        <Card tone="correct" className="mt-4">
          <p className="text-lg font-semibold">หนูส่งงานชิ้นนี้ไปแล้ว 🎉</p>
          <p className="mt-1">ส่งเมื่อ {resumed.submittedAtLabel} น.</p>
          <p className="mt-1">งานที่หนูส่งอยู่ในช่องข้างล่างนี้ อ่านทวนได้ ถ้าอยากแก้แล้วส่งใหม่ก็ได้เลย</p>
          <ButtonLink
            href={`/results/${resumed.submissionId}`}
            tone="secondary"
            className="mt-4"
          >
            ดูหน้างานที่ส่งไป
          </ButtonLink>
        </Card>
      ) : null}

      {resumed && !resumed.submittedAtLabel ? (
        <Card tone="waiting" className="mt-4">
          <p className="text-lg font-semibold">เราเก็บงานที่หนูเขียนค้างไว้ให้</p>
          <p className="mt-1">งานอยู่ในช่องข้างล่างครบเหมือนเดิม เขียนต่อได้เลย ยังไม่ได้ส่งนะ</p>
        </Card>
      ) : null}

      <Card className="mt-4 bg-brand-soft">
        <p className="font-semibold text-brand-strong">งานที่ดีจะมีสิ่งเหล่านี้</p>
        <ul className="mt-2 grid gap-1">
          {item.successCriteria.map((criterion) => (
            <li key={criterion}>• {criterion}</li>
          ))}
        </ul>
      </Card>

      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={12}
        placeholder="เขียนงานของหนูตรงนี้ได้เลย"
        aria-label="งานเขียนของหนู"
        className="mt-6 w-full rounded-2xl border-2 border-line bg-surface p-4 text-lg"
      />

      <p className="mt-1 text-base text-muted" aria-live="polite">
        เขียนแล้ว {charCount} ตัวอักษร (อย่างน้อย {item.minChars})
        {saveState === "saving" ? " · กำลังบันทึกร่าง..." : null}
        {saveState === "saved" ? " · บันทึกร่างไว้ให้แล้ว" : null}
      </p>

      {saveState === "failed" ? (
        <Card className="mt-4 border-notyet bg-notyet-soft">
          <p className="font-semibold">บันทึกร่างอัตโนมัติไม่สำเร็จ</p>
          <p className="mt-1">งานของหนูยังอยู่บนหน้าจอครบ อย่าเพิ่งปิดหน้านี้นะ แล้วลองกดส่งดู</p>
        </Card>
      ) : null}

      {submitFailed ? (
        <Card className="mt-4 border-notyet bg-notyet-soft">
          <p className="font-semibold">ส่งงานไม่สำเร็จ</p>
          <p className="mt-1">งานของหนูยังอยู่ ลองกดส่งอีกครั้งได้เลย</p>
        </Card>
      ) : null}

      <div className="mt-8 flex flex-col gap-3">
        <Button onClick={submit} disabled={!longEnough || submitting}>
          {submitting
            ? "กำลังส่ง..."
            : resumed?.submittedAtLabel
              ? "ส่งงานอีกครั้ง"
              : "ส่งงานของหนู"}
        </Button>
        {!longEnough ? (
          <p className="text-center text-base text-muted">
            เขียนอีกนิดนะ ให้ครบ {item.minChars} ตัวอักษรก่อนส่ง
          </p>
        ) : null}
        <Button tone="quiet" onClick={() => router.push(`/learn/${lessonSlug}`)}>
          กลับไปอ่านบทเรียน
        </Button>
      </div>
    </PageShell>
  );
}
