/**
 * The behaviour event registry, as decided on PRO-3.
 *
 * `event-registry.v1.json` is a verbatim copy of the file CTO attached to
 * PRO-3. Backend seeds `events.event_registry` from the same file, so the
 * emitter (this app) and the ingest endpoint agree on names and fields by
 * construction instead of by memory.
 *
 * Two rules from that document are enforced here rather than left to review:
 *
 *   - an event name outside the registry is never sent (the server would have
 *     to dead-letter it, and nobody would notice the gap for weeks)
 *   - a payload key the registry does not declare is never sent, which is what
 *     keeps a child's typed answer from sliding into an event by accident
 *
 * Adding a field means bumping `version` and adding a registry row — never
 * changing what an existing field means.
 */

import registryFile from "./event-registry.v1.json";

export type PiiClass = "none" | "pseudonymous" | "content_hash";

export interface EventDefinition {
  readonly name: string;
  readonly version: number;
  readonly group: string;
  readonly trigger: string;
  /** Field name → human-readable type from the registry, e.g. `"int"`. */
  readonly payload: Readonly<Record<string, string>>;
  readonly piiClass: PiiClass;
  readonly retentionDays: number;
  readonly exportable: boolean;
}

interface RegistryFile {
  readonly registryVersion: string;
  readonly events: readonly EventDefinition[];
}

const file = registryFile as unknown as RegistryFile;

export const REGISTRY_VERSION = file.registryVersion;

const BY_NAME: ReadonlyMap<string, EventDefinition> = new Map(
  file.events.map((definition) => [definition.name, definition]),
);

/** Every event name the product is allowed to emit. */
export const EVENT_NAMES: readonly string[] = file.events.map((definition) => definition.name);

export type EventName = (typeof EVENT_NAMES)[number];

export function getEventDefinition(name: string): EventDefinition | undefined {
  return BY_NAME.get(name);
}

export function isRegisteredEvent(name: string): boolean {
  return BY_NAME.has(name);
}

/**
 * Consent gate: `behaviour_events` must be granted before anything is emitted.
 *
 * The two consent events themselves are the exception, and have to be. A
 * revocation happens at the moment consent turns off, so gating it on consent
 * would mean we could never record that it happened.
 */
export const CONSENT_EXEMPT_EVENTS: readonly string[] = ["consent.granted", "consent.revoked"];

/**
 * Longest string we will put in an event payload.
 *
 * Every legitimate string field in the registry is an id, a slug, an enum or a
 * hash. A value longer than this is the signature of a child's typed answer
 * leaking into the behaviour pipe, so we drop the event and report a violation
 * rather than shipping it and finding out from a data audit months later.
 */
export const MAX_PAYLOAD_STRING_LENGTH = 200;
