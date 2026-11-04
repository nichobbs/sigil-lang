# A1: tiered pricing

Implement `quote-order`: price an order for a customer, store the quote, and audit the outcome.
`intent.feature` (with `glossary.sigil` and `policy.sigil`) says what it must do. This file fixes the interface, so
that an automatic scorer can call your program. The scorer runs hidden cases against it; the examples in
`intent.feature` are only a sample.

## Entry point

Name: `quote-order`. Parameters, in order:

| Parameter | Type | Meaning |
|---|---|---|
| `id` | `QuoteId` | the id the caller wants the quote to have |
| `cust` | `Customer` | the customer |
| `lines` | `(List Line 1 50)` | 1 to 50 order lines |

Result: `Result Quote QuoteError`.

## Types

| Type | Definition |
|---|---|
| `Cents` | integer 0 to 1 000 000 000 000 (money is whole cents everywhere) |
| `Pct` | integer 0 to 100 |
| `Tier` | one of `Standard`, `Silver`, `Gold` |
| `CustId`, `QuoteId` | integer 0 to 9 007 199 254 740 991 |
| `Line` | record `sku` (string), `unit` (integer 0 to 10 000 000, cents per unit), `qty` (integer 1 to 1000) |
| `Customer` | record `id` (CustId), `name` (string), `email` (string), `tier` (Tier), `credit` (Cents) |
| `Quote` | record `id` (QuoteId), `cust` (CustId), `gross` (Cents), `total` (Cents), `creditUsed` (Cents), `due` (Cents) |
| `QuoteIssued` | record `id` (QuoteId), `cust` (CustId), `due` (Cents) |
| `QuoteRefused` | record `id` (QuoteId), `cust` (CustId) |
| `QuoteError` | one of `NeedsApproval`, `StoreFailed` |

`gross` is the undiscounted total of the order, `total` the quote total after the discounts and the floor, `creditUsed`
the account credit applied, `due` what the customer still owes.

Data classification: `Customer.name` and `Customer.email` are personal data (pii). `Customer.tier` and
`Customer.credit` are internal. Anything computed from internal data is internal. Ids and order lines are public.

## Effects

| Handle | Operation | Used for |
|---|---|---|
| `store:quotes` | `put key value` | store the `Quote` under its id, exactly once per issued quote |
| `audit` | `emit event` | `QuoteIssued` after the quote is stored; `QuoteRefused` when the order is refused |

The scorer compares the stored values and the audit events exactly (field names and values, in call order), so
use exactly the records above and nothing else. There is no other capability: no clock, no randomness, no network.

## Sigil arm

- Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them.
- `glossary.sigil` also needs two small functions: `volume-pct (in (qty (Int 1 1000))) (out Pct)` and
  `tier-pct (in (t Tier)) (out Pct)`, and the entry `quote-order`.
- Bind the handles in a `program` form: `store:quotes` as a `store`, `audit` as an `audit`.

## TypeScript arm

- Put your program in `solution.ts`. It default-exports `run(args, host)`, which may be `async`:

```ts
export default async function run(
  args: { id: number; cust: Customer; lines: Line[] },
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

  Call them as `host.store.put("store:quotes", quote.id, quote)` and `host.audit.emit("audit", event)`.
  `put` returns `{ ok: false }` when the store is unavailable and then stores nothing.

## JSON conventions (what the scorer sends and expects)

- integers: JSON numbers; strings: strings; enum values (`Tier`, `QuoteError`): the case name as a string, e.g. `"Gold"`.
- records: objects with the field names above; lists: arrays.
- the result: `{"ok": <Quote>}` or `{"err": "NeedsApproval"}` / `{"err": "StoreFailed"}`.
- audit events carry no type tag: a `QuoteIssued` is `{"id":..., "cust":..., "due":...}` and a `QuoteRefused` is `{"id":..., "cust":...}`.
