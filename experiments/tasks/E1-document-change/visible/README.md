# E1: document service, change request DOC-142

## Change request DOC-142 (approved by the product owner)

The program in your workspace (`task/app.sigil` or `solution.ts`) implements the previous version of this service. Change it to
meet the updated `intent.feature` (the human-owned intent was updated for this ticket; `glossary.sigil` and `policy.sigil` are
unchanged). In short:

1. An Editor may now publish a document they own (an Editor still may not publish a document they do not own).
2. An Editor may now delete their own document only while it is not Published: an Editor who deletes their own Published
   document is refused as NotAllowed. Admins are unaffected.

Everything else is unchanged, including the order in which refusals are reported, the privacy rules, the audit and the
store behaviour. Keep the entry point, the types and the effects exactly as below.

Implement `handle-request`: decide whether an actor may update, delete or publish a document, store the new document
record, and audit the outcome. `intent.feature` (with `glossary.sigil` and `policy.sigil`) says what it must do. This file
fixes the interface, so that an automatic scorer can call your program. The scorer runs hidden cases against it; the examples
in `intent.feature` are only a sample.

The current state is passed in: there is no way to read a document, only to store one.

## Entry point

Name: `handle-request` in Sigil, `run` in TypeScript (see below). Parameters, in order:

| Parameter | Type | Meaning |
|---|---|---|
| `actor` | `Actor` | who sends the request |
| `doc` | `Doc` | the document as it is now |
| `req` | `Request` | the operation and its payload |

Result: `Result Receipt DocError`: `{"ok": <Receipt of the new document>}` when the request is carried out, `{"err": <DocError>}` otherwise.

## Types

| Type | Definition |
|---|---|
| `Id` | integer 0 to 9 007 199 254 740 991 (actor, document and owner ids) |
| `Size` | integer 0 to 1 000 000 (the length of a document body, in characters) |
| `Role` | one of `Viewer`, `Editor`, `Admin` |
| `Status` | one of `Draft`, `Published`, `Deleted` |
| `Op` | one of `Update`, `Delete`, `Publish` |
| `Actor` | record `id` (Id), `role` (Role) |
| `Doc` | record `id` (Id), `owner` (Id), `title` (text), `size` (Size), `status` (Status) |
| `Request` | record `op` (Op), `title` (text), `size` (Size) |
| `Receipt` | record `doc` (Id), `status` (Status), `size` (Size): the id, status and size of the document as stored |
| `Applied` | record `actor` (Id), `doc` (Id), `op` (Op) |
| `Refused` | record `actor` (Id), `doc` (Id), `op` (Op), `reason` (DocError) |
| `DocError` | one of `NotAllowed`, `Gone`, `TooLong`, `AlreadyPublished`, `EmptyBody`, `StoreFailed` |

`actor` and `doc` in an audit record are the actor's id and the document's id. A document is owned by an actor when
the document's `owner` equals the actor's `id`. `Request.title` and `Request.size` are the payload of an `Update`; for a
`Delete` or a `Publish` they carry arbitrary values that must be ignored. The text of a title is arbitrary and is never
inspected, only copied.

`StoreFailed` is returned when storing the document record fails (it is not a refusal, so nothing is audited for it).

Data classification: the title of a document and the title in a request are personal data. They may be stored but must
never appear in an audit event. Ids, roles, statuses, sizes, operations and reasons are public.

## Effects

| Handle | Operation | Used for |
|---|---|---|
| `store:docs` | `put key value` | store the new `Doc` under the document's id |
| `audit` | `emit event` | `Applied` after the document is stored; `Refused` when the request is refused |

The scorer compares the stored values and the audit events exactly (field names and values, in call order), so use exactly
the records above and nothing else. There is no other capability: no clock, no randomness, no network.

## Sigil arm

- Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them.
  The `title` fields are text: declare them as `Str` with the flag your policy requires.
- Bind the handles in a `program` form: `store:docs` as a `store`, `audit` as an `audit`.

## TypeScript arm

- Put your program in `solution.ts`. It default-exports `run(args, host)`, which may be `async`:

```ts
export default async function run(
  args: { actor: Actor; doc: Doc; req: Request },
  host: Host,
): Promise<Result>
```

- Values are plain JSON (see below). Integers are JS numbers; every id and size here stays below 2^53.
- `host`:

```ts
interface Host {
  store: { put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}
```

  Call them as `host.store.put("store:docs", doc.id, newDoc)` and `host.audit.emit("audit", event)`.
  `put` returns `{ ok: false }` when the store is unavailable and then stores nothing.

## JSON conventions (what the scorer sends and expects)

- integers: JSON numbers; strings: strings; enum values (`Role`, `Status`, `Op`, `DocError`): the case name as a string, e.g. `"Editor"`.
- records: objects with the field names above, e.g. `{"id": 101, "owner": 5, "title": "Q3 plan", "size": 800, "status": "Draft"}`.
- the result: `{"ok": <Doc>}` or `{"err": "NotAllowed"}` and so on.
- audit events carry no type tag: an `Applied` is `{"actor":..., "doc":..., "op":...}` and a `Refused` has the same three
  fields plus `"reason": "<DocError case>"`.
