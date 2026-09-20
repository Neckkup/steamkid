/**
 * How long a child's written answer is, counted the way their screen counts it.
 *
 * Code points, not UTF-16 code units, because that is what the counter under
 * the answer box shows and what the submit button gates on
 * (`answerCharLength` in the practice runner, `charCount` in the project
 * editor). Counting any other way lets the server and the screen disagree about
 * whether the same answer is long enough — the child is told "20 ตัวอักษรแล้ว"
 * and the server still says too short.
 */
export function answerCharCount(value: string): number {
  return [...value.trim()].length;
}
