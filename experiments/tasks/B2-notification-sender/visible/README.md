# B2: notification sender with a retry policy

Implement `send-notice`: send one notice to a recipient through a delivery service, retrying as the attempt policy allows,
and audit the outcome. `intent.feature` (with `glossary.sigil` and `policy.sigil`) says what it must do. This file fixes
the interface, so that an automatic scorer can call your program. The scorer runs hidden cases against it; the examples in
`intent.feature` are only a sample.

The recipient and the policy are passed in: there is nothing to read.

## Entry point

Name: `send-notice`. Parameters, in order:

| Parameter | Type | Meaning |
|---|---|---|
| `recipient` | `Recipient` | who the notice is for |
| `kind` | `Kind` | what kind of notice it is |
| `policy` | `AttemptPolicy` | how many attempts are allowed and whether to fall back to the other channel |

Result: `Report` (not a `Result`: a failed delivery is a normal outcome, not an error).

## Types

| Type | Definition |
|---|---|
| `Id` | integer 0 to 9 007 199 254 740 991 |
| `Channel` | one of `Email`, `Sms` |
| `Kind` | one of `Receipt`, `Reminder`, `Alert` |
| `Outcome` | one of `Delivered`, `Failed`, `Skipped` |
| `Recipient` | record `id` (Id), `name` (string), `email` (string), `phone` (string), `channel` (Channel, the preferred channel), `optedOut` (Bool) |
| `AttemptPolicy` | record `maxAttempts` (integer 1 to 10), `fallback` (Bool) |
| `Notice` | record `to` (string), `kind` (Kind), `channel` (Channel), `attempt` (integer 1 to 3), `text` (string): what is posted |
| `Report` | record `outcome` (Outcome), `attempts` (integer 0 to 3): what `send-notice` returns |
| `NoticeAudit` | record `recipient` (Id), `kind` (Kind), `outcome` (Outcome), `attempts` (integer 0 to 3): the audit event |

In a `Notice`, `to` is the recipient's `email` when the channel is `Email` and the recipient's `phone` when it is `Sms`;
`channel` is the channel this attempt is made on; `attempt` is the attempt's number (1, 2 or 3); `text` is `Hello `,
the recipient's name, `, ` and the line for the kind: `your receipt is ready` (Receipt), `this is a reminder` (Reminder),
`this is an alert` (Alert). For example `Hello Ada, your receipt is ready`.

A skipped notice makes no attempt, so its `Report` and its audit event say `Skipped` with 0 attempts.

Data classification: `Recipient.name`, `Recipient.email` and `Recipient.phone` are personal data (pii). Everything else (ids, the
channel, the opt-out flag, kinds, outcomes, attempt counts, the policy) is public. The audit event must contain public data
only: no name, no email, no phone number, and nothing derived from them.

## Effects

| Handle | Operation | Used for |
|---|---|---|
| `net:email` | `post payload` | one `Notice` per attempt made on the `Email` channel |
| `net:sms` | `post payload` | one `Notice` per attempt made on the `Sms` channel |
| `audit` | `emit event` | exactly one `NoticeAudit` per call, after the last attempt (or after the decision to skip) |

`post` reports failure when that delivery service is unavailable; a failed post has no effect and still counts as an attempt.
The scorer compares the posted payloads and the audit events exactly (field names and values, in call order), so use exactly
the records above and nothing else. There is no other capability: no store, no clock, no randomness.

## Sigil arm

- Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them.
- `glossary.sigil` also needs the function `notice-line (in (k Kind)) (out Str)` and the entry `send-notice`.
- Bind the handles in a `program` form: `net:email` as a `net` connecting to `https://mail.example.com`, `net:sms` as a `net`
  connecting to `https://sms.example.com`, and `audit` as an `audit`.

## TypeScript arm

- Put your program in `solution.ts`. It default-exports `run(args, host)`, which may be `async`:

```ts
export default async function run(
  args: { recipient: Recipient; kind: Kind; policy: AttemptPolicy },
  host: Host,
): Promise<Report>
```

- Values are plain JSON (see below). Integers are JS numbers.
- `host`:

```ts
interface Host {
  net: { post(handle: string, payload: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}
```

  Call them as `host.net.post("net:email", notice)`, `host.net.post("net:sms", notice)` and `host.audit.emit("audit", event)`.
  `post` returns `{ ok: false }` when that service is unavailable and then sends nothing.

## JSON conventions (what the scorer sends and expects)

- integers: JSON numbers; booleans: booleans; strings: strings; enum values (`Channel`, `Kind`, `Outcome`): the case name as a string, e.g. `"Sms"`.
- records: objects with the field names above.
- the result: a `Report` object, e.g. `{"outcome": "Delivered", "attempts": 2}`.
- a posted `Notice` is `{"to": ..., "kind": ..., "channel": ..., "attempt": ..., "text": ...}`; an audit event is
  `{"recipient": ..., "kind": ..., "outcome": ..., "attempts": ...}`. Neither carries a type tag.
