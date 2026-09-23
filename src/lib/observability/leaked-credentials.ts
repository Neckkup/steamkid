import type { HardeningFinding } from "@/lib/observability/langfuse-hardening";

/**
 * The credentials pasted in clear text on PRO-30 on 2026-09-19, and whether they
 * still open anything.
 *
 * `langfuse-hardening.ts` asks whether the *instance* is safe to hold a child's
 * answer. This file asks the question one layer in: who else can read it once it
 * is there. A hardened Langfuse with a leaked project key is not a private one —
 * `/api/public/*` hands every trace in the project to anyone holding the pair,
 * and redaction cannot help, because redaction removes identifiers from inside a
 * trace and this is somebody reading everything that is left.
 *
 * ## Why this is a gate and not a checklist item
 *
 * The founder accepted this risk deliberately on PRO-74 while Langfuse held only
 * our own test traces, and asked to be reminded before the pilot takes real
 * students (PRO-101). "Remind someone later" is not a control. This is: the day
 * a trace carries a real learner, `trace-destination.ts` refuses to send it
 * until the leak is provably closed.
 *
 * ## What 2026-09-23 showed, and why the check has the shape it has
 *
 * The obvious implementation — compare the credential we are configured with
 * against the leaked one — would have passed, and passing would have been wrong.
 * Probing the live instance that day found **two** working key pairs on the
 * `steamkid` project: the one the app now uses, and the 2026-09-19 pair, still
 * answering 200 on `/api/public/projects`. A new pair had been issued; the
 * leaked pair had never been deleted. Rotation is not "the app uses a new key",
 * it is "the old key stopped working", and only the old key can testify to that.
 *
 * So the proof of revocation is a live probe *with the leaked pair*, which means
 * this process has to be handed the leaked pair to probe with. Two rules keep
 * that from turning into a new leak or a rubber stamp:
 *
 * - **Never in the repo.** `LANGFUSE_REVOKED_PUBLIC_KEY` / `_SECRET_KEY` come
 *   from the environment. What is pinned below is SHA-256 of each value, which
 *   identifies a 42-character random key without being usable as one.
 * - **Pinned, so the proof cannot be faked.** A supplied pair that does not
 *   match the recorded digests is rejected outright. Otherwise "revocation" could
 *   be demonstrated with any string, since any string gets a 401.
 *
 * ## Self-clearing, and only in the true direction
 *
 * Nothing here has to be edited when the leak is finally closed. Delete the old
 * pair in the Langfuse UI and the next probe gets a 401, the finding flips to
 * `ok`, and learner traces flow — within one `PASS_TTL_MS`, with no deploy. The
 * gate can open itself on evidence; it cannot close itself on a promise.
 */

/**
 * SHA-256 of each value leaked on PRO-30, 2026-09-19.
 *
 * Safe to commit, including to a public repo: SHA-256 of a high-entropy random
 * key is not reversible, and the digest becomes inert the moment the key is
 * deleted. Recording them is what lets this file recognise a leaked credential
 * later without anyone having to remember which one it was.
 */
export const LEAKED_2026_09_19: LeakedDigests = {
  langfusePublicKey: "2e7dc28187f0450ad3df54e834b7850d67280e5edf8ad33ed70265d04234bca0",
  langfuseSecretKey: "a43cd65ab00d0bbbcd94f5e99bca352c0738bf33d625545e7b3f47020bb3f82f",
  geminiApiKey: "39aaa49c931ce60b2a6aa3a30196228aeffa4098123ae44dfabe2997a327fe94",
};

export interface LeakedDigests {
  langfusePublicKey: string;
  langfuseSecretKey: string;
  geminiApiKey: string;
}

/**
 * The digest set the checks below compare against.
 *
 * Injected by tests only. A test cannot produce a preimage of a pinned digest —
 * that is the entire point of pinning one — so exercising the branch where a
 * credential *is* the leaked one requires naming a different expectation. Every
 * product caller passes `LEAKED_2026_09_19`, and the default is that constant,
 * so a missing argument cannot quietly widen what counts as clean.
 */
type Expectation = { expected?: LeakedDigests };

/** Web Crypto rather than `node:crypto`, so the gate survives an edge runtime. */
async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface CredentialsInUse {
  langfusePublicKey?: string;
  langfuseSecretKey?: string;
  geminiApiKey?: string;
}

/**
 * Is a credential we are *currently configured with* one of the leaked ones?
 *
 * Local, no network, no way to be inconclusive. Severity is per credential and
 * follows this repo's definition of `blocker` — on the path between a child's
 * answer and an attacker:
 *
 * - A leaked **Langfuse** key is on that path: it reads the traces directly.
 * - A leaked **Gemini** key is not. Its holder can spend our budget and, on a
 *   non-billing project, push our prompts into Google's training data, which is
 *   a real problem on its own ticket — but it does not let anyone read a child's
 *   answer back out, and switching our observability off would not fix it.
 */
export async function checkCredentialsInUse(
  credentials: CredentialsInUse & Expectation,
): Promise<HardeningFinding> {
  const expected = credentials.expected ?? LEAKED_2026_09_19;
  const checks: { label: string; value?: string; digest: string; severe: boolean }[] = [
    {
      label: "LANGFUSE_PUBLIC_KEY",
      value: credentials.langfusePublicKey,
      digest: expected.langfusePublicKey,
      severe: true,
    },
    {
      label: "LANGFUSE_SECRET_KEY",
      value: credentials.langfuseSecretKey,
      digest: expected.langfuseSecretKey,
      severe: true,
    },
    {
      label: "GEMINI_API_KEY",
      value: credentials.geminiApiKey,
      digest: expected.geminiApiKey,
      severe: false,
    },
  ];

  const leaked: typeof checks = [];
  for (const check of checks) {
    if (!check.value) continue;
    if ((await sha256Hex(check.value)) === check.digest) leaked.push(check);
  }

  if (leaked.length === 0) {
    return {
      id: "leaked_credentials_in_use",
      ok: true,
      severity: "blocker",
      reason:
        "No credential this process is configured with matches one of the values " +
        "leaked on PRO-30 (2026-09-19).",
      remedy: "None needed.",
    };
  }

  const names = leaked.map((check) => check.label).join(", ");
  return {
    id: "leaked_credentials_in_use",
    ok: false,
    severity: leaked.some((check) => check.severe) ? "blocker" : "warning",
    reason:
      `${names} ${leaked.length === 1 ? "is" : "are"} still set to the value ` +
      "pasted in clear text on PRO-30 on 2026-09-19. Anyone who can read that " +
      "comment holds this credential.",
    remedy:
      "Issue a replacement at the provider (Langfuse → Project Settings → API " +
      "Keys, Google AI Studio → API keys), delete the old one there, and update " +
      "the value on the Paperclip Secrets page. Never in a comment or a commit.",
  };
}

export interface RevocationCheckOptions extends Expectation {
  baseUrl?: string;
  /** The leaked pair, supplied to prove it no longer works. Never committed. */
  revoked?: { publicKey?: string; secretKey?: string };
  /**
   * A pair known to work, used as the control. Without it a blanket 401/403 —
   * an edge rule, a paused project, a WAF — would read as proof of revocation.
   */
  control?: { publicKey?: string; secretKey?: string };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type ProbeResult = "authorised" | "rejected" | "inconclusive";

/**
 * `/api/public/projects` is the smallest authenticated read on the v4 API: it
 * names the project the pair belongs to and returns nothing about any child.
 *
 * Only 401 counts as a rejection. A 403 is left inconclusive on purpose — on
 * 2026-09-23 the edge in front of `langfuse.homekup.com` answered
 * `403 error code: 1010` to a client whose user agent it disliked, identically
 * for a valid pair and a leaked one. Reading that as "revoked" would have turned
 * a bot rule into a security clearance.
 */
async function probe(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/public/projects`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Basic ${btoa(`${publicKey}:${secretKey}`)}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return "authorised";
    if (response.status === 401) return "rejected";
    return "inconclusive";
  } catch {
    return "inconclusive";
  }
}

/**
 * Has the leaked Langfuse pair actually stopped working?
 *
 * Fails closed on every answer that is not a proof, including "we were not given
 * the pair to test with". That default is not a guess: the pair was observed
 * live on the `steamkid` project on 2026-09-23, so "no evidence" and "still
 * open" are the same state until someone shows otherwise.
 */
export async function checkLeakedCredentialsRevoked(
  options: RevocationCheckOptions,
): Promise<HardeningFinding> {
  const baseUrl = options.baseUrl?.trim().replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  const blocked = (reason: string, remedy: string): HardeningFinding => ({
    id: "leaked_credentials_live",
    ok: false,
    severity: "blocker",
    reason,
    remedy,
  });

  const SET_THE_PAIR =
    "Delete the 2026-09-19 key pair in Langfuse → Project Settings → API Keys. " +
    "To let this gate verify that itself, inject the deleted pair as " +
    "LANGFUSE_REVOKED_PUBLIC_KEY / LANGFUSE_REVOKED_SECRET_KEY from the secret " +
    "store — they are the credential we want to prove is dead, so they never go " +
    "in the repo.";

  const publicKey = options.revoked?.publicKey?.trim();
  const secretKey = options.revoked?.secretKey?.trim();

  if (!publicKey || !secretKey) {
    return blocked(
      "The Langfuse pair leaked on PRO-30 (2026-09-19) read the steamkid project " +
        "when it was last probed on 2026-09-23, and this process holds no evidence " +
        "that it has been deleted since. Traces bound to a real learner are not " +
        "sent while a second, published key pair can read them back.",
      SET_THE_PAIR,
    );
  }

  const [publicDigest, secretDigest] = await Promise.all([
    sha256Hex(publicKey),
    sha256Hex(secretKey),
  ]);

  const expected = options.expected ?? LEAKED_2026_09_19;
  if (
    publicDigest !== expected.langfusePublicKey ||
    secretDigest !== expected.langfuseSecretKey
  ) {
    return blocked(
      "LANGFUSE_REVOKED_PUBLIC_KEY / LANGFUSE_REVOKED_SECRET_KEY do not match the " +
        "pair recorded as leaked on 2026-09-19, so a 401 from them would prove " +
        "nothing about the credential that is actually published.",
      SET_THE_PAIR,
    );
  }

  if (!baseUrl) {
    return blocked(
      "No Langfuse base URL is configured, so the leaked pair cannot be tested " +
        "against the instance it opens.",
      "Set LANGFUSE_BASEURL to our self-hosted instance.",
    );
  }

  const control = options.control;
  const [revokedResult, controlResult] = await Promise.all([
    probe(baseUrl, publicKey, secretKey, fetchImpl, timeoutMs),
    control?.publicKey && control.secretKey
      ? probe(baseUrl, control.publicKey, control.secretKey, fetchImpl, timeoutMs)
      : Promise.resolve<ProbeResult>("inconclusive"),
  ]);

  if (revokedResult === "authorised") {
    return blocked(
      `The key pair leaked on PRO-30 (2026-09-19) still reads ${baseUrl} — issuing ` +
        "a second pair did not revoke the first one. Anyone who can read that " +
        "comment can read every trace in the project through /api/public/*.",
      SET_THE_PAIR,
    );
  }

  if (revokedResult === "inconclusive") {
    return blocked(
      `${baseUrl} did not give a usable answer about the leaked pair — neither an ` +
        "authorised read nor a 401. An unanswered question is not a revocation.",
      "Re-run `npm run langfuse:verify` once the instance answers normally.",
    );
  }

  // The leaked pair was rejected. That is only meaningful if the same endpoint
  // would have accepted a pair that works — otherwise everything is being
  // rejected and we have measured an outage, not a revocation.
  if (controlResult !== "authorised") {
    return blocked(
      `${baseUrl} rejected the leaked pair, but the credential this deployment ` +
        "uses did not get through either. That is an instance refusing everyone, " +
        "which says nothing about whether the leaked pair was deleted.",
      "Restore normal API access to the instance, then re-run the check.",
    );
  }

  return {
    id: "leaked_credentials_live",
    ok: true,
    severity: "blocker",
    reason:
      `The key pair leaked on PRO-30 (2026-09-19) is refused by ${baseUrl} (401) ` +
      "while the credential in use is accepted, so the leak is closed at the " +
      "instance rather than merely superseded.",
    remedy: "None needed.",
  };
}
