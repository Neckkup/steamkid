/**
 * Does this instance still accept the events our SDK actually sends?
 *
 * Why this exists as a separate check from `langfuse-version.ts`: a v4 instance
 * satisfies the major-version requirement and still silently refuses every
 * trace we emit. Langfuse v4 introduces `LANGFUSE_MIGRATION_V4_WRITE_MODE`, and
 * on `events_only` the `/api/public/ingestion` endpoint accepts only score and
 * log events. `trace-create`, `generation-create` and `generation-update` — the
 * three event types the `langfuse` v3 JS SDK in our `package.json` emits for
 * every AI call — are rejected per-event inside an HTTP **207**.
 *
 * That 207 is the trap this check exists to close. The SDK logs the rejection
 * and moves on, `flushAsync()` resolves, `callModel()` returns a trace id and a
 * trace URL, and the smoke script prints a link that looks real. Nothing landed.
 * `GET /api/public/traces/:id` also 404s in this mode, so there is no read path
 * that would contradict the happy-looking output either.
 *
 * Found on 2026-09-19 (PRO-29) against Langfuse 4.37.0: the version check
 * passed, the hardening checks ran, and the smoke run still produced no trace.
 * A check is cheaper than the next person re-deriving that from a dead link.
 *
 * The probe therefore asks two questions, not one. Acceptance is not storage:
 * `LANGFUSE_MIGRATION_V4_WRITE_MODE` is read by `langfuse-web` *and*
 * `langfuse-worker`, and flipping only the web service leaves an instance that
 * takes the batch with a clean 207 and drops it in the worker that never
 * persists it. That failure looks identical to a working instance from the
 * ingest side — which is precisely the shape of bug this module already exists
 * to catch. So after a clean acceptance the probe reads its own trace back, and
 * only a trace that reads back counts as a pass.
 */

/** Ingestion event types `traceAiCall` emits for every AI call. */
const REQUIRED_EVENT_TYPES = [
  "trace-create",
  "generation-create",
  "generation-update",
] as const;

export type WriteModeStatus =
  | "ok"
  | "not_configured"
  | "unreachable"
  | "unauthorized"
  | "events_only"
  /** Ingestion accepted the batch, but the trace never became readable. */
  | "not_readable";

export interface LangfuseWriteModeCheck {
  ok: boolean;
  status: WriteModeStatus;
  /** Event types this instance refused, when it refused any. */
  rejectedEventTypes: string[];
  /** Operator-facing explanation. Never contains a key or a credential. */
  reason: string;
  /** What to change to make the ingestion path usable again. */
  remedy: string | null;
}

export interface WriteModeCheckOptions {
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Read-back attempts after a clean acceptance. Tests pass 1. */
  readBackAttempts?: number;
  /** Pause between read-back attempts. Tests pass 0 to stay instant. */
  readBackDelayMs?: number;
}

const REMEDY =
  "Either set LANGFUSE_MIGRATION_V4_WRITE_MODE=dual on both the langfuse-web " +
  "and langfuse-worker services and redeploy (the upstream migration bridge), " +
  "or move this app off the v3 `langfuse` SDK onto a v4 client / OTLP " +
  "ingestion path. Until one of those happens, no AI call in this repo is " +
  "traced — see docs/runbooks/langfuse-self-host.md.";

const READ_BACK_REMEDY =
  "Most likely LANGFUSE_MIGRATION_V4_WRITE_MODE was changed on langfuse-web " +
  "but not on langfuse-worker: the web service then accepts the batch and the " +
  "worker never persists it. Set the same value on BOTH services, restart " +
  "both, and check `docker compose logs langfuse-worker` for ingestion errors " +
  "— see docs/runbooks/langfuse-self-host.md.";

/**
 * Probe `/api/public/ingestion` with one deliberately inert event of each type
 * we depend on.
 *
 * The probe is a real write when the instance accepts it, so it is named and
 * tagged to be obviously disposable rather than mistaken for a product trace.
 * It carries no learner reference and no input/output content at all, which is
 * also what makes it safe to run against an instance that is not yet hardened.
 */
export async function checkLangfuseWriteMode(
  options: WriteModeCheckOptions = {},
): Promise<LangfuseWriteModeCheck> {
  const baseUrl = options.baseUrl?.trim();
  const publicKey = options.publicKey?.trim();
  const secretKey = options.secretKey?.trim();

  if (!baseUrl || !publicKey || !secretKey) {
    return {
      ok: false,
      status: "not_configured",
      rejectedEventTypes: [],
      reason:
        "LANGFUSE_BASEURL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must all " +
        "be set before the ingestion path can be probed.",
      remedy: null,
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/$/, "")}/api/public/ingestion`;
  const traceId = `langfuse-verify-writemode-${Date.now()}`;
  const timestamp = new Date().toISOString();

  // One event per required type. `generation-update` reuses the generation id so
  // the batch is internally consistent on an instance that does accept it.
  const generationId = `${traceId}-gen`;
  const batch = [
    {
      id: `${traceId}-e0`,
      type: "trace-create",
      timestamp,
      body: {
        id: traceId,
        name: "langfuse-verify.write-mode-probe",
        tags: ["ops", "preflight", "disposable"],
      },
    },
    {
      id: `${traceId}-e1`,
      type: "generation-create",
      timestamp,
      body: { id: generationId, traceId, name: "langfuse-verify.write-mode-probe" },
    },
    {
      id: `${traceId}-e2`,
      type: "generation-update",
      timestamp,
      body: { id: generationId, traceId },
    },
  ];

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
      },
      body: JSON.stringify({ batch }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    return {
      ok: false,
      status: "unreachable",
      rejectedEventTypes: [],
      reason: `${url} could not be reached: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      remedy: null,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      status: "unauthorized",
      rejectedEventTypes: [],
      reason: `${url} rejected the Langfuse keys with HTTP ${response.status}.`,
      remedy: "Check LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY belong to this instance.",
    };
  }

  // A 207 carries a per-event verdict, which is the only place `events_only`
  // shows up. Anything unreadable is treated as a failure rather than waved
  // through — a check that cannot tell is not a check that passed.
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const rejected = rejectedTypes(payload, batch);

  if (rejected.length > 0) {
    return {
      ok: false,
      status: "events_only",
      rejectedEventTypes: rejected,
      reason:
        `${url} refused ${rejected.join(", ")} — this instance runs with ` +
        `LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only, which accepts only score ` +
        `and log events. Our SDK's traces are dropped inside an HTTP 207, so ` +
        `every AI call still returns a trace URL that resolves to nothing.`,
      remedy: REMEDY,
    };
  }

  if (!response.ok && response.status !== 207) {
    return {
      ok: false,
      status: "unreachable",
      rejectedEventTypes: [],
      reason: `${url} returned HTTP ${response.status}.`,
      remedy: null,
    };
  }

  // Acceptance is a receipt, not a record. Read the probe trace back before
  // calling the ingestion path usable — see the module header.
  const readBack = await traceReadsBack({
    baseUrl,
    traceId,
    fetchImpl,
    publicKey,
    secretKey,
    attempts: options.readBackAttempts ?? 8,
    delayMs: options.readBackDelayMs ?? 2_000,
    timeoutMs: options.timeoutMs ?? 10_000,
  });

  if (!readBack) {
    return {
      ok: false,
      status: "not_readable",
      rejectedEventTypes: [],
      reason:
        `${url} accepted ${REQUIRED_EVENT_TYPES.join(", ")}, but the probe trace ` +
        `never became readable at /api/public/traces/${traceId}. The instance ` +
        `takes our events and does not store them, so every AI call still ` +
        `returns a trace URL that resolves to nothing.`,
      remedy: READ_BACK_REMEDY,
    };
  }

  return {
    ok: true,
    status: "ok",
    rejectedEventTypes: [],
    reason:
      `${url} accepted ${REQUIRED_EVENT_TYPES.join(", ")} and the probe trace ` +
      `read back from /api/public/traces/:id; traces from this app will land.`,
    remedy: null,
  };
}

/**
 * Poll the trace read API until the probe trace appears.
 *
 * Ingestion is queued and processed by `langfuse-worker`, so a single immediate
 * read would fail on a perfectly healthy instance. A network flake on one
 * attempt is likewise not a verdict — only exhausting every attempt is.
 */
async function traceReadsBack(options: {
  baseUrl: string;
  traceId: string;
  fetchImpl: typeof fetch;
  publicKey: string;
  secretKey: string;
  attempts: number;
  delayMs: number;
  timeoutMs: number;
}): Promise<boolean> {
  const url = `${options.baseUrl.replace(/\/$/, "")}/api/public/traces/${options.traceId}`;
  const authorization = `Basic ${Buffer.from(
    `${options.publicKey}:${options.secretKey}`,
  ).toString("base64")}`;

  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    if (attempt > 0 && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    try {
      const response = await options.fetchImpl(url, {
        headers: { authorization, accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (response.ok) return true;
    } catch {
      // Keep polling; the loop as a whole decides.
    }
  }
  return false;
}

/**
 * Pull the event types an ingestion response rejected. Langfuse reports these as
 * `errors: [{ id, status, message, error }]`, keyed by the per-event `id` we
 * sent, so the id is mapped back to its type rather than guessed from prose.
 */
function rejectedTypes(
  payload: unknown,
  batch: readonly { id: string; type: string }[],
): string[] {
  if (typeof payload !== "object" || payload === null) return [];

  // Langfuse has shipped both `{ errors: [...] }` and a bare array of verdicts.
  const container = payload as { errors?: unknown };
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(container.errors)
      ? container.errors
      : [];

  const typeById = new Map(batch.map((event) => [event.id, event.type]));
  const rejected = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, status } = entry as { id?: unknown; status?: unknown };
    if (typeof status === "number" && status < 400) continue;
    const type = typeof id === "string" ? typeById.get(id) : undefined;
    if (type) rejected.add(type);
  }

  // Preserve the declared order so the message reads the same every run.
  return REQUIRED_EVENT_TYPES.filter((type) => rejected.has(type));
}
