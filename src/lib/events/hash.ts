/**
 * Hashing for the one thing that must never travel in an event: text a child
 * typed.
 *
 * PRO-3 rule 1 — the answer itself lives in `app.attempt` and nowhere else.
 * Events carry a short hash, which is enough to answer "did the answer change
 * between draft 2 and draft 3" without spreading a child's words across
 * millions of append-only rows we can no longer delete on a guardian's
 * request.
 */

/** Registry fields named `*_hash` carry exactly this many characters. */
export const ANSWER_HASH_LENGTH = 16;

/**
 * Whitespace and Unicode form are normalised first, so "same answer, retyped"
 * hashes the same and a change count stays meaningful.
 */
function normalise(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ");
}

/**
 * First 16 hex characters of the SHA-256 of the normalised text.
 *
 * Truncated on purpose: we compare hashes for equality, we never try to
 * recover text from them, and a shorter digest is a smaller invitation to try.
 * An empty answer hashes to `""` so "not started" is distinguishable from
 * "wrote something".
 */
export async function answerHash(text: string): Promise<string> {
  const normalised = normalise(text);
  if (normalised.length === 0) return "";

  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalised),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, ANSWER_HASH_LENGTH);
}

/** Character count of the normalised answer — safe to send, unlike the answer. */
export function answerCharCount(text: string): number {
  return normalise(text).length;
}
