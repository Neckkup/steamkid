import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the Langfuse ingestion endpoint, used by tests only.
 *
 * It exists so we can assert on the exact bytes the SDK puts on the wire. Any
 * other way of checking redaction — inspecting our own objects before handing
 * them to the SDK — tests the wrong thing: what matters is what actually leaves
 * the process. This is a test double, not an observability backend; Langfuse
 * remains the only place traces are stored.
 */
/**
 * How this double answers the three unauthenticated probes in
 * `langfuse-hardening.ts`.
 *
 * The hardening gate sits in front of every learner-bound trace now, so the
 * double has to have a hardening posture at all — a server that 404s the
 * hardening endpoints is not "neutral", it is the *dead instance* case, and
 * every test using it would silently be testing a suppressed trace.
 *
 * - `hardened` — live, `NEXTAUTH_URL` is https, registration refused on policy.
 * - `open-signup` — live and reachable, but anyone can register: `ok: false`.
 * - `dead` — 404s on every path including health, the shape that made the
 *   signup probe read a vanished host as the strongest possible pass:
 *   `reachable: false`.
 */
export type FakeHardening = "hardened" | "open-signup" | "dead";

export interface FakeIngestion {
  baseUrl: string;
  /** Every ingestion event the SDK has sent, in order. */
  events: IngestionEvent[];
  /** The raw request bodies, for "does this string appear anywhere" assertions. */
  rawBodies: string[];
  /** Every request path this server has served, for counting probes. */
  paths: string[];
  reset(): void;
  close(): Promise<void>;
}

export interface IngestionEvent {
  type: string;
  body: Record<string, unknown>;
}

export interface FakeIngestionOptions {
  /** Defaults to `hardened`, so a test that says nothing is not gated. */
  hardening?: FakeHardening;
}

export async function startFakeIngestion(
  options: FakeIngestionOptions = {},
): Promise<FakeIngestion> {
  const hardening = options.hardening ?? "hardened";
  const events: IngestionEvent[] = [];
  const rawBodies: string[] = [];
  const paths: string[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = (req.url ?? "").split("?")[0];
      paths.push(path);

      // Ingestion answers the same way regardless of hardening posture. An
      // unhardened Langfuse happily accepts traces — that is exactly why the
      // gate has to be on our side of the wire, and it is what lets a test
      // assert "nothing arrived" and mean it.
      if (req.url?.includes("/api/public/ingestion")) {
        rawBodies.push(raw);
        try {
          const parsed = JSON.parse(raw) as { batch?: IngestionEvent[] };
          for (const event of parsed.batch ?? []) events.push(event);
        } catch {
          // A body we cannot parse is itself a finding; keep the raw copy.
        }
        res.writeHead(207, { "content-type": "application/json" });
        res.end(JSON.stringify({ successes: [], errors: [] }));
        return;
      }

      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (hardening !== "dead") {
        if (path === "/api/public/health") return json(200, { status: "OK", version: "4.37.0" });

        // A TLS-terminated instance advertises https here; `checkCanonicalUrlTls`
        // reads the advertised origin, not the scheme this request arrived on,
        // which is the whole point of that check.
        if (path === "/api/auth/providers") {
          return json(200, {
            credentials: {
              id: "credentials",
              signinUrl: "https://langfuse.test.invalid/api/auth/signin/credentials",
              callbackUrl: "https://langfuse.test.invalid/api/auth/callback/credentials",
            },
          });
        }

        if (path === "/api/auth/signup") {
          return hardening === "hardened"
            ? // Refused on policy, before the body is even validated.
              json(422, { message: "Sign up is disabled on this instance." })
            : // Fell through to schema validation — registration is open.
              json(400, { message: "Invalid request body: email is required" });
        }
      }

      // Prompt fetches and anything else: 404 so callers exercise the fallback
      // path deterministically instead of hanging. In `dead` mode this is every
      // path, including health — the real 2026-09-22 failure.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    events,
    rawBodies,
    paths,
    reset() {
      events.length = 0;
      rawBodies.length = 0;
      paths.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
