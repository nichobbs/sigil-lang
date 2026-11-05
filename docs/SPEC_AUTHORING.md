# Spec authoring: how the intent layer gets written without humans writing Sigil

Status: design plus a working prototype (`sigil spec ...`). Not yet used by the experiments.

## Problem

The intent layer is "human owned", but `glossary.sigil` is Sigil. Nobody expects humans to write it, and in the experiments so far we wrote it by hand. The glossary is also the part of the spec with the most power:

| Glossary entry | What it decides | Example from D4 |
|---|---|---|
| `given` / `when` | fixtures and which function is called | `(set payment (Payment id amount refunded status card))` |
| `then` | what is observed and compared | audit events must equal `(RefundIssued actor.id payment.id amount reason)`, exactly four fields |
| `rule` | decision table bound to a function | `refund-cap` |
| `always` | English paragraph turned into a `forall` property | "Only a Settled payment can be refunded" |
| `privacy` | protected source, allowed sinks, accepted declassifiers | `(declassified card-band)` exempts a flow from the two-run check |

A weak or wrong glossary silently weakens every check downstream. If agents write it and humans rubber-stamp a diff of S-expressions, the "humans own intent" claim is false in practice.

## Principles

1. Humans write English (the `.feature` file) and make decisions. They never need to read S-expressions to decide.
2. An agent translates English into the glossary, but it is not the implementation agent, and it cannot approve its own work.
3. What a human reviews is the **effect** of a change on the spec ("audit events may now carry a card-derived field"), derived mechanically, with the source form attached for those who want it.
4. `glossary.sigil` changes only through `promote`, which needs sign-off from named people. Any other edit is detectable in CI.
5. Risky kinds of change need the right reviewer, not just the owner.

## Roles

- **Spec owner** (one person): accountable for the spec. Signs every promotion.
- **Reviewers** (zero or more per role, for example `privacy`, `qa`): required only when a change carries a tag that the owner has mapped to their role.
- **Spec-author agent**: reads the feature file and the policy, writes `proposed-glossary.sigil`. May not touch `glossary.sigil`, `policy.sigil`, `spec.owners`, `spec.approvals` or `spec.history`.
- **Implementation agent**: unchanged from AGENT_WORKFLOW.md. Edits `app.sigil` only, and cannot see or write proposals.

The owner is also a reviewer of last resort: they can sign any role only if they are listed under it in `spec.owners`. The tool does not let the owner sign as `privacy` just because they own the spec.

## Flow

```
owner edits  *.feature (English)                       human
spec-author agent -> proposed-glossary.sigil           agent
sigil spec review DIR                                  tool: effects, coverage, who must sign
sigil spec approve DIR --as NAME --role ROLE           humans, once each
sigil spec promote DIR                                 tool: gate, then replace glossary.sigil
sigil spec check DIR                                   CI: glossary.sigil must equal the last promotion
```

`proposed-policy.sigil` is the existing precedent: an agent proposes, a human owns the decision, the tool refuses to treat the proposal as final. This extends the same idea to the glossary and gives it a sign-off gate.

## What the review shows

For each added, changed or removed entry:

- **Tags**: `fixture`, `fault-injection`, `sink-observation`, `property`, `decision-table`, `privacy`, `privacy-allow`, `declassified`, `removal`.
- **Effects**, derived from the S-expression structure and diffed before and after. Examples: `observes emitted audit`, `builds RefundIssued(actor.id payment.id amount reason (digit-sum payment.card))`, `exempts declassifier(s) card-band from the privacy check`, `injects failure store:payments put`. A constructor counts only inside `expect`, where it is compared with something observed, not in fixtures or generated inputs.
- **Before and after source** for anyone who wants to read it.
- **Coverage** against the feature file: steps no phrase binds, phrases nothing uses, property paragraphs missing from the feature. This is an approximation (placeholders match anything); `verify` is the exact check.
- **Mutation regression** (opt-in, `sigil spec review DIR --mutation`, needs `app.sigil`, `policy.sigil` and a `.feature` in DIR): mutants of the app that the current glossary kills and the proposal does not. It sees weakenings that let a wrong implementation through. It does not see weakenings no mutant exercises (extra emits, tautologies, narrower domains). Slow: two full mutation runs.
- **Sign-off state**: who is required and why, who has signed, approvals that were ignored and the reason.

## Sign-off rules (`spec.owners`)

```
(owners
  (owner nic)
  (reviewers (privacy alice bob) (qa carol))
  (require (privacy privacy) (declassified privacy) (sink-observation privacy)
           (removal qa) (property qa)))
```

- Every promotion needs the owner.
- For each tag present in the change, the mapped role needs one listed member.
- An approval is bound to a hash of (current glossary, proposal). Any edit to either invalidates it.
- Approvals by someone not listed under the claimed role are ignored and reported.

## Tamper evidence

`spec.history` is append-only; each promotion records the SHA-256 of the new `glossary.sigil`. `sigil spec check` fails if the file on disk differs from the last record. `spec init --as OWNER` adopts an existing glossary.

## What this does not do (read before relying on it)

- **It does not authenticate people.** The names in `spec.approvals` are claims. Real identity must come from the host: put `spec.owners`, `spec.approvals`, `spec.history` and `glossary.sigil` under CODEOWNERS with the owner (and reviewers) as required reviewers, require signed commits, and run `sigil spec check` in CI. Without that, anyone with write access can forge an approval line.
- **Effects are structural, not semantic.** The review lists what is built and observed, joins sinks with `policy.sigil` (which labels each sink accepts, whether an exempted declassifier is declared there, and a note when a check or observation is removed) and lists edits inside entries (changed constants, removed checks) without judging whether they weaken anything. It still does not tell a reviewer that a derived value comes from a pii field unless the field name makes that visible. Experiments X2 and X4 found no measurable benefit over a raw diff with Sonnet reviewers (both saturated), so the review is a convenience and an approval gate, not a demonstrated improvement in catch rate.
- **It does not check that an `always` formalisation matches its English.** That is the hardest translation to review. Ideas not built: require the author agent to supply a few positive and negative examples per property, which the tool runs against the formal version; vacuity checks (property holds because its precondition is never met); mutation of the formal property to see whether the reference scenarios notice.
- **Types are still agent-defined.** Placeholder types in glossary phrases (`Role`, `Payment`, `ReasonCode`) come from `app.sigil`, which the implementation agent writes. The data model is part of the spec and should be human-owned too (a `types.sigil` or a vocabulary section generated from the feature). For the experiments the task README fixes the names.
- **`policy.sigil` is not covered yet.** It is the same shape of problem (human-owned, hard to write by hand) and could use the same propose, review, promote flow with tags such as `new-sink` and `widened-sink`.
- **Prototype scale.** Entries are keyed by head plus phrase; renaming a phrase shows as a removal plus an addition.

## Prototype

- `src/spec.ts`: parse entries, effects, tags, diff, coverage, owners, approvals, gate, review rendering (pure).
- `src/spec-cli.ts`: `sigil spec init|review|approve|promote|check DIR`.
- `test/spec-authoring.test.ts`: 27 tests, including an end-to-end run where a proposal that adds a card-derived audit field is blocked until the owner and a privacy reviewer have both signed, and a direct edit of `glossary.sigil` fails `check`.

## Suggested next steps

1. Done in part: sinks are joined with policy. Remaining: join field labels so the review states the sensitivity of a derived value.
2. A spec-author agent prompt and an experiment arm: does an agent-proposed glossary plus effect review catch an injected weakening (a proposal that quietly drops a property or widens an audit record) more reliably than a diff of S-expressions? That is testable with the harness we have.
3. Human-owned data model, then policy proposals.
