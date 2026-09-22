/**
 * Seed `events.event_registry` from `src/lib/events/event-registry.v1.json`.
 *
 * The JSON file stays the source of truth (PRO-17 decision 3). This script
 * compiles its short type hints into JSON Schema with the *same* compiler
 * `POST /api/events` validates against, so the column and the gate cannot drift
 * apart — which is the only reason storing the schema in a table is worth
 * anything.
 *
 * Idempotent: re-running after a registry bump upserts every row. Rows for
 * event versions no longer in the file are left alone; an event stored last
 * month still needs its schema to explain itself.
 *
 *   npm run db:seed:registry              # needs DATABASE_URL
 *   npm run db:seed:registry -- --print   # write the SQL to stdout instead
 */

import { Pool } from "pg";

import registryFile from "../src/lib/events/event-registry.v1.json";
import {
  assertRegistryInvariants,
  compileEventPayloadSchema,
} from "../src/lib/events/payload-schema";
import type { EventDefinition } from "../src/lib/events/registry";

interface RegistryFile {
  readonly registryVersion: string;
  readonly events: readonly EventDefinition[];
}

const file = registryFile as unknown as RegistryFile;

const UPSERT = `INSERT INTO events.event_registry (
  event_name, event_version, event_group, trigger_description, payload_schema,
  pii_class, retention_days, exportable, required_consent_scope, registry_version, seeded_at
) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, now())
ON CONFLICT (event_name, event_version) DO UPDATE SET
  event_group = EXCLUDED.event_group,
  trigger_description = EXCLUDED.trigger_description,
  payload_schema = EXCLUDED.payload_schema,
  pii_class = EXCLUDED.pii_class,
  retention_days = EXCLUDED.retention_days,
  exportable = EXCLUDED.exportable,
  required_consent_scope = EXCLUDED.required_consent_scope,
  registry_version = EXCLUDED.registry_version,
  seeded_at = now()`;

function rowFor(definition: EventDefinition): unknown[] {
  return [
    definition.name,
    definition.version,
    definition.group,
    definition.trigger,
    JSON.stringify(compileEventPayloadSchema(definition)),
    definition.piiClass,
    definition.retentionDays,
    definition.exportable,
    definition.requiredConsentScope ?? "behaviour_events",
    file.registryVersion,
  ];
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  // A hint the grammar does not cover must fail here, loudly, and never
  // degrade to `{}` — an empty schema validates everything, which is how
  // unvalidated child-typed text would reach an append-only table.
  assertRegistryInvariants();

  const rows = file.events.map(rowFor);

  if (process.argv.includes("--print")) {
    for (const row of rows) {
      const inlined = UPSERT.replace(
        /\$(\d+)/g,
        (_match, index: string) => literal(row[Number(index) - 1]),
      );
      process.stdout.write(`${inlined};\n`);
    }
    process.stdout.write(
      `-- ${rows.length} events, registryVersion ${file.registryVersion}\n`,
    );
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Use --print to emit SQL instead.");
  }

  const pool = new Pool({ connectionString });
  try {
    for (const row of rows) {
      await pool.query(UPSERT, row);
    }
    const { rows: counted } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events.event_registry WHERE registry_version = $1",
      [file.registryVersion],
    );
    console.log(
      `seeded ${rows.length} events; events.event_registry now holds ${counted[0]?.count} rows at registryVersion ${file.registryVersion}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
