# B4: import of untrusted records

Implement `import-batch`: take a batch of raw records from an external source, validate each one, store the valid ones
as clean records, reject the rest with a reason, and audit a summary of the batch. `intent.feature` (with
`glossary.sigil` and `policy.sigil`) says what it must do. This file fixes the interface, so that an automatic scorer can
call your program. The scorer runs hidden cases against it; the examples in `intent.feature` are only a sample.

The set of ids already imported is passed in: there is no way to read the store, only to write to it.

## Entry point

Name: `import-batch` (TypeScript: `run`). Parameters, in order:

| Parameter | Type | Meaning |
|---|---|---|
| `records` | `List Raw` (1 to 20 records) | the batch, in the order the source sent it |
| `imported` | `List RawId` (0 to 500 ids) | the ids that were imported by earlier batches |

Result: a `Report` (not a `Result`: a batch always produces a report, even when every record is rejected).

## Types

| Type | Definition |
|---|---|
| `RawId` | integer -9 007 199 254 740 991 to 9 007 199 254 740 991 (a raw id, which may be zero or negative) |
| `Raw` | record `id` (RawId), `quantity` (integer -1 000 000 to 1 000 000), `unitPrice` (integer -1 000 000 000 000 to 1 000 000 000 000, in cents), `category` (integer -1000 to 1000), `note` (Str) |
| `Quantity` | integer 1 to 1000 |
| `Price` | integer 1 to 10 000 000 (cents, so 1 cent to $100000.00) |
| `Category` | integer 0 to 9 |
| `Count` | integer 0 to 20 |
| `Reason` | one of `Accepted`, `BadId`, `BadQuantity`, `BadPrice`, `UnknownCategory`, `AlreadyImported`, `DuplicateInBatch`, `StoreFailed` |
| `Clean` | record `id` (integer 1 to 9 007 199 254 740 991), `quantity` (Quantity), `unitPrice` (Price), `category` (Category), `lineTotal` (integer 1 to 10 000 000 000) |
| `Report` | record `imported`, `badId`, `badQuantity`, `badPrice`, `unknownCategory`, `alreadyImported`, `duplicateInBatch`, `storeFailed`, all `Count` |
| `ImportSummary` | record `received` (Count), `imported` (Count), `rejected` (Count) |

`Raw` is what the external source sent, so every field is untrusted and may be out of range. The `note` is free text
that nobody has checked: it is classified internal (Sigil: `(note Str :internal)`) and must not reach the store, the
audit log or any other effect. Ids, quantities, prices and categories are public.

## Rules the interface fixes

- A record is valid when all of: `id >= 1`, `1 <= quantity <= 1000`, `1 <= unitPrice <= 10 000 000`,
  `0 <= category <= 9`, its id is not in `imported`, and its id appears in no other record of the same batch.
- The reason of a rejected record is the first failing check in this order: `BadId`, `BadQuantity`, `BadPrice`,
  `UnknownCategory`, `AlreadyImported`, `DuplicateInBatch`.
- A duplicate id inside the batch is counted over every record of the batch, whether or not the other copies are valid by
  themselves. All the copies that pass the first four checks and are not in `imported` are rejected as `DuplicateInBatch`;
  a copy that fails an earlier check keeps the earlier reason. No copy is imported.
- A valid record is stored once, in batch order, as a `Clean` record: the same `id`, `quantity`, `unitPrice` and `category`,
  and `lineTotal = quantity * unitPrice` (exact, no rounding). The `Clean` record has no `note`.
- If storing a valid record fails, that record is rejected as `StoreFailed`, nothing is stored for it, and the remaining
  records are still processed. Records are validated independently of one another, so a failed store does not change the
  reason for any other record.
- Exactly one audit event is emitted per call, after all records were processed, even when nothing was imported:
  `ImportSummary` with `received` = number of records, `imported` = number stored, `rejected` = `received - imported`.
  It contains counts only. If the audit log is unavailable the call is not affected.
- The `Report` counts every record exactly once: `imported` is the number stored, and each other field counts the records
  rejected for that reason (`storeFailed` for records whose store failed).

## Effects

| Handle | Operation | Used for |
|---|---|---|
| `store:records` | `put key value` | the `Clean` record of each imported record, under its id, in batch order |
| `audit` | `emit event` | one `ImportSummary` per call |

The scorer compares the stored values and the audit events exactly (field names and values, in call order), so use exactly
the records above and nothing else. There is no other capability: no network, no clock, no randomness.

## Sigil arm

- Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them.
- Bind the handles in a `program` form: `store:records` as a `store`, `audit` as an `audit`.

## TypeScript arm

- Put your program in `solution.ts`. It default-exports `run(args, host)`, which may be `async`:

```ts
export default async function run(
  args: { records: Raw[]; imported: number[] },
  host: Host,
): Promise<Report>
```

- Values are plain JSON (see below). Integers are JS numbers; every value here stays below 2^53 in magnitude.
- `host`:

```ts
interface Host {
  store: { put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}
```

  Call them as `host.store.put("store:records", clean.id, clean)` and `host.audit.emit("audit", summary)`.
  `put` returns `{ ok: false }` when the store is unavailable and then stores nothing.

## JSON conventions (what the scorer sends and expects)

- integers: JSON numbers; strings: strings; enum values (`Reason`): the case name as a string.
- records: objects with the field names above; lists: arrays.
- the result is the `Report` object itself, for example
  `{"imported":1,"badId":0,"badQuantity":1,"badPrice":0,"unknownCategory":0,"alreadyImported":0,"duplicateInBatch":0,"storeFailed":0}`.
- audit events carry no type tag: an `ImportSummary` is `{"received":..., "imported":..., "rejected":...}`.
- stored values are the `Clean` objects: `{"id":..., "quantity":..., "unitPrice":..., "category":..., "lineTotal":...}`.
