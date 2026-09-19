/**
 * The content loader.
 *
 * Every screen goes through these functions rather than importing the course
 * module directly, so the day PRO-7's `app.lesson` exists the swap is confined
 * to this file: the functions become queries and keep their signatures. They
 * are `async` already for exactly that reason.
 */

import { FORCE_AND_MOTION } from "./force-and-motion";
import type { Course, ExerciseItem, Lesson } from "./types";

export * from "./types";

const COURSE: Course = FORCE_AND_MOTION;

export async function getCourse(): Promise<Course> {
  return COURSE;
}

/** Lessons in teaching order. */
export async function listLessons(): Promise<readonly Lesson[]> {
  return [...COURSE.lessons].sort((a, b) => a.orderIndex - b.orderIndex);
}

export async function getLessonBySlug(slug: string): Promise<Lesson | undefined> {
  return COURSE.lessons.find((lesson) => lesson.slug === slug);
}

export async function getLessonById(id: string): Promise<Lesson | undefined> {
  return COURSE.lessons.find((lesson) => lesson.id === id);
}

export async function getItemById(
  id: string,
): Promise<{ readonly lesson: Lesson; readonly item: ExerciseItem } | undefined> {
  for (const lesson of COURSE.lessons) {
    const item = lesson.items.find((candidate) => candidate.id === id);
    if (item) return { lesson, item };
  }
  return undefined;
}

/** The lesson a child should be offered after finishing this one, if any. */
export async function getNextLesson(slug: string): Promise<Lesson | undefined> {
  const ordered = await listLessons();
  const index = ordered.findIndex((lesson) => lesson.slug === slug);
  if (index < 0) return undefined;
  return ordered[index + 1];
}
