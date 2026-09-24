"use client";

import { useEffect, useRef } from "react";

import { ActiveSpan } from "@/lib/events/activity";
import { useTracking } from "@/lib/events/client/tracking-provider";

/**
 * The reading half of the behaviour pipe: `lesson.opened`, `lesson.section_dwell`
 * for each section that receives attention, the four scroll thresholds, and
 * `lesson.closed`.
 *
 * A component rather than something each lesson page remembers to call, because
 * "the page shipped without its events" is the failure mode PRO-6 calls
 * incomplete, and reading events are unbackfillable.
 *
 * Both a dwell figure and an active figure go out on close. PRO-3 is explicit
 * that every growth formula reads the active one — a tab left open over dinner
 * must not read as forty minutes of study — but the dwell figure is what makes
 * that difference measurable rather than assumed.
 */
export function LessonTracker({
  lessonId,
  contentVersion,
  skillTags,
}: {
  readonly lessonId: string;
  readonly contentVersion: number;
  readonly skillTags: readonly string[];
}) {
  const { track, clock } = useTracking();

  // The effect must run once per lesson, and `track` is stable but not
  // referentially guaranteed across a provider re-render. Kept current in an
  // effect rather than during render: writing a ref while rendering is what
  // `react-hooks/refs` refuses, and under StrictMode's double render it would
  // run the lesson's open/close pair twice.
  const trackRef = useRef(track);
  useEffect(() => {
    trackRef.current = track;
  }, [track]);

  useEffect(() => {
    const emit = trackRef.current;
    const openedAt = Date.now();
    const span = new ActiveSpan(clock, openedAt);
    const reached = new Set<number>();
    let maxPct = 0;

    emit(
      "lesson.opened",
      {
        lesson_id: lessonId,
        content_version: contentVersion,
        entry_source: "browse",
        // Repeat opens need the learner's history, which lives server-side;
        // until the PRO-7 tables exist this is the first open we can prove.
        open_index_for_learner: 1,
      },
      { lesson_id: lessonId },
    );

    const onScroll = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const pct =
        scrollable <= 0 ? 100 : Math.round(((window.scrollY + window.innerHeight) / (scrollable + window.innerHeight)) * 100);
      maxPct = Math.max(maxPct, Math.min(100, pct));

      for (const threshold of [25, 50, 75, 100] as const) {
        if (maxPct >= threshold && !reached.has(threshold)) {
          reached.add(threshold);
          const now = Date.now();
          emit(
            "lesson.scroll_depth",
            {
              lesson_id: lessonId,
              pct: threshold,
              ms_since_open: now - openedAt,
              active_ms_since_open: span.activeMs(now),
            },
            { lesson_id: lessonId },
          );
        }
      }
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    // Section dwell tracking: `lesson.section_dwell` fires when a section
    // that was at least half-visible leaves the viewport, or when the lesson
    // closes. `active_ms` is the delta from the shared clock so a reader who
    // walks away from their desk mid-section is not credited with study time.
    const sectionEnteredActiveMs = new Map<string, number>();

    const sectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const sectionId = (entry.target as HTMLElement).dataset.sectionId;
          if (!sectionId) continue;
          const now = Date.now();
          if (entry.isIntersecting) {
            sectionEnteredActiveMs.set(sectionId, span.activeMs(now));
          } else {
            const enteredActiveMs = sectionEnteredActiveMs.get(sectionId);
            if (enteredActiveMs !== undefined) {
              emit(
                "lesson.section_dwell",
                {
                  lesson_id: lessonId,
                  section_id: sectionId,
                  active_ms: Math.round(span.activeMs(now) - enteredActiveMs),
                  skill_tags: [...skillTags],
                },
                { lesson_id: lessonId },
              );
              sectionEnteredActiveMs.delete(sectionId);
            }
          }
        }
      },
      { threshold: 0.5 },
    );

    document.querySelectorAll<HTMLElement>("[data-section-id]").forEach((el) => {
      sectionObserver.observe(el);
    });

    return () => {
      window.removeEventListener("scroll", onScroll);
      sectionObserver.disconnect();

      // Flush dwell for any sections still in view when the lesson closes.
      const now = Date.now();
      for (const [sectionId, enteredActiveMs] of sectionEnteredActiveMs) {
        emit(
          "lesson.section_dwell",
          {
            lesson_id: lessonId,
            section_id: sectionId,
            active_ms: Math.round(span.activeMs(now) - enteredActiveMs),
            skill_tags: [...skillTags],
          },
          { lesson_id: lessonId },
        );
      }

      emit(
        "lesson.closed",
        {
          lesson_id: lessonId,
          dwell_ms: span.dwellMs(now),
          active_ms: span.activeMs(now),
          max_scroll_pct: maxPct,
          // Reading to the bottom is the only completion signal this screen
          // has; finishing the exercise is a different event on a different page.
          completed: maxPct >= 100,
        },
        { lesson_id: lessonId },
      );
    };
  }, [clock, lessonId, contentVersion, skillTags]);

  return null;
}
