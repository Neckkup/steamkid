/**
 * PII redaction for anything that leaves our infrastructure.
 *
 * Our users are children. Treat every identifier that reaches an external
 * service (Langfuse, Sentry, any future vendor) as permanent and public.
 * This module is the single choke point: external clients call it, nothing
 * else does the escaping by hand.
 *
 * The rule is allow-list first (`pickAllowed`), regex scrubbing second
 * (`scrubText`). Regexes are the safety net for free-text a child typed, not
 * the primary defence — a child can write their own name in an essay answer
 * and no regex will catch it. Where free text cannot be proven safe, we send a
 * reference id instead of the text (`referenceOnly`).
 */

export const REDACTED = "[REDACTED]";

/** Keys whose values are never sent outside our infrastructure, at any depth. */
const DENIED_KEY_PATTERNS: RegExp[] = [
  /pass(word|phrase)/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /authorization/i,
  /cookie/i,
  /session/i,
  /\bemail\b/i,
  /\bphone\b/i,
  /first[-_]?name/i,
  /last[-_]?name/i,
  /full[-_]?name/i,
  /display[-_]?name/i,
  /\bname\b/i,
  /\bdob\b/i,
  /birth/i,
  /\baddress\b/i,
  /\bavatar\b/i,
  /\bphoto\b/i,
  /guardian/i,
  /parent[-_]?(email|name|phone)/i,
  /\bip\b/i,
  /user[-_]?agent/i,
];

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
/** International-ish phone runs: 8+ digits with optional separators. */
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
/** Thai national ID: 13 digits, optionally dash-separated. */
const THAI_ID_RE = /\b\d(?:[\s-]?\d){12}\b/g;
const URL_CREDENTIALS_RE = /\/\/[^/\s:@]+:[^/\s:@]+@/g;

export function isDeniedKey(key: string): boolean {
  return DENIED_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** Scrub identifiers out of a free-text string. Best effort, never trusted alone. */
export function scrubText(value: string): string {
  return value
    .replace(URL_CREDENTIALS_RE, "//" + REDACTED + "@")
    .replace(EMAIL_RE, REDACTED)
    .replace(THAI_ID_RE, REDACTED)
    .replace(PHONE_RE, REDACTED);
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Walk an arbitrary value and redact denied keys and identifier-shaped text.
 * Cycles are replaced with `"[CIRCULAR]"`; depth is capped so a hostile or
 * accidentally huge payload cannot stall the request.
 */
export function redactDeep(value: unknown, maxDepth = 8): Json {
  return walk(value, maxDepth, new WeakSet<object>());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): Json {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return REDACTED;

  if (depth <= 0) return "[TRUNCATED]";

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: scrubText(value.message) };
  }

  if (typeof value === "object") {
    const obj = value as object;
    if (seen.has(obj)) return "[CIRCULAR]";
    seen.add(obj);

    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth - 1, seen));
    }

    const out: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isDeniedKey(key) ? REDACTED : walk(item, depth - 1, seen);
    }
    return out;
  }

  return REDACTED;
}

/**
 * Allow-list projection: keep only the keys we have decided are safe to export.
 * Values still pass through `redactDeep`, so an allowed key holding an email
 * is caught by the second layer.
 */
export function pickAllowed<T extends Record<string, unknown>>(
  value: T,
  allowedKeys: readonly string[],
): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const key of allowedKeys) {
    if (key in value) out[key] = redactDeep(value[key]);
  }
  return out;
}

/**
 * For content we cannot prove is free of identifying details — a child's
 * free-text answer, an uploaded file name, an image caption. The external
 * service gets a pointer; the content stays in our database.
 */
export function referenceOnly(kind: string, id: string) {
  return { kind, ref: id, note: "content withheld; stored in steamkid database" };
}
