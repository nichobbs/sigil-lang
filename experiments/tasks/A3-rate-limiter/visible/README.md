# A3: rate limiter

Implement `admit`: decide whether one API request fits in its caller's rate-limit window, update the window, and audit the
outcome. `intent.feature` (with `glossary.sigil` and `policy.sigil`) says what it must do. This file fixes the interface,
so that an automatic scorer can call your program. The scorer runs hidden cases against it; the examples in
`intent.feature` are only a sample.

The program is a pure decision over state passed in as parameters: it does not read the window from anywhere. It only
writes the new window state when a request is allowed.

## Entry point

Name: `admit`. Parameters, in order:

| Parameter | Type | Meaning |
|---|---|---|
| `req` | `Request` | the request being decided |
| `state` | `State` | the caller's current window, as last stored |

Result: `Result Decision Rejection`.

The caller guarantees that `req.now` is never earlier than `state.start`; you need not handle a request from before the window.

## Types

| Type | Definition |
|---|---|
| `Tokens` | integer 0 to 1 000 000 000 |
| `Cost` | integer 1 to 1 000 000 (the tokens a request costs) |
| `Millis` | integer 0 to 1 000 000 000 000 000 (a time in whole milliseconds) |
| `Seconds` | integer 0 to 1 000 000 000 000 000 (a duration in whole seconds) |
| `ApiKey` | integer 0 to 9 007 199 254 740 991 |
| `Plan` | one of `Free`, `Pro`, `Enterprise` |
| `Reason` | one of `TooLarge`, `Denied` |
| `Request` | record `key` (ApiKey), `plan` (Plan), `cost` (Cost), `now` (Millis) |
| `State` | record `start` (Millis, when the current window started), `used` (Tokens used in it), `burst` (Bool, true when the burst has been borrowed in it) |
| `Decision` | record `remaining` (Tokens), `burst` (Bool, true when this request borrowed the burst) |
| `Rejection` | record `reason` (Reason), `retryAfter` (Seconds) |
| `Admitted` | record `plan` (Plan), `cost` (Cost), `remaining` (Tokens), `burst` (Bool) |
| `Refused` | record `plan` (Plan), `cost` (Cost), `reason` (Reason), `retryAfter` (Seconds) |

Time is in whole milliseconds, because the retry-after is in whole seconds and has to be rounded.

Data classification: `Request.key` is personal data (pii). Everything else is public. The key identifies the caller, so it must
not appear in anything stored or emitted, however it is transformed.

## Effects

| Handle | Operation | Used for |
|---|---|---|
| `store:limits` | `put key value` | store the new `State` of the window, under key `0`, exactly once per allowed request |
| `audit` | `emit event` | `Admitted` for an allowed request; `Refused` for a denied or too-large request |

The new `State` is the window the request was decided in (`start` is the start of the current window, which is the request's own
time when it opened a new one), with `used` including the request's cost, and `burst` true when the burst has been borrowed
in that window (by this request or an earlier one). A denied or too-large request stores nothing. An allowed request stores
before it emits. `Refused.retryAfter` is the same number as `Rejection.retryAfter`.

The scorer compares the stored values and the audit events exactly (field names and values, in call order), so use exactly
the records above and nothing else. There is no other capability: no clock, no randomness, no network.

## Sigil arm

- Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them.
- `glossary.sigil` also needs one small function, `allowance (in (p Plan)) (out Tokens)`, and the entry `admit`.
- Bind the handles in a `program` form: `store:limits` as a `store`, `audit` as an `audit`.

## TypeScript arm

- Put your program in `solution.ts`. It default-exports `run(args, host)`, which may be `async`:

```ts
export default async function run(
  args: { req: Request; state: State },
  host: Host,
): Promise<Result>
```

- Values are plain JSON (see below). Integers are JS numbers; every value here stays below 2^53.
- `host`:

```ts
interface Host {
  store: { put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}
```

  Call them as `host.store.put("store:limits", 0, state)` and `host.audit.emit("audit", event)`.

## JSON conventions (what the scorer sends and expects)

- integers: JSON numbers; booleans: `true` / `false`; enum values (`Plan`, `Reason`): the case name as a string, e.g. `"Pro"`.
- records: objects with the field names above.
- the result: `{"ok": <Decision>}` or `{"err": <Rejection>}`, for example `{"ok": {"remaining": 10, "burst": false}}` or
  `{"err": {"reason": "Denied", "retryAfter": 50}}`.
- audit events carry no type tag: an `Admitted` has the fields `plan`, `cost`, `remaining`, `burst`; a `Refused` has `plan`, `cost`,
  `reason`, `retryAfter`.
