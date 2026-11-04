# C4: room booking conflicts

Implement `check-booking`: decide whether a requested booking fits into a room's existing bookings, store the new
booking if it does, and audit it. `intent.feature` (with `glossary.sigil` and `policy.sigil`) says what it must do.
This file fixes the interface, so that an automatic scorer can call your program. The scorer runs hidden cases against
it; the examples in `intent.feature` are only a sample.

The current state is passed in: there is no way to read a booking, only to store one.

## Entry point

Name: `check-booking` (TypeScript: `run`). Parameters, in order:

| Parameter | Type | Meaning |
|---|---|---|
| `existing` | `List Booking` (0 to 60) | the bookings the room already has |
| `id` | `Id` | the id of the requested booking |
| `start` | `Minute` | requested start minute |
| `end` | `Minute` | requested end minute (not included in the booking) |
| `buffer` | `Gap` | minutes that must separate the request from every other booking, on both sides |
| `role` | `Role` | who asks |

Result: `Result Accepted Refusal`.

Every existing booking has `start < end <= 10080`, and the ids of the existing bookings and the requested `id` are all
different. Existing bookings may overlap each other.

## Types

| Type | Definition |
|---|---|
| `Id` | integer 1 to 1 000 000 |
| `Blocker` | integer 0 to 1 000 000 (an `Id`, or 0 for none) |
| `Minute` | integer 0 to 20 000 (minutes from the start of the week; the week ends at minute 10080, so a valid booking has `end <= 10080`) |
| `Gap` | integer 0 to 1440 |
| `Role` | one of `Staff`, `Manager` |
| `Status` | one of `Tentative`, `Confirmed` |
| `Reason` | one of `BadRange`, `Conflict`, `StoreFailed` |
| `Booking` | record `id` (Id), `start` (Minute), `end` (Minute), `status` (Status) |
| `Accepted` | record `id` (Id), `displaced` (List of Id, 0 to 60) |
| `Refusal` | record `reason` (Reason), `blocker` (Blocker) |
| `BookingAccepted` | record `role` (Role), `id` (Id), `displaced` (List of Id, 0 to 60) |

All of these are public data.

## Decision

1. If `end <= start` or `end > 10080`: refused, `Refusal` with reason `BadRange` and blocker 0.
2. An existing booking **conflicts** when `start < booking.end + buffer` and `booking.start < end + buffer` (the
   requested interval, widened by `buffer` on both sides, overlaps the booking; intervals are half open). With `buffer` 0, bookings that
   only touch do not conflict; a booking exactly `buffer` minutes away does not conflict.
3. A conflicting booking **blocks** the request when the role is `Staff`, or when it is `Confirmed`. If any booking blocks the
   request: refused, reason `Conflict`, blocker the lowest `id` among the blocking bookings. Nothing is displaced.
4. Otherwise the request is accepted (a `Manager` request, in which every conflicting booking is `Tentative`, or any request with no
   conflicting booking). The displaced bookings are the conflicting ones (none for `Staff`), reported in the order of `existing`.
5. The new booking is stored (see Effects). If storing fails: refused, reason `StoreFailed`, blocker 0, nothing audited.
6. Then one audit event is emitted and the result is `Accepted` with the new `id` and the displaced ids.

Refusals and failures never store or emit anything. Displaced bookings are only reported; nothing is stored for them.

## Effects

| Handle | Operation | Used for |
|---|---|---|
| `store:bookings` | `put key value` | store the new `Booking` under its id: the requested `start` and `end`, status `Confirmed` for a `Manager` and `Tentative` for `Staff` |
| `audit` | `emit event` | one `BookingAccepted` after the booking is stored |

The scorer compares the stored values and the audit events exactly (field names and values, in call order), so use exactly
the records above and nothing else. There is no other capability: no clock, no randomness, no network.

## Sigil arm

- Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them.
- Bind the handles in a `program` form: `store:bookings` as a `store`, `audit` as an `audit`.

## TypeScript arm

- Put your program in `solution.ts`. It default-exports `run(args, host)`, which may be `async`:

```ts
export default async function run(
  args: { existing: Booking[]; id: number; start: number; end: number; buffer: number; role: 'Staff' | 'Manager' },
  host: Host,
): Promise<Result>
```

- Values are plain JSON (see below). Integers are JS numbers.
- `host`:

```ts
interface Host {
  store: { put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}
```

  Call them as `host.store.put("store:bookings", id, booking)` and `host.audit.emit("audit", event)`.
  `put` returns `{ ok: false }` when the store is unavailable and then stores nothing.

## JSON conventions (what the scorer sends and expects)

- integers: JSON numbers; enum values (`Role`, `Status`, `Reason`): the case name as a string, e.g. `"Manager"`.
- records: objects with the field names above; lists: arrays.
- the result: `{"ok": {"id": 5, "displaced": [4]}}` or `{"err": {"reason": "Conflict", "blocker": 7}}`.
- audit events carry no type tag: a `BookingAccepted` is `{"role": ..., "id": ..., "displaced": [...]}`.
