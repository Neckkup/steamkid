"use client";

/**
 * The exercise screen: one item at a time, and the events that describe how a
 * child worked through it.
 *
 * The events are not decoration on this screen — they *are* the evidence the
 * behavioural half of the skill map is computed from. `BEH.SELF_REGULATION`
 * needs `item.first_input.active_latency_ms`; `BEH.PERSISTENCE` needs
 * `item.retried` against `item.result_shown`; `BEH.HELP_SEEKING` needs
 * `hint.requested.had_input`. None of them can be reconstructed later from the
 * stored answer, so a missing emit here is a permanent hole.
 *
 * What never leaves this component: what the child actually typed. Text goes to
 * `POST /api/attempts` and nowhere else. The events carry a 16-character hash
 * and a character count.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, ButtonLink, Card, PageShell, StatusPill } from "@/components/ui";
import type { PublicItem } from "@/content/public";
import { ActiveSpan } from "@/lib/events/activity";
import { useTracking } from "@/lib/events/client/tracking-provider";
import { answerHash } from "@/lib/events/hash";

import {
  AnswerInput,
  answerCharLength,
  answerFingerprint,
  emptyAnswerFor,
  isAnswered,
  type AnswerValue,
} from "./answer-input";

/** Registry cadence for `item.answer_changed` on text. */
const TEXT_CHANGE_DEBOUNCE_MS = 800;

type ItemOutcome =
  | {
      readonly kind: "graded";
      readonly result: "correct" | "partial" | "incorrect";
      readonly explanation: string;
      readonly attemptsLeft: number;
    }
  | { readonly kind: "pending_ai"; readonly pendingReason: string }
  | { readonly kind: "skipped" };

interface RunnerProps {
  readonly lessonId: string;
  readonly lessonSlug: string;
  readonly lessonTitle: string;
  readonly exerciseSetId: string;
  readonly items: readonly PublicItem[];
  readonly hasProject: boolean;
}

export function PracticeRunner({
  lessonId,
  lessonSlug,
  lessonTitle,
  exerciseSetId,
  items,
  hasProject,
}: RunnerProps) {
  const router = useRouter();
  const { track, clock } = useTracking();

  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState<AnswerValue>(() => emptyAnswerFor(items[0]!));
  const [attemptNo, setAttemptNo] = useState(1);
  const [hintsShown, setHintsShown] = useState(0);
  const [outcome, setOutcome] = useState<ItemOutcome | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, ItemOutcome>>({});
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  /**
   * `minChars` the server sent back on a 422 `too_short`, or null.
   *
   * The submit button is already disabled below the floor, so reaching this
   * means the two disagreed — a stale tab, a resubmit, a client that did not
   * load. The child still gets the sentence the screen would have shown them,
   * never an error code.
   */
  const [tooShortMinChars, setTooShortMinChars] = useState<number | null>(null);

  const item = items[index]!;
  const finished = index >= items.length;

  // Per-item measurement state. Refs, not state: changing them must not
  // re-render, and the values must survive the render that shows a result.
  const spanRef = useRef<ActiveSpan | null>(null);
  const presentedAtRef = useRef(Date.now());
  const hadInputRef = useRef(false);
  const changeCountRef = useRef(0);
  const lastFingerprintRef = useRef("");
  const resultShownAtRef = useRef<number | null>(null);
  const reviewedFeedbackRef = useRef(false);
  const debounceRef = useRef<number | null>(null);
  const trackRef = useRef(track);
  trackRef.current = track;

  const startItem = useCallback(
    (nextItem: PublicItem, nextAttemptNo: number) => {
      const now = Date.now();
      spanRef.current = new ActiveSpan(clock, now);
      presentedAtRef.current = now;
      hadInputRef.current = false;
      changeCountRef.current = 0;
      lastFingerprintRef.current = "";
      resultShownAtRef.current = null;

      trackRef.current(
        "item.presented",
        {
          item_id: nextItem.id,
          attempt_no: nextAttemptNo,
          difficulty: nextItem.difficulty,
          skill_weights: nextItem.skillWeights,
        },
        { lesson_id: lessonId, item_id: nextItem.id },
      );
    },
    [clock, lessonId],
  );

  // `exercise.started` once, then the first item.
  useEffect(() => {
    trackRef.current(
      "exercise.started",
      {
        lesson_id: lessonId,
        exercise_set_id: exerciseSetId,
        item_count: items.length,
        attempt_of_set: 1,
      },
      { lesson_id: lessonId },
    );
    startItem(items[0]!, 1);
    // Once per mounted exercise set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Leaving with an item open and unanswered is `item.abandoned`. Without it,
   * `BEH.PERSISTENCE` cannot tell "gave up" from "never reached the item".
   */
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      if (finished || outcome !== null || spanRef.current === null) return;
      trackRef.current(
        "item.abandoned",
        {
          item_id: item.id,
          attempt_no: attemptNo,
          ms_on_item: Date.now() - presentedAtRef.current,
          had_input: hadInputRef.current,
          reason: "navigate_away",
        },
        { lesson_id: lessonId, item_id: item.id },
      );
    };
  }, [item.id, attemptNo, finished, outcome, lessonId]);

  const emitAnswerChanged = useCallback(
    async (from: string, to: string) => {
      const now = Date.now();
      const [fromHash, toHash] = await Promise.all([answerHash(from), answerHash(to)]);
      trackRef.current(
        "item.answer_changed",
        {
          item_id: item.id,
          attempt_no: attemptNo,
          change_index: changeCountRef.current,
          from_hash: fromHash,
          to_hash: toHash,
          ms_since_presented: now - presentedAtRef.current,
          char_delta: [...to].length - [...from].length,
        },
        { lesson_id: lessonId, item_id: item.id },
      );
    },
    [item.id, attemptNo, lessonId],
  );

  const onAnswerChange = useCallback(
    (next: AnswerValue) => {
      setAnswer(next);

      const now = Date.now();
      if (!hadInputRef.current) {
        hadInputRef.current = true;
        trackRef.current(
          "item.first_input",
          {
            item_id: item.id,
            attempt_no: attemptNo,
            latency_ms_since_presented: now - presentedAtRef.current,
            active_latency_ms: spanRef.current?.activeMs(now) ?? 0,
          },
          { lesson_id: lessonId, item_id: item.id },
        );
      }

      const from = lastFingerprintRef.current;
      const to = answerFingerprint(next);
      if (from === to) return;

      const flush = () => {
        changeCountRef.current += 1;
        lastFingerprintRef.current = to;
        void emitAnswerChanged(from, to);
      };

      // Text is debounced so one sentence is one change, not thirty keystrokes.
      // A tap on a choice is already a settled value.
      if (next.type === "text") {
        if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(flush, TEXT_CHANGE_DEBOUNCE_MS);
      } else {
        flush();
      }
    },
    [item.id, attemptNo, lessonId, emitAnswerChanged],
  );

  function showHint() {
    const now = Date.now();
    const hintIndex = hintsShown;
    setHintsShown(hintsShown + 1);
    track(
      "hint.requested",
      {
        item_id: item.id,
        attempt_no: attemptNo,
        hint_index: hintIndex,
        ms_since_presented: now - presentedAtRef.current,
        active_ms_since_presented: spanRef.current?.activeMs(now) ?? 0,
        had_input: hadInputRef.current,
      },
      { lesson_id: lessonId, item_id: item.id },
    );
  }

  function skip() {
    const now = Date.now();
    track(
      "item.skipped",
      {
        item_id: item.id,
        attempt_no: attemptNo,
        ms_before_skip: now - presentedAtRef.current,
        had_input: hadInputRef.current,
        hints_used: hintsShown,
      },
      { lesson_id: lessonId, item_id: item.id },
    );
    setOutcomes((current) => ({ ...current, [item.id]: { kind: "skipped" } }));
    advance();
  }

  function advance() {
    const nextIndex = index + 1;
    setOutcome(null);
    setSendFailed(false);
    setTooShortMinChars(null);
    setHintsShown(0);
    setAttemptNo(1);
    setIndex(nextIndex);
    if (nextIndex < items.length) {
      const nextItem = items[nextIndex]!;
      setAnswer(emptyAnswerFor(nextItem));
      startItem(nextItem, 1);
    }
  }

  function retry() {
    const now = Date.now();
    const next = attemptNo + 1;
    track(
      "item.retried",
      {
        item_id: item.id,
        attempt_no: next,
        previous_result: outcome?.kind === "graded" ? outcome.result : "incorrect",
        ms_since_result_shown: now - (resultShownAtRef.current ?? now),
        reviewed_feedback_first: reviewedFeedbackRef.current,
      },
      { lesson_id: lessonId, item_id: item.id },
    );
    setAttemptNo(next);
    setOutcome(null);
    setSendFailed(false);
    setTooShortMinChars(null);
    setHintsShown(0);
    setAnswer(emptyAnswerFor(item));
    startItem(item, next);
  }

  async function submit() {
    if (sending) return;
    setSending(true);
    setSendFailed(false);
    setTooShortMinChars(null);

    const now = Date.now();
    const span = spanRef.current;

    try {
      const response = await fetch("/api/attempts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId: item.id,
          answer,
          timeOnItemMs: now - presentedAtRef.current,
          activeTimeOnItemMs: Math.round(span?.activeMs(now) ?? 0),
          answerChanges: changeCountRef.current,
          hintsUsed: hintsShown,
        }),
      });

      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as {
          error?: string;
          minChars?: number;
        } | null;
        if (problem?.error === "too_short" && typeof problem.minChars === "number") {
          setTooShortMinChars(problem.minChars);
          return;
        }
        setSendFailed(true);
        return;
      }

      const body = (await response.json()) as {
        attemptId: string;
        correlationId: string;
        status: "graded" | "pending_ai";
        result?: "correct" | "partial" | "incorrect";
        explanation?: string;
        pendingReason?: string;
        attemptsLeft: number;
      };

      track(
        "item.answer_submitted",
        {
          item_id: item.id,
          attempt_id: body.attemptId,
          attempt_no: attemptNo,
          time_on_item_ms: now - presentedAtRef.current,
          active_time_on_item_ms: Math.round(span?.activeMs(now) ?? 0),
          answer_changes: changeCountRef.current,
          hints_used: hintsShown,
          correlation_id: body.correlationId,
        },
        { lesson_id: lessonId, item_id: item.id, correlation_id: body.correlationId },
      );

      const next: ItemOutcome =
        body.status === "graded"
          ? {
              kind: "graded",
              result: body.result ?? "incorrect",
              explanation: body.explanation ?? "",
              attemptsLeft: body.attemptsLeft,
            }
          : { kind: "pending_ai", pendingReason: body.pendingReason ?? "grader_not_available" };

      resultShownAtRef.current = Date.now();
      reviewedFeedbackRef.current = false;
      setOutcome(next);
      setOutcomes((current) => ({ ...current, [item.id]: next }));

      if (next.kind === "graded") {
        track(
          "item.result_shown",
          {
            item_id: item.id,
            attempt_id: body.attemptId,
            attempt_no: attemptNo,
            result: next.result,
            source: "deterministic",
            correlation_id: body.correlationId,
          },
          { lesson_id: lessonId, item_id: item.id, correlation_id: body.correlationId },
        );
      }
    } catch {
      setSendFailed(true);
    } finally {
      setSending(false);
    }
  }

  const summary = useMemo(() => {
    const values = Object.values(outcomes);
    return {
      correct: values.filter((value) => value.kind === "graded" && value.result === "correct")
        .length,
      partial: values.filter((value) => value.kind === "graded" && value.result === "partial")
        .length,
      waiting: values.filter((value) => value.kind === "pending_ai").length,
      skipped: values.filter((value) => value.kind === "skipped").length,
    };
  }, [outcomes]);

  if (finished) {
    return (
      <PageShell>
        <h1 className="text-3xl font-bold leading-snug">ทำครบทุกข้อแล้ว เก่งมาก</h1>
        <p className="mt-2 text-lg text-muted">{lessonTitle}</p>

        <Card className="mt-6">
          <ul className="grid gap-2 text-lg">
            <li>ตอบถูกตั้งแต่ครั้งแรกหรือหลังลองใหม่: {summary.correct} ข้อ</li>
            {summary.partial > 0 ? <li>ถูกบางส่วน: {summary.partial} ข้อ</li> : null}
            {summary.waiting > 0 ? (
              <li>รอครู AI อ่านงานเขียน: {summary.waiting} ข้อ</li>
            ) : null}
            {summary.skipped > 0 ? <li>ข้ามไว้ก่อน: {summary.skipped} ข้อ</li> : null}
          </ul>
        </Card>

        <div className="mt-8 flex flex-col gap-3">
          {hasProject ? (
            <ButtonLink href={`/learn/${lessonSlug}/project`}>ไปทำชิ้นงานของบทนี้</ButtonLink>
          ) : (
            <ButtonLink href="/learn">เลือกบทเรียนต่อไป</ButtonLink>
          )}
          <Button tone="secondary" onClick={() => router.push(`/learn/${lessonSlug}`)}>
            กลับไปอ่านบทเรียนอีกครั้ง
          </Button>
        </div>
      </PageShell>
    );
  }

  const answered = isAnswered(answer, item);
  const written = item.type === "short_text" || item.type === "long_text";
  const longEnough = !written || answerCharLength(answer) >= item.minChars;

  return (
    <PageShell>
      <p className="text-base font-semibold text-brand-strong">
        ข้อ {index + 1} จาก {items.length}
        {attemptNo > 1 ? ` · ลองครั้งที่ ${attemptNo}` : ""}
      </p>
      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-valuenow={index + 1}
        aria-valuemin={1}
        aria-valuemax={items.length}
        aria-label="ความคืบหน้า"
      >
        <div
          className="h-full rounded-full bg-brand transition-all"
          style={{ width: `${((index + 1) / items.length) * 100}%` }}
        />
      </div>

      <h1 className="mt-6 text-2xl font-bold leading-snug">{item.prompt}</h1>

      {written ? (
        <Card className="mt-4 bg-brand-soft">
          <p className="font-semibold text-brand-strong">คำตอบที่ดีจะมีสิ่งเหล่านี้</p>
          <ul className="mt-2 grid gap-1">
            {item.successCriteria.map((criterion) => (
              <li key={criterion}>• {criterion}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="mt-6">
        <AnswerInput
          item={item}
          answer={answer}
          disabled={outcome !== null || sending}
          onChange={onAnswerChange}
        />
      </div>

      {hintsShown > 0 ? (
        <div className="mt-4 grid gap-2">
          {item.hintTexts.slice(0, hintsShown).map((hint, hintIndex) => (
            <Card key={hintIndex} className="border-brand bg-brand-soft">
              <p className="font-semibold text-brand-strong">คำใบ้ {hintIndex + 1}</p>
              <p className="mt-1">{hint}</p>
            </Card>
          ))}
        </div>
      ) : null}

      {outcome ? <Outcome outcome={outcome} onRead={() => (reviewedFeedbackRef.current = true)} /> : null}

      {/* Always mounted so the message is announced when it appears, not only
          seen — the child who hits this is the one whose screen is out of step. */}
      <div aria-live="polite">
        {tooShortMinChars !== null ? (
          <Card className="mt-4 border-notyet bg-notyet-soft">
            <p className="font-semibold">เขียนอีกนิดนะ</p>
            <p className="mt-1">
              ข้อนี้อยากให้เขียนอย่างน้อย {tooShortMinChars} ตัวอักษร คำตอบของหนูยังอยู่ครบ
              เติมอีกหน่อยแล้วกดส่งได้เลย
            </p>
          </Card>
        ) : null}
      </div>

      {sendFailed ? (
        <Card className="mt-4 border-notyet bg-notyet-soft">
          <p className="font-semibold">ส่งคำตอบไม่สำเร็จ</p>
          <p className="mt-1">คำตอบของหนูยังอยู่ครบ ลองกดส่งอีกครั้งได้เลย</p>
        </Card>
      ) : null}

      <div className="mt-8 flex flex-col gap-3">
        {outcome === null ? (
          <>
            <Button onClick={submit} disabled={!answered || !longEnough || sending}>
              {sending ? "กำลังส่ง..." : "ส่งคำตอบ"}
            </Button>
            {written && !longEnough && answered ? (
              <p className="text-center text-base text-muted">
                เขียนอีกนิดนะ ให้ครบ {item.minChars} ตัวอักษร
              </p>
            ) : null}
            {hintsShown < item.hintTexts.length ? (
              <Button tone="secondary" onClick={showHint}>
                ขอคำใบ้
              </Button>
            ) : null}
            <Button tone="quiet" onClick={skip}>
              ข้อนี้ขอข้ามไปก่อน
            </Button>
          </>
        ) : (
          <>
            <Button onClick={advance}>
              {index + 1 < items.length ? "ไปข้อต่อไป" : "ดูสรุปของบทนี้"}
            </Button>
            {outcome.kind === "graded" &&
            outcome.result !== "correct" &&
            outcome.attemptsLeft > 0 ? (
              <Button tone="secondary" onClick={retry}>
                ขอลองข้อนี้อีกครั้ง
              </Button>
            ) : null}
          </>
        )}
      </div>
    </PageShell>
  );
}

/**
 * The result of one item.
 *
 * A wrong answer gets amber, a sentence of explanation and a way forward —
 * never a red cross and never the bare word "ผิด". PRO-6's quality bar is that
 * the screen tells a child what to try next, and "ยังไม่ใช่" leaves the door
 * open in a way "ผิด" does not.
 */
function Outcome({
  outcome,
  onRead,
}: {
  readonly outcome: ItemOutcome;
  readonly onRead: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onRead, 1_000);
    return () => window.clearTimeout(timer);
  }, [onRead]);

  if (outcome.kind === "skipped") return null;

  if (outcome.kind === "pending_ai") {
    return (
      <Card className="mt-6 border-waiting bg-waiting-soft">
        <StatusPill tone="waiting">ส่งงานเรียบร้อย</StatusPill>
        <p className="mt-3 text-lg font-semibold">เก็บคำตอบของหนูไว้แล้ว</p>
        <p className="mt-1">
          ข้อนี้เป็นคำถามที่ต้องให้ครู AI อ่านและเขียนคำแนะนำกลับมา ตอนนี้ระบบตรวจยังทำไม่เสร็จ
          หนูจึงยังไม่ได้ฟีดแบ็กในวันนี้ แต่คำตอบของหนูถูกเก็บไว้เรียบร้อยแล้ว
        </p>
      </Card>
    );
  }

  if (outcome.result === "correct") {
    return (
      <Card className="mt-6 border-correct bg-correct-soft">
        <StatusPill tone="correct">ถูกต้อง</StatusPill>
        <p className="mt-3">{outcome.explanation}</p>
      </Card>
    );
  }

  return (
    <Card className="mt-6 border-notyet bg-notyet-soft">
      <StatusPill tone="notyet">
        {outcome.result === "partial" ? "เกือบถูกแล้ว" : "ยังไม่ใช่คำตอบที่ใช่"}
      </StatusPill>
      <p className="mt-3">{outcome.explanation}</p>
      {outcome.attemptsLeft > 0 ? (
        <p className="mt-2 font-semibold">อ่านคำอธิบายข้างบนแล้วลองอีกครั้งได้นะ</p>
      ) : (
        <p className="mt-2 font-semibold">ไม่เป็นไรเลย ข้อนี้ยากจริง ไปข้อต่อไปกันก่อน</p>
      )}
    </Card>
  );
}
