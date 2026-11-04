# A2: ledger postings

Implement `apply-posting`: apply one posting to an account, store the updated account, and audit the outcome.
`intent.feature` (with `glossary.sigil` and `policy.sigil`) says what it must do. This file fixes the interface, so
that an automatic scorer can call your program. The scorer runs hidden cases against it; the examples in
`intent.feature` are only a sample.

The current state of the account is passed in as a parameter. Your program does not read the store, and it keeps no
state between calls.

## Entry point

Name: `apply-posting`. Parameters, in order:

| Parameter | Type | Meaning |
|---|---|---|
| `acct` | `Account` | the account as it is before the posting |
| `posting` | `Posting` | the posting to apply |

Result: `Result Receipt PostingError`.

## Types

| Type | Definition |
|---|---|
| `Cents` | integer 0 to 1 000 000 000 000 (money is whole cents everywhere) |
| `Balance` | integer -50 000 to 1 000 000 000 000 (cents; negative when a Checking account is overdrawn) |
| `Amount` | integer 1 to 100 000 000 (cents; the size of a posting) |
| `AcctId` | integer 0 to 9 007 199 254 740 991 |
| `AcctKind` | one of `Checking`, `Savings` |
| `AcctStatus` | one of `Open`, `Frozen` |
| `PostingKind` | one of `Credit`, `Debit`, `Fee` |
| `PostingError` | one of `AcctFrozen`, `Insufficient`, `OverLimit`, `StoreFailed` |
| `Account` | record `id` (AcctId), `kind` (AcctKind), `status` (AcctStatus), `balance` (Balance), `spent` (Cents, the amount of Debits applied today) |
| `Posting` | record `kind` (PostingKind), `amount` (Amount) |
| `Receipt` | record `acct` (AcctId), `balance` (Balance, the balance after the posting) |
| `PostingApplied` | record `acct` (AcctId), `kind` (PostingKind), `amount` (Amount), `balance` (Balance, after the posting) |
| `PostingRejected` | record `acct` (AcctId), `reason` (PostingError) |

The updated account is the input account with `balance` and `spent` replaced; `id`, `kind` and `status` do not change.
Balances stay within the `Balance` range in every case the scorer sends, so a Credit never has to be clamped.

Data classification: `Account.balance` and `Account.spent` are internal. Ids, kinds, statuses, posting kinds and amounts are public.

## Effects

| Handle | Operation | Used for |
|---|---|---|
| `store:ledger` | `put key value` | store the updated `Account` under its id, once per applied posting |
| `audit` | `emit event` | `PostingApplied` after the account is stored; `PostingRejected` when the posting is refused |

The scorer compares the stored values and the audit events exactly (field names and values, in call order), so
use exactly the records above and nothing else. There is no other capability: no clock, no randomness, no network.

Case names are global in Sigil, so the `PostingError` case for a frozen account is `AcctFrozen` and the `AcctStatus` case is `Frozen`.

## Sigil arm

- Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them.
- `glossary.sigil` also needs `overdraft-limit (in (k AcctKind)) (out (Int 0 50000))` (the overdraft allowance in cents) and the entry `apply-posting`.
- Bind the handles in a `program` form: `store:ledger` as a `store`, `audit` as an `audit`.

## TypeScript arm

- Put your program in `solution.ts`. It default-exports `run(args, host)`, which may be `async`:

```ts
export default async function run(
  args: { acct: Account; posting: Posting },
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

  Call them as `host.store.put("store:ledger", account.id, account)` and `host.audit.emit("audit", event)`.
  `put` returns `{ ok: false }` when the store is unavailable and then stores nothing.

## JSON conventions (what the scorer sends and expects)

- integers: JSON numbers; enum values (`AcctKind`, `AcctStatus`, `PostingKind`, `PostingError`): the case name as a string, e.g. `"Checking"`.
- records: objects with the field names above.
- the result: `{"ok": <Receipt>}` or `{"err": "Insufficient"}` (any `PostingError` case name).
- audit events carry no type tag: a `PostingApplied` is `{"acct":..., "kind":..., "amount":..., "balance":...}` and a `PostingRejected` is `{"acct":..., "reason":...}`.
