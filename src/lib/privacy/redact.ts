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

/**
 * Version of this redaction layer.
 *
 * Bump it on any change to `DENIED_KEY_PATTERNS`, the scrubbing regexes or
 * `redactDeep`'s traversal. It is written to `app.ai_verdict.redaction_version`
 * and onto every Langfuse trace, so "which redaction rules produced this
 * payload" stays answerable for rows and traces recorded months ago — including
 * the ones recorded before we found a gap.
 *
 * This is the single source: nothing should hardcode a redaction version string
 * anywhere else.
 */
export const REDACTION_VERSION = "1.3.0";

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

/**
 * Keys that name a *token count* rather than a token.
 *
 * `/token/i` above is deliberately broad, and it was eating the usage numbers
 * the model SDK reports (`inputTokens`, `cacheReadTokens`), so a trace read
 * `"inputTokens": "[REDACTED]"` and looked like the redaction layer was broken.
 *
 * The narrowing is expressed as an exception, not by loosening the deny rule:
 * an unlisted secret-shaped key (`resetToken`, `inviteToken`, `otpToken`) must
 * keep failing closed. Only a key in this measurement vocabulary is exempt, and
 * only when its value is a finite number — a credential is a string, a count is
 * not, so `{ inputTokens: "eyJhbGciOi..." }` is still redacted.
 */
const TOKEN_COUNT_KEY_RE = new RegExp(
  "^(?:" +
    [
      // inputTokens, output_tokens, totalTokens, cacheCreationTokens, ...
      String.raw`(?:input|output|total|prompt|completion|reasoning|thinking|billed|cached|cache[-_]?(?:creation|read|write))[-_]?tokens?`,
      // tokenCount, tokens_used, tokenUsage, tokensTotal
      String.raw`tokens?[-_]?(?:count|used|usage|total)`,
      // numTokens, nTokens, maxTokens, tokenLimit
      String.raw`(?:num|n|max|min|avg)[-_]?tokens?`,
      String.raw`tokens?[-_]?(?:limit|max)`,
    ].join("|") +
    ")$",
  "i",
);

/**
 * True when a denied key is really a numeric measurement and safe to export.
 * Both halves matter: the key must be in the counting vocabulary *and* the
 * value must be a finite number.
 */
function isNumericMeasurement(key: string, value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    TOKEN_COUNT_KEY_RE.test(key)
  );
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
/**
 * Phone-shaped digit runs.
 *
 * Deliberately narrow. The obvious pattern — "8+ digits with optional
 * separators" — also matches a child's maths work, because "1 2 3 4 5 6 7 8 9"
 * and "I counted 100 200 300 400 500 marbles" are digits with separators too.
 * Redacting those makes a grading trace unreadable, which defeats the point of
 * tracing the grader at all.
 *
 * So a match needs one of:
 *   - an explicit `+` country code,
 *   - parentheses as separators (phone punctuation, not maths),
 *   - a Thai-style leading `0` trunk group,
 *   - a NANP-style `NNN-NNN-NNNN` grouping,
 *   - a contiguous run of 9+ digits (the pre-existing threshold; `12345678`
 *     stays visible).
 *
 * Space-separated digits on their own are never a phone here. Known cost:
 * `081 234 5678` is caught by the leading-`0` rule, but a space-separated
 * foreign number with no `+` and no leading `0` is not. That is acceptable —
 * this module's stated design is allow-list first, regex as the safety net.
 * `01-15-2024` and ISO dates are both unaffected.
 *
 * The last two alternatives also match schoolwork, so every match is passed
 * through `isSchoolworkQuantity` before it is blanked. See that function for
 * which matches can earn the exemption and which can never.
 */
const PHONE_RE = new RegExp(
  [
    // +66 81 234 5678, +66-81-234-5678, +6681234567
    String.raw`\+\d[\d\s()-]{6,}\d`,
    // (02) 123-4567, (081)234-5678
    String.raw`\(\d{1,4}\)[\s-]?\d{2,4}[\s-]?\d{3,4}`,
    // 081 234 5678, 081-234-5678, 02-123-4567, 053-123-456 — Thai trunk prefix;
    // maths answers do not start a number with 0. The middle group is 3-4
    // digits: a Thai number is never grouped `0N-NN-NNNN`, but a US-style
    // `01-15-2024` date is, which is the false positive this file used to
    // document as known.
    String.raw`\b0\d{1,3}[\s-]\d{3,4}[\s-]\d{3,4}\b`,
    // 123-456-7890 — NANP grouping. Previously `\d{2,4}-\d{2,4}-\d{3,4}`, which
    // is the shape of a subtraction chain (`1000-200-300`, PRO-32) and of a
    // US-style `01-15-2024` date. Every dashed Thai number starts with a 0
    // trunk group and is caught by the rule above, so this narrowing costs
    // nothing real.
    String.raw`\b\d{3}-\d{3}-\d{4}\b`,
    // 0812345678 — a contiguous run longer than ordinary schoolwork.
    String.raw`\b\d{9,}\b`,
  ].join("|"),
  "g",
);

/**
 * Thai national ID, in the two shapes it is actually written: 13 contiguous
 * digits, or the `X-XXXX-XXXXX-XX-X` grouping.
 *
 * It used to accept any 13 digits with an optional separator between each one,
 * which meant "10 20 30 40 50 60 70 80 90 100" — 13 digits — was redacted as a
 * national ID. Same failure mode as `PHONE_RE` below: a loose digit run is a
 * child's maths answer far more often than it is an identifier.
 */
const THAI_ID_RE = new RegExp(
  [
    String.raw`\b\d{13}\b`,
    String.raw`\b\d[\s-]\d{4}[\s-]\d{5}[\s-]\d{2}[\s-]\d\b`,
  ].join("|"),
  "g",
);
const URL_CREDENTIALS_RE = /\/\/[^/\s:@]+:[^/\s:@]+@/g;

/**
 * Units a STEAM lesson actually writes after a number. Longest-first so `km`
 * is preferred over `m`, and `ms` over `m`.
 */
const LATIN_UNITS = [
  // length
  "nm", "µm", "um", "mm", "cm", "dm", "km", "m", "ft", "mi", "yd",
  // volume (area/volume exponents are handled by the optional suffix below)
  "ml", "cl", "dl", "l", "cc",
  // mass
  "mg", "kg", "g", "t", "lb", "oz",
  // time — `in` is deliberately absent; it is an English word far more often
  // than it is inches, and "0812345678 in the morning" must stay redacted.
  "ms", "ns", "s", "sec", "secs", "min", "mins", "hr", "hrs", "h", "d", "wk",
  "yr", "yrs",
  // mechanics, energy, power
  "kN", "N", "kJ", "MJ", "J", "kcal", "cal", "kWh", "Wh", "kW", "MW", "W",
  "kPa", "Pa", "bar", "atm",
  // electricity and frequency
  "mV", "kV", "V", "mA", "A", "ohm", "Hz", "kHz", "MHz", "GHz",
  // temperature and misc
  "°C", "°F", "K", "C", "F", "%", "px", "rpm", "bpm", "mol", "pH",
]
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
  .join("|");

/** Thai unit and counter words. Thai has no word boundaries, so no `\b` here. */
const THAI_UNITS = [
  "กิโลเมตร", "เซนติเมตร", "มิลลิเมตร", "กิโลกรัม", "มิลลิลิตร", "ชั่วโมง",
  "วินาที", "องศา", "เมตร", "กรัม", "ลิตร", "นาที", "หน่วย", "ปีแสง",
  "กม", "ซม", "มม", "กก", "มล", "ลบ", "คน", "ตัว", "ปี", "วัน", "ม", "ล", "ก",
].join("|");

/**
 * A unit immediately after the number, optionally squared/cubed and optionally
 * as a rate (`m/s`, `km/h`). The trailing lookahead — rather than `\b` — is so
 * `%`, `°C` and Thai units terminate correctly, and so `d` does not match the
 * `d` of "dollars".
 */
const UNIT_SUFFIX_RE = new RegExp(
  String.raw`^[ \t\u00a0]{0,2}(?:` +
    String.raw`(?:${LATIN_UNITS})(?:[²³]|\^?[23])?` +
    String.raw`(?:[ \t]?/[ \t]?(?:${LATIN_UNITS})(?:[²³]|\^?[23])?)?` +
    String.raw`|(?:${THAI_UNITS})\.?` +
    String.raw`)(?![\p{L}\p{N}])`,
  "iu",
);

/**
 * Operators that mark the surrounding phrase as arithmetic rather than contact
 * details. `-` and `/` are excluded (a phone number is full of them) and so is
 * `*` (markdown emphasis would launder any number inside `**…**`). A `+` only
 * counts when a digit precedes it, so a `+66` country code never qualifies.
 */
const MATH_OPERATOR_RE = /[=×÷≈≠≥≤−]|(?<=\d[ \t]?)\+/u;

/** If the writer is plainly giving out contact details, no exemption applies. */
const CONTACT_WORD_RE =
  /\b(?:tel|telephone|phone|mobile|cell|call|fax|contact|whatsapp|line ?id)\b|โทร|เบอร์|มือถือ|ติดต่อ/i;

/** How far either side of a match we look for context. */
const CONTEXT_CHARS = 32;

/**
 * Is this `PHONE_RE` match a quantity out of a lesson rather than a number to
 * dial? (PRO-32: `149600000 km`, `299792458 m/s` and `1000-200-300 = 500` were
 * all being blanked, which made a grading trace unreadable — the exact failure
 * PRO-23 was opened for.)
 *
 * Both reported shapes are separable from a phone number by their *context*,
 * not by the digits themselves, so that is what this checks: a unit directly
 * after the number, or an arithmetic operator in the same line.
 *
 * Three things can never earn the exemption, so widening the context rules
 * later cannot re-open a leak through them:
 *   - a match containing `+` or `()` — that is phone punctuation, not maths;
 *   - a match starting with `0` — a trunk prefix, and a quantity is not
 *     written with a leading zero (`0812345678 km` stays redacted);
 *   - a match in a phrase that names a phone (`โทร`, `call`, `mobile`, …).
 *
 * This stays a safety net, not the defence. Free text a child typed should
 * reach an external service as `referenceOnly()` in the first place, which is
 * what `traceAiCall` and the AI client already default to.
 */
function isSchoolworkQuantity(
  match: string,
  text: string,
  index: number,
): boolean {
  if (/[+()]/.test(match)) return false;
  if (match.startsWith("0")) return false;

  const before = text.slice(Math.max(0, index - CONTEXT_CHARS), index);
  const after = text.slice(
    index + match.length,
    index + match.length + CONTEXT_CHARS,
  );
  // Context does not cross a line break.
  const line =
    before.slice(before.lastIndexOf("\n") + 1) +
    match +
    after.split("\n")[0];

  if (CONTACT_WORD_RE.test(line)) return false;
  if (UNIT_SUFFIX_RE.test(after)) return true;
  return MATH_OPERATOR_RE.test(line);
}

/**
 * Strict key-only verdict. `redactDeep` may still export a denied key when
 * `isNumericMeasurement` exempts it, so this is the conservative answer, not
 * necessarily the one the walker reaches.
 */
export function isDeniedKey(key: string): boolean {
  return DENIED_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** Scrub identifiers out of a free-text string. Best effort, never trusted alone. */
export function scrubText(value: string): string {
  return (
    value
      .replace(URL_CREDENTIALS_RE, "//" + REDACTED + "@")
      .replace(EMAIL_RE, REDACTED)
      // A national ID is the highest-stakes identifier here and gets no
      // schoolwork exemption: it runs first and unconditionally.
      .replace(THAI_ID_RE, REDACTED)
      .replace(PHONE_RE, (match, ...rest) => {
        // `PHONE_RE` has no capture groups, but read the trailing args by
        // position so adding one later cannot silently shift these.
        const text = rest[rest.length - 1] as string;
        const index = rest[rest.length - 2] as number;
        return isSchoolworkQuantity(match, text, index) ? match : REDACTED;
      })
  );
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Walk an arbitrary value and redact denied keys and identifier-shaped text.
 * Genuine cycles are replaced with `"[CIRCULAR]"`; depth is capped so a hostile
 * or accidentally huge payload cannot stall the request.
 *
 * "Cycle" means an object that contains itself along the current path — not an
 * object that simply appears twice. A shared object (the same rubric criterion
 * referenced from two places in trace metadata) is walked at every position it
 * occurs. Because `seen` tracks path ancestry, a wide shared graph can be
 * re-walked; `maxDepth` is what bounds that work.
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
    // `seen` is the ancestry of the current path, not every object ever visited:
    // we drop `obj` again once its subtree is done so a parallel second
    // reference to the same object is still walked instead of silently becoming
    // "[CIRCULAR]".
    if (seen.has(obj)) return "[CIRCULAR]";
    seen.add(obj);

    try {
      if (Array.isArray(value)) {
        return value.map((item) => walk(item, depth - 1, seen));
      }

      const out: { [key: string]: Json } = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const denied = isDeniedKey(key) && !isNumericMeasurement(key, item);
        out[key] = denied ? REDACTED : walk(item, depth - 1, seen);
      }
      return out;
    } finally {
      seen.delete(obj);
    }
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
