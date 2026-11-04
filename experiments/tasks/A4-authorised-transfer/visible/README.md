# A4: authorised transfer

Implement `transfer`: move money between two accounts if the actor is allowed to, store the two new account records,
and audit the outcome. `intent.feature` (with `glossary.sigil` and `policy.sigil`) says what it must do. This file fixes
the interface, so that an automatic scorer can call your program. The scorer runs hidden cases against it; the examples in
`intent.feature` are only a sample.

The current state is passed in: there is no way to read an account, only to store one.

## Entry point

Name: `transfer`. Parameters, in order:

| Parameter | Type | Meaning |
|---|---|---|
| `actor` | `Actor` | who asks for the transfer |
| `src` | `Account` | the account the money leaves, as it is now |
| `dst` | `Account` | the account the money goes to, as it is now |
| `amount` | `Cents` | how much to move, in cents (may be 0, which is refused) |
| `approved` | `Bool` | the approval flag supplied by the caller |

Result: `Result Receipt TransferError`.

## Types

| Type | Definition |
|---|---|
| `Cents` | integer 0 to 1 000 000 000 000 (money is whole cents everywhere) |
| `Wide` | integer 0 to 2 000 000 000 000 (a balance after a transfer, which can exceed `Cents`) |
| `Id` | integer 0 to 9 007 199 254 740 991 (actor and account ids and owners) |
| `Role` | one of `Customer`, `Teller`, `Admin` |
| `Actor` | record `id` (Id), `role` (Role) |
| `Account` | record `id` (Id), `owner` (Id), `balance` (Cents) |
| `Ledger` | record `id` (Id), `owner` (Id), `balance` (Wide): an account after the transfer |
| `Receipt` | record `src` (Id), `dst` (Id), `amount` (Cents), `srcBalance` (Wide), `dstBalance` (Wide) |
| `Transferred` | record `actor` (Id), `src` (Id), `dst` (Id), `amount` (Cents) |
| `TransferRefused` | record `actor` (Id), `src` (Id), `dst` (Id), `amount` (Cents), `reason` (TransferError) |
| `TransferError` | one of `NotAllowed`, `SameAccount`, `BadAmount`, `NeedsApproval`, `Insufficient`, `StoreFailed` |

Here `src` and `dst` are the account ids; `actor` in an audit record is the actor's id. A customer owns an account when the
account's `owner` equals the customer's `id`. The two accounts are different accounts when their `id`s differ. `Receipt` holds the
new balances of the two accounts.

`StoreFailed` is returned when storing an account record fails (it is not a refusal, so nothing is audited for it).

Data classification: `Account.balance`, `Ledger.balance` and the balances in `Receipt` are internal. Ids, roles, amounts and
reasons are public.

## Effects

| Handle | Operation | Used for |
|---|---|---|
| `store:accounts` | `put key value` | store the new `Ledger` of an account under its account id: source first, then destination |
| `audit` | `emit event` | `Transferred` after both records are stored; `TransferRefused` when the transfer is refused |

The scorer compares the stored values and the audit events exactly (field names and values, in call order), so use exactly
the records above and nothing else. There is no other capability: no clock, no randomness, no network.

## Sigil arm

- Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them.
- Bind the handles in a `program` form: `store:accounts` as a `store`, `audit` as an `audit`.

## TypeScript arm

- Put your program in `solution.ts`. It default-exports `run(args, host)`, which may be `async`:

```ts
export default async function run(
  args: { actor: Actor; src: Account; dst: Account; amount: number; approved: boolean },
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

  Call them as `host.store.put("store:accounts", account.id, ledger)` and `host.audit.emit("audit", event)`.
  `put` returns `{ ok: false }` when the store is unavailable and then stores nothing.

## JSON conventions (what the scorer sends and expects)

- integers: JSON numbers; booleans: booleans; enum values (`Role`, `TransferError`): the case name as a string, e.g. `"Teller"`.
- records: objects with the field names above.
- the result: `{"ok": <Receipt>}` or `{"err": "NotAllowed"}` and so on.
- audit events carry no type tag: a `Transferred` is `{"actor":..., "src":..., "dst":..., "amount":...}` and a `TransferRefused`
  has the same four fields plus `"reason": "<TransferError case>"`.
