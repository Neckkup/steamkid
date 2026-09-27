"use client";

/**
 * Shows AI feedback for a submitted piece of work and fires the three
 * feedback events the behaviour spec requires.
 *
 * feedback.viewed  — fires once, after the panel has been continuously visible
 *                    for ≥ 1 second (per the registry trigger).
 * feedback.dwell   — fires on unmount (navigate away or close), carrying active
 *                    reading time from the shared clock.
 * feedback.rated   — fires when the child taps the helpful / not-helpful button.
 */

import { useEffect, useRef, useState } from "react";

import { ActiveSpan } from "@/lib/events/activity";
import { useTracking } from "@/lib/events/client/tracking-provider";
import type { EffectiveVerdict } from "@/lib/learning/verdict-store";

import { Button, Card, StatusPill } from "@/components/ui";

export interface FeedbackPanelProps {
  readonly verdictId: string;
  readonly status: EffectiveVerdict["status"];
  readonly subjectType: "submission";
  readonly subjectId: string;
  readonly correlationId: string;
  readonly feedbackToLearner: string | null;
  readonly nextStep: string | null;
  readonly unscorableReason: EffectiveVerdict["unscorableReason"];
}

const VIEWED_THRESHOLD_MS = 1_000;

export function FeedbackPanel({
  verdictId,
  status,
  subjectType,
  subjectId,
  correlationId,
  feedbackToLearner,
  nextStep,
  unscorableReason,
}: FeedbackPanelProps) {
  const { track, clock } = useTracking();
  const mountedAt = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const spanRef = useRef<ActiveSpan | null>(null);
  const viewedFired = useRef(false);
  const ratedRef = useRef(false);
  const [rated, setRated] = useState<"helpful" | "not_helpful" | null>(null);

  useEffect(() => {
    mountedAt.current = Date.now();
  }, []);

  useEffect(() => {
    spanRef.current = new ActiveSpan(clock, Date.now());
  }, [clock]);

  // feedback.viewed: fires once after ≥1s continuous intersection
  useEffect(() => {
    if (viewedFired.current) return;
    const el = panelRef.current;
    if (!el) return;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (timeoutId) return;
            timeoutId = setTimeout(() => {
              if (viewedFired.current) return;
              viewedFired.current = true;
              track(
                "feedback.viewed",
                {
                  verdict_id: verdictId,
                  subject_type: subjectType,
                  subject_id: subjectId,
                  ms_since_result_shown: mountedAt.current != null ? Date.now() - mountedAt.current : 0,
                  correlation_id: correlationId,
                },
                { verdict_id: verdictId, submission_id: subjectId },
              );
            }, VIEWED_THRESHOLD_MS);
          } else {
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
          }
        }
      },
      { threshold: 0.5 },
    );

    observer.observe(el);

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, [track, verdictId, subjectType, subjectId, correlationId]);

  // feedback.dwell: fires on unmount
  useEffect(() => {
    return () => {
      const span = spanRef.current;
      if (!span) return;
      const now = Date.now();
      track(
        "feedback.dwell",
        {
          verdict_id: verdictId,
          active_ms: span.activeMs(now),
          expanded_criteria: [],
          scrolled_to_end: false,
        },
        { verdict_id: verdictId, submission_id: subjectId },
      );
    };
    // Only runs on unmount — intentionally omitting deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRate = (helpful: boolean) => {
    if (ratedRef.current) return;
    ratedRef.current = true;
    setRated(helpful ? "helpful" : "not_helpful");
    track(
      "feedback.rated",
      {
        verdict_id: verdictId,
        helpful,
        correlation_id: correlationId,
      },
      { verdict_id: verdictId, submission_id: subjectId },
    );
  };

  return (
    <div ref={panelRef}>
      <Card tone="brand" className="mt-6">
        <StatusPill tone="correct">ผลจากครู AI</StatusPill>

        {status === "graded" && feedbackToLearner ? (
          <>
            <p className="mt-3 text-lg leading-relaxed">{feedbackToLearner}</p>
            {nextStep ? (
              <div className="mt-4 rounded-2xl bg-white p-4">
                <p className="text-base font-semibold text-brand-strong">ลองทำต่อไปนี้</p>
                <p className="mt-1 text-base">{nextStep}</p>
              </div>
            ) : null}
          </>
        ) : status === "blocked_by_safety" ? (
          <p className="mt-3 text-lg">
            งานชิ้นนี้มีเนื้อหาที่ระบบอ่านไม่ได้ ครู AI จึงยังให้คำแนะนำไม่ได้
          </p>
        ) : status === "unscorable" ? (
          <p className="mt-3 text-lg">
            {unscorableReason === "too_short"
              ? "งานยังสั้นเกินไป ลองเขียนให้ยาวขึ้นแล้วส่งอีกครั้งนะ"
              : unscorableReason === "off_topic"
                ? "ดูเหมือนงานไม่ตรงกับโจทย์ ลองอ่านโจทย์อีกครั้งแล้วเขียนใหม่ได้เลย"
                : "ครู AI อ่านงานไม่ออก ลองส่งงานใหม่อีกครั้งนะ"}
          </p>
        ) : (
          <p className="mt-3 text-lg">ครู AI อ่านงานแล้ว แต่ยังไม่มีคำแนะนำสำหรับครั้งนี้</p>
        )}

        {status === "graded" && (
          <div className="mt-5 border-t border-brand pt-4">
            <p className="text-base text-muted">คำแนะนำนี้มีประโยชน์กับหนูไหม?</p>
            <div className="mt-2 flex gap-3">
              <Button
                tone={rated === "helpful" ? "primary" : "secondary"}
                onClick={() => handleRate(true)}
                disabled={rated !== null}
                className="min-w-0 flex-1"
                aria-pressed={rated === "helpful"}
              >
                มีประโยชน์ 👍
              </Button>
              <Button
                tone={rated === "not_helpful" ? "primary" : "secondary"}
                onClick={() => handleRate(false)}
                disabled={rated !== null}
                className="min-w-0 flex-1"
                aria-pressed={rated === "not_helpful"}
              >
                ยังไม่ได้เรื่อง 👎
              </Button>
            </div>
            {rated && (
              <p className="mt-2 text-base text-muted">
                {rated === "helpful" ? "ขอบคุณที่บอกนะ เราจะพัฒนาต่อไป!" : "ขอบคุณที่บอกนะ จะพยายามดีขึ้น!"}
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
