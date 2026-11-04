# E2: audited refund, change request PAY-310

## Change request PAY-310 (approved by the product owner)

The program in your workspace (`task/app.sigil` or `solution.ts`) implements the previous version of this service. Change it to
meet the updated `intent.feature` (the human-owned intent and `glossary.sigil` were updated for this ticket; `policy.sigil` is
unchanged). In short:

1. The per-refund cap now also depends on the reason: a `Goodwill` refund has half the cap of the other reasons (Support 10000,
   Manager 50000, Admin 500000; the other reasons keep 20000, 100000, 1000000). In Sigil, `refund-cap` now takes a `Role` and a
   `ReasonCode` (in that order) and returns `Cents`.
2. A `Support` actor may refund a `Disputed` payment when the reason is `Fraud` (it is then treated like a `Settled` payment).
   For any other reason a Support actor on a Disputed payment is still refused as `NeedsManager`.
3. The order of refusals changes: `OverCap` is now reported before `ExceedsRemaining`.

Everything else is unchanged, including the privacy rule, the audit and the store behaviour. Keep the entry point, the types and
the effects exactly as below.

Implement `refund`: refund part or all of a payment if the actor is allowed to, store the updated payment record, and
audit the outcome. `intent.feature` (with `glossary.sigil` and `policy.sigil`) says what it must do. This file fixes the
interface, so that an automatic scorer can call your program. The scorer runs hidden cases against it; the examples in
`intent.feature` are only a sample.

The current state is passed in: there is no way to read a payment, only to store one. The caller guarantees that
`payment.refunded` is never more than `payment.amount`.

## Entry point

Name: `refund`. Parameters, in order:

| Parameter | Type | Meaning |
|---|---|---|
| `actor` | `Actor` | who asks for the refund |
| `payment` | `Payment` | the payment as it is now |
| `amount` | `Cents` | how much to refund now, in cents (may be 0, which is refused) |
| `reason` | `ReasonCode` | why the refund is made |

Result: `Result Receipt RefundError`.

## Types

| Type | Definition |
|---|---|
| `Cents` | integer 0 to 1 000 000 000 000 (money is whole cents everywhere) |
| `Id` | integer 0 to 9 007 199 254 740 991 (actor and payment ids) |
| `Role` | one of `Support`, `Manager`, `Admin` |
| `PayStatus` | one of `Settled`, `Disputed`, `Voided` |
| `ReasonCode` | one of `Duplicate`, `Defective`, `Goodwill`, `Fraud` |
| `RefundError` | one of `NotRefundable`, `NeedsManager`, `BadAmount`, `ExceedsRemaining`, `OverCap`, `StoreFailed` |
| `Actor` | record `id` (Id), `role` (Role) |
| `Payment` | record `id` (Id), `amount` (Cents), `refunded` (Cents), `status` (PayStatus), `card` (Str) |
| `Receipt` | record `payment` (Id), `refund` (Cents), `refunded` (Cents), `remaining` (Cents) |
| `RefundIssued` | record `actor` (Id), `payment` (Id), `amount` (Cents), `reason` (ReasonCode) |
| `RefundRefused` | record `actor` (Id), `payment` (Id), `amount` (Cents), `reason` (ReasonCode), `why` (RefundError) |

`Payment.amount` is what was paid; `Payment.refunded` is everything refunded on it so far; `Payment.card` is the last four
digits of the card, as text (it may start with 0). What is left to refund is `amount - refunded`. `Receipt` describes the
refund just made: `refund` is the amount refunded now, `refunded` is the total refunded on the payment afterwards and
`remaining` is what is left to refund afterwards. In the audit events `actor` is the actor's id and `payment` is the
payment's id; `amount` and `reason` are the refund's amount and reason; in `RefundRefused`, `why` is the `RefundError` that
caused it (including `StoreFailed`).

Caps per refund (inclusive; amounts in cents): `Support` 20000, `Manager` 100000, `Admin` 1000000; for the reason `Goodwill` half of these (10000, 50000, 500000).

The updated payment that is stored is the payment passed in with `refunded` increased by the refund; `id`, `amount`,
`status` and `card` are unchanged (a fully refunded payment keeps its status).

Data classification: `Payment.card` is personal data (pii). Ids, roles, statuses, amounts, reasons and errors are public.

## Effects

| Handle | Operation | Used for |
|---|---|---|
| `store:payments` | `put key value` | store the updated `Payment` under its payment id, once, only when the refund is allowed |
| `audit` | `emit event` | `RefundIssued` after the payment is stored; `RefundRefused` when the refund is refused, and also when storing fails |

Exactly one audit event is emitted per call. The scorer compares the stored values and the audit events exactly (field names
and values, in call order), so use exactly the records above and nothing else. There is no other capability: no clock,
no randomness, no network.

## Sigil arm

- Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them.
  The glossary also uses the function `refund-cap` (parameters `Role` then `ReasonCode`, result `Cents`).
- Bind the handles in a `program` form: `store:payments` as a `store`, `audit` as an `audit`.

## TypeScript arm

- Put your program in `solution.ts`. It default-exports `run(args, host)`, which may be `async`:

```ts
export default async function run(
  args: { actor: Actor; payment: Payment; amount: number; reason: ReasonCode },
  host: Host,
): Promise<Result>
```

- Values are plain JSON (see below). Integers are JS numbers; every id and amount here stays below 2^53.
- `host`:

```ts
interface Host {
  store: { put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}
```

  Call them as `host.store.put("store:payments", payment.id, updated)` and `host.audit.emit("audit", event)`.
  `put` returns `{ ok: false }` when the store is unavailable and then stores nothing.

## JSON conventions (what the scorer sends and expects)

- integers: JSON numbers; strings: strings; enum values (`Role`, `PayStatus`, `ReasonCode`, `RefundError`): the case name as a string, e.g. `"Manager"`.
- records: objects with the field names above.
- the result: `{"ok": <Receipt>}` or `{"err": "OverCap"}` and so on.
- audit events carry no type tag: a `RefundIssued` is `{"actor":..., "payment":..., "amount":..., "reason":...}` and a `RefundRefused`
  has the same four fields plus `"why": "<RefundError case>"`.
