# system.sigil: composing programs

Status: prototype (Extension 4, C0). Only the static composition check exists. The bit ledger and capability requests in docs/EXPERIMENT.md are not built yet.

A system file wires approved programs into processes and channels and checks, statically, that labels survive the wiring.

```
(system demo
  (approved "PROGRAM-HASH" "SPEC-HASH")
  (declassifier card-band (from pii) (to internal) (hosted-in vault))
  (process vault  (program "PROGRAM-HASH") (spec "SPEC-HASH") (reads pii) (sink db pii))
  (process report (program "R-HASH") (spec "R-SPEC") (in internal) (sink audit internal))
  (channel vault report (carries internal) (via card-band)))
```

- `approved`: the human-owned ledger of (program hash, spec hash) pairs. A process whose pair is not listed is rejected (`E-approval`). This is how a stale or never-approved version is kept out.
- `process`: `reads L` is what it holds intrinsically (default public); `in L` is the highest label it accepts on any inbound channel (default public); `sink NAME L` is the highest label that sink's audience may see.
- `channel FROM TO (carries L) [(via D)]`.
- `declassifier`: the only edge that lowers a label. Must be hosted in the sending process.

Checks, all static:

| Code | Rejects |
| --- | --- |
| `E-chan-undeclared` | a channel to or from an undeclared process |
| `E-approval` | a (program, spec) pair missing from the ledger |
| `E-chan-label` | a channel carrying less than the sender holds, with no declassifier |
| `E-declass` | undeclared declassifier, hosted elsewhere, sender holds more than its `from`, or channel carries less than its `to` |
| `E-ceiling` | a channel carrying more than the receiver's `in` ceiling |
| `E-sink` | a process holding more than one of its sinks is cleared for |

A declassifier may be applied to a sender that holds less than its `from` (it can only release what the sender holds); a declassifier that raises a label (`to` above `from`) is rejected. Names are unique: duplicate processes, declassifiers, `approved` entries and sink names within a process are parse errors.

A process holds the join of its `reads` and everything its inbound channels carry. There is no per-output tracking, so the check is conservative: a process that has seen pii cannot emit an `internal` channel without a declassifier, even if the output does not depend on the pii. The fix is to split the process, which is the intended idiom.

Run: `sigil system check FILE` (exit 0 accepted, 1 rejected, 2 malformed).

Not covered: runtime budgets for repeated releases (C1, C2), capability-carrying requests (C3), timing and other covert channels.
