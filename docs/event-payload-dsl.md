# Event payload DSL → JSON Schema (normative)

Owner: CTO · Governs: `src/lib/events/event-registry.v1.json` (`registryVersion 1.0.0`, 39 events)
Consumed by: the `payload_schema` compiler that seeds `events.event_registry` (PRO-7)
Ratified by: PRO-17 decision 3 (`compiler`) · Depends on: `data-schema` §4 (`payload_schema jsonb -- JSON Schema`)

## Why this file exists

PRO-17 decision 3 chose **`compiler`**: `event-registry.v1.json` stays the single
human-readable source of truth, and a build step compiles its short type hints into the
JSON Schema that `events.event_registry.payload_schema` stores and that `POST /api/events`
validates against.

That decision named the *approach* but not the *grammar*. The grammar is the part that can
be got wrong silently, so it is fixed here rather than inferred from the file. A compiler
written by reading the 39 events and pattern-matching will produce schemas that reject
valid events at ingest — and a rejected behaviour event is not a bug report, it is a
`dead_letter` row and a permanently missing signal.

## The grammar

The payload type language is closed. Every one of the 30 distinct expressions in the
registry is one of these nine productions.

```
type      := scalar | enum | format | array | map | nullable
scalar    := "int" | "number" | "string" | "boolean" | "uuid" | "timestamp"
enum      := ("string" | "int") "(" alt ("|" alt)* ")"
format    := "string" "(" formatName ")"        -- formatName ∈ FORMATS, see below
array     := scalar "[]"
map       := "object<" scalar "," scalar ">"
nullable  := (scalar | enum | format) "|null"
```

### Scalars

| DSL | JSON Schema | Note |
| --- | --- | --- |
| `int` | `{"type":"integer"}` | 63 uses — the most common type in the registry |
| `number` | `{"type":"number"}` | `lesson.reread.days_since_last_open`, `media.completed.watched_ratio`. **Not** `integer`; both are genuinely fractional |
| `string` | `{"type":"string","maxLength":200}` | `maxLength` mirrors `MAX_PAYLOAD_STRING_LENGTH` in `src/lib/events/registry.ts`. The client already refuses to send longer; the server must not be more permissive than the client |
| `boolean` | `{"type":"boolean"}` | |
| `uuid` | `{"type":"string","format":"uuid","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}` | `pattern` as well as `format`, because `format` is annotation-only in most validators and these ids are join keys |
| `timestamp` | `{"type":"string","format":"date-time"}` | one use: `session.started.client_clock_at`. It is the **raw child clock**, deliberately unvalidated for plausibility here — skew analysis is the entire point of the field (`data-schema` §4.1) |

### Arrays and maps

| DSL | JSON Schema |
| --- | --- |
| `string[]` | `{"type":"array","items":{"type":"string","maxLength":200}}` |
| `object<string,number>` | `{"type":"object","additionalProperties":{"type":"number"}}` |

`object<string,number>` has exactly one use — `item.presented.skill_weights` — and
`additionalProperties` is correct there: the keys are skill codes, which change as the
skill map grows, so the schema must not enumerate them.

### Nullable

`T|null` compiles to `{"anyOf":[<T>,{"type":"null"}]}`, never to `{"type":["string","null"]}`.
The `anyOf` form composes with `pattern` and `enum`; the type-array form silently drops
them for the null branch in several validators.

Six uses: four `uuid|null`, one `string|null`, and no `int|null` today.

### Enums

`string(a|b|c)` → `{"type":"string","enum":["a","b","c"]}`
`int(25|50|75|100)` → `{"type":"integer","enum":[25,50,75,100]}`

Integer alternatives are parsed as numbers, not left as strings. `int(25|50|75|100)`
producing `enum:["25","50",...]` would reject every real `lesson.scroll_depth` event.

## The ambiguity this document exists to kill

`string(X)` where `X` contains no `|` is **not** unambiguous in the source file. Both of
these appear in the registry and they mean opposite things:

| Expression | Uses | Actual meaning |
| --- | --- | --- |
| `string(sha256_16)` | 3 | a **named format** — the value is a truncated hash, `sha256_16` is not a legal value |
| `string(guardian_web_verified_email)` | 1 | a genuine **single-member enum** — `guardian_web_verified_email` *is* the only legal value |

A compiler that treats every parenthesised token as an enum alternative compiles
`string(sha256_16)` to `enum:["sha256_16"]`, and then every event carrying a real hash
fails validation at ingest.

The events that carry those three fields are `item.answer_changed` (`from_hash`, `to_hash`)
and `submission.draft_saved` (`content_hash`) — the answer-revision signal. Losing them is
not a degraded dashboard, it is the disappearance of "did this child rework their answer",
which is one of the behaviours the growth model is supposed to learn from. Per
`data-schema`, data not captured on the first user is gone for good.

### Resolution rule (normative)

```
FORMATS = { "sha256_16" }          -- closed table, extended only by editing this file
```

For `string(X)` with no `|`:

1. if `X ∈ FORMATS` → emit that format's schema
2. otherwise → emit `{"type":"string","enum":["X"]}`

**`sha256_16` compiles to:**

```json
{ "type": "string", "pattern": "^([0-9a-f]{16})?$" }
```

Three properties of that pattern are load-bearing, all three verified against
`src/lib/events/hash.ts`:

- **16 characters, not 16 bytes.** `ANSWER_HASH_LENGTH = 16` and `answerHash()` slices the
  hex string to 16 characters. The name reads like bytes; it is not.
- **Lowercase hex only.** `byte.toString(16).padStart(2,"0")` never produces uppercase.
- **The empty string is legal.** `answerHash("")` returns `""` by explicit design, so that
  "not started" stays distinguishable from "wrote something". A `^[0-9a-f]{16}$` pattern
  without the `?` group rejects the first `item.answer_changed` of every single exercise —
  the one where `from_hash` is empty because the child had not typed anything yet. That is
  the highest-value event in the pair.

### Invariant the compiler must assert at build time

A format name that is also a legal enum value anywhere in the registry would make rule 1
and rule 2 disagree. The compiler must fail the build — not the ingest — if that ever
becomes true:

> for every `name ∈ FORMATS`: `name` does not appear as an alternative in any
> `string(a|b|...)` expression in the registry

This holds today (`sha256_16` appears nowhere as an alternative). It is cheap to check and
it is the only thing standing between a future format name and a class of silent ingest
failures.

An unrecognised production of any kind is also a **build** failure. The compiler must never
degrade to a permissive `{}` schema for a type hint it did not understand: `{}` validates
everything, so the failure would surface as unvalidated child-typed text reaching an
append-only table, which is the exact outcome `data-schema` §4 forbids.

## Tests the compiler ships with

Decision 3 said "with tests across all 39 events". Coverage counted per event is not enough
— all 39 could pass while every hash field is wrong. These cases are required:

1. all 39 events compile, and every compiled schema is itself a valid JSON Schema document
2. `item.answer_changed.from_hash` **accepts** `""`
3. `item.answer_changed.from_hash` **accepts** a real `answerHash()` output (call the actual
   function, do not hand-write a fixture)
4. `item.answer_changed.from_hash` **rejects** the literal `"sha256_16"`
5. `consent.granted.method` **accepts** `"guardian_web_verified_email"` and **rejects** `"other"`
6. `lesson.scroll_depth` accepts `50` and rejects `"50"`
7. `item.presented.skill_weights` accepts an object of unknown skill codes → numbers
8. `session.heartbeat.lesson_id` accepts `null` and accepts a uuid, rejects `"nope"`
9. the FORMATS-vs-enum invariant above, asserted over the registry as it actually is
10. an unknown type hint fails the build rather than compiling to `{}`

## What this does not change

`registryVersion` stays `1.0.0` and no `event_version` is bumped. This document fixes how
existing type hints are *read*; it does not change any field, any value, or the meaning of
any event, so `data-schema` §7 rule 2 is not triggered. `event-registry.v1.json` remains
the single source of truth — there is no second generated file checked in, and the compiled
schemas exist only in `events.event_registry.payload_schema`.
