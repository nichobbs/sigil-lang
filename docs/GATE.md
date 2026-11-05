# Deploy gate: admission for an agent-only platform

Status: prototype. This is the policy half of the platform (what may be deployed), not a runtime (nothing schedules, isolates or runs a process).

The trusted unit is a program and spec version identified by two hashes:

- program hash: sha256 over `app.sigil` and `policy.sigil` (length-prefixed, so concatenation cannot be forged)
- spec hash: sha256 over `glossary.sigil` and the `.feature` file

Any edit to either changes the hash, so evidence and approvals attach to exact bytes.

## Roles and artifacts

| Role | Holds | Produces |
| --- | --- | --- |
| attester (CI) | ed25519 key | signed evidence: check errors, scenarios failed, mutants killed/survived, bound to both hashes |
| approver (human owner) | ed25519 key | signed approval of a (program, spec) pair |
| agent | ed25519 key | signed deploy request for one system.sigil (by its sha256) |

The trust file lists the public keys per role and an optional policy (`minKill`, default 1.0; `maxSurvivors`, default 0). Humans approve but cannot deploy; agents deploy but cannot approve. One key may not hold two roles.

The registry is a directory: `units/<program>.<spec>/unit.json` (the attested bytes), `evidence/`, `approvals/`, `releases/`, and an append-only `audit.jsonl`.

## Admission

`sigil gate admit SYSTEM --registry R --trust T --key AGENT` accepts only if all hold:

1. The request is signed by a listed agent key and names this exact system file (`G-deployer`).
2. The static composition check passes (`E-*` codes from docs/SYSTEM.md).
3. Each process's units are in the registry and re-hash to their names, so the registry cannot silently serve other bytes (`G-unit-missing`, `G-unit-tamper`).
4. Each unit has evidence signed by a trusted attester, bound to those hashes, with no check errors, no failing scenarios, a non-empty mutation run and the mutation policy met (`G-evidence`, `G-mutation`).
5. Each unit has a signed approval from a trusted approver, and the deploying key is not that approver (`G-approval`, `G-role-conflict`).

Every decision, accepted or rejected, appends to `audit.jsonl` with the principal and the codes. An accepted deploy writes `releases/<system hash>.json` listing each process's hashes, evidence digest and approvers.

`Registry.loadUnit` is what a runtime should call to start a process: it returns the attested bytes or throws.

## Commands

```
sigil gate keygen FILE
sigil gate attest DIR --registry R --key ATTESTER.key     # stores the unit, runs check, scenarios and mutation, signs evidence
sigil gate approve DIR --registry R --key APPROVER.key
sigil gate admit SYSTEM --registry R --trust T.json --key AGENT.key
```

Exit codes: 0 accepted, 1 rejected, 2 malformed or bad usage.

## What this does not give you

- Evidence is only as good as the checks. Mutation regression does not see property weakenings that no mutant exercises (docs/SPEC_AUTHORING.md); a unit can pass the gate with a vacuous property.
- Attester, approver and agent keys are trusted by listing. Key custody, rotation and revocation are not modelled. Revoking means editing the trust file.
- The unit approver is not yet tied to the spec owners in `spec.owners`; any listed approver counts.
- Approval is per pair, not per system, so a safe unit can be re-wired by an agent in a new system. The composition check is the control for that, and it is conservative, not complete.
- No runtime isolation: a process started from `loadUnit` bytes is only as contained as the host that starts it. Capability mediation at runtime is the C3 experiment (docs/EXPERIMENT.md).
- Registry writes are not atomic (read, append, rewrite) and a release record is overwritten silently, so concurrent writers can lose entries. Fine for a single-writer prototype; a real registry needs an append-only store.
- Dynamic code is not supported: new code is a new unit and goes through attest, approve and admit.
