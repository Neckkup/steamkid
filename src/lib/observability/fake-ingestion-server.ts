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
export interface FakeIngestion {
  baseUrl: string;
  /** Every ingestion event the SDK has sent, in order. */
  events: IngestionEvent[];
  /** The raw request bodies, for "does this string appear anywhere" assertions. */
  rawBodies: string[];
  reset(): void;
  close(): Promise<void>;
}

export interface IngestionEvent {
  type: string;
  body: Record<string, unknown>;
}

export async function startFakeIngestion(): Promise<FakeIngestion> {
  const events: IngestionEvent[] = [];
  const rawBodies: string[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");

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

      // Prompt fetches and anything else: 404 so callers exercise the fallback
      // path deterministically instead of hanging.
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
    reset() {
      events.length = 0;
      rawBodies.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
