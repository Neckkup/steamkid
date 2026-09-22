/**
 * Print the event taxonomy as markdown, generated from the registry itself.
 *
 * `npm run events:taxonomy > taxonomy.md`
 *
 * PRO-7 deliverable 3 is a taxonomy document that Coder emits against and
 * AIEngineer reads. The failure mode of such a document is that it is written
 * once by hand and then quietly disagrees with the file the ingest gate
 * validates against — at which point a correctly-fired event gets
 * dead-lettered and nobody knows why. So this generates the document from
 * `event-registry.v1.json`, the same file `seed-event-registry.ts` loads into
 * `events.event_registry`. Regenerate it after any registry change and paste
 * the output into the issue document; a diff in the document is then, by
 * construction, a diff in the contract.
 */

import { readFileSync } from "node:fs";

interface RegistryEvent {
  readonly name: string;
  readonly version: number;
  readonly group: string;
  readonly trigger: string;
  readonly payload: Readonly<Record<string, string>>;
  readonly piiClass: string;
  readonly retentionDays: number;
  readonly exportable: boolean;
  readonly requiredConsentScope?: string;
}

interface Registry {
  readonly registryVersion: string;
  readonly issuedBy: string;
  readonly issue: string;
  readonly note: string;
  readonly piiClasses: Readonly<Record<string, string>>;
  readonly defaults: {
    readonly retentionDays: number;
    readonly exportableForTraining: boolean;
    readonly requiredConsentScope: string;
  };
  readonly events: readonly RegistryEvent[];
}

/** Group order is reading order: a visit, from arriving to being recommended. */
const GROUP_ORDER = [
  "session",
  "lesson",
  "media",
  "exercise",
  "submission",
  "feedback",
  "path",
  "consent",
] as const;

const GROUP_TITLE: Record<string, string> = {
  session: "session — arriving, being present, leaving",
  lesson: "lesson — reading, rereading, how far down the page",
  media: "media — watching, rewatching, giving up",
  exercise: "exercise — the per-question record, where most of the signal is",
  submission: "submission — open-ended work, drafts included",
  feedback: "feedback — what the child did with what the AI said",
  path: "path — what we recommended and whether it was taken",
  consent: "consent — the audit mirror (never exported)",
};

function escapePipes(text: string): string {
  return text.replaceAll("|", "\\|");
}

function main(): void {
  const registry = JSON.parse(
    readFileSync(new URL("../src/lib/events/event-registry.v1.json", import.meta.url), "utf8"),
  ) as Registry;

  const out: string[] = [];
  const line = (text = "") => out.push(text);

  line(`# Event taxonomy — registry ${registry.registryVersion}`);
  line();
  line(
    `Generated from \`src/lib/events/event-registry.v1.json\` by \`npm run events:taxonomy\`.` +
      ` Do not hand-edit this document: edit the registry and regenerate, so the taxonomy` +
      ` and the gate that validates against it cannot disagree.`,
  );
  line();
  line(`- **Events:** ${registry.events.length} across ${GROUP_ORDER.length} groups`);
  // Paperclip renders this as an issue document, where a bare ticket id is a
  // dead end and a linked one is not.
  const issueLink = `[${registry.issue}](/PRO/issues/${registry.issue})`;
  line(`- **Registry issued by:** ${registry.issuedBy} (${issueLink})`);
  line(
    `- **Emitted by:** Coder (browser tracker) · **Validated and stored by:** Backend` +
      ` (\`POST /api/events\`) · **Consumed by:** AIEngineer (\`ml.v_behaviour_sequences\`)`,
  );
  line();
  line(`## The contract`);
  line();
  line(`${registry.note}`);
  line();
  line(
    "`event_name` + `event_version` is the contract. Adding a field means bumping" +
      " `event_version` and adding a registry row — never repurpose an existing field." +
      " A consumer written today must not break when a field is added tomorrow, so read" +
      " payload fields by name and ignore ones you do not know.",
  );
  line();
  line("### Envelope (every event, regardless of name)");
  line();
  line("| Field | Meaning |");
  line("| --- | --- |");
  line(
    "| `event_id` | Client-minted UUIDv7. **The de-duplication key** — a retry must reuse it. `event_time` (the partition key) is derived from it, so a restamped retry still lands on the same row. |",
  );
  line(
    "| `client_seq` | Per-session counter. The ordering that survives a wrong device clock; `occurred_at` does not. |",
  );
  line("| `event_name`, `event_version` | Must match a registry row, or the event is dead-lettered. |");
  line("| `occurred_at` | Client clock, ISO 8601. The server records its own `received_at` beside it. |");
  line("| `session_id` | UUIDv7 for the visit. |");
  line("| `registry_version` | Which registry the client validated against. |");
  line("| `payload` | Event-specific, below. Undeclared keys are refused. |");
  line(
    "| `lesson_id`, `item_id`, `submission_id`, `path_step_id`, `verdict_id` | Optional context ids, promoted to columns so the export can join without opening `payload`. |",
  );
  line(
    "| `correlation_id` | Set when the action leads to an AI call. **Same value as the Langfuse trace id** — this is the thread from the child's click through the API to the model call. |",
  );
  line();
  line(
    "Deliberately absent: `learner_id`. The server derives the learner from the HttpOnly" +
      " session cookie (`app.learner.public_ref`). A client that could name the learner could" +
      " also name a different one.",
  );
  line();
  line("### Defaults");
  line();
  line(`- \`retentionDays\`: ${registry.defaults.retentionDays}`);
  line(`- \`exportableForTraining\`: ${String(registry.defaults.exportableForTraining)}`);
  line(`- \`requiredConsentScope\`: \`${registry.defaults.requiredConsentScope}\``);
  line();
  line("### PII classes");
  line();
  for (const [name, meaning] of Object.entries(registry.piiClasses)) {
    line(`- \`${name}\` — ${meaning}`);
  }
  line();
  line(
    "No event carries learner-authored text. Where the text matters, the payload carries a" +
      " hash (`content_hash`, `from_hash`, `to_hash`) so a revision can be detected without" +
      " the words being stored in the behaviour stream.",
  );
  line();

  for (const group of GROUP_ORDER) {
    const events = registry.events.filter((event) => event.group === group);
    if (events.length === 0) continue;

    line(`## ${GROUP_TITLE[group] ?? group} (${events.length})`);
    line();
    line("| Event | v | Fires when | Payload | PII | Keep | Export | Consent |");
    line("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const event of events) {
      const payload = Object.keys(event.payload)
        .map((key) => `\`${key}\``)
        .join(", ");
      line(
        `| \`${event.name}\` | ${event.version} | ${escapePipes(event.trigger)} | ${payload}` +
          ` | ${event.piiClass} | ${event.retentionDays}d | ${event.exportable ? "yes" : "**no**"}` +
          ` | \`${event.requiredConsentScope ?? registry.defaults.requiredConsentScope}\` |`,
      );
    }
    line();
  }

  line("## How the three guarantees are enforced");
  line();
  line(
    "- **Idempotency.** Primary key `(learner_id, event_id, event_time)` where `event_time` is" +
      " derived from `event_id`'s UUIDv7 timestamp, not from the client's `occurred_at`. A" +
      " device that retries with a moved clock still collides on the same row, and the stored" +
      " `occurred_at` stays the first one seen.",
  );
  line(
    "- **Consent at write.** The sink reads `app.consent_current` and withholds any event whose" +
      " `requiredConsentScope` is not granted. The scope that authorised the write is stored on" +
      " the row as `consent_scope_at_write`, so we can answer later what consent was in force at" +
      " the time. `consent.*` events are the exception: they need `service_operation`, because" +
      " gating a revocation on behaviour consent would mean never recording it.",
  );
  line(
    "- **Consent at read and export.** `ml.v_consented_learner` requires `training_use`, which is" +
      " opt-in and defaults to off. `ml.v_behaviour_sequences` selects only exportable events" +
      " from scorable sessions belonging to those learners, and emits `learner_ref`" +
      " (`public_ref`) — it has no `learner_id` column, so identity is excluded by construction" +
      " rather than by remembering to drop it.",
  );
  line(
    "- **Withdrawal.** Append-only: a withdrawal is a new `app.consent_record` row with" +
      " `granted = false`, never an UPDATE (a trigger raises on any other column change and on" +
      " every DELETE). History is not rewritten — the events remain facts that happened, and the" +
      " export simply stops selecting them.",
  );
  line();
  line(
    "Run `npm run verify:pipeline` to watch all four happen against a throwaway Postgres built" +
      " from `prisma/migrations/`.",
  );
  line();

  console.log(out.join("\n"));
}

main();
