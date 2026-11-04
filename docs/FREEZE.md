# Language freeze (v0)

Frozen at commit `b202e1b`, 2026-11-04, after the DEV set (A1 to A4) and the cost pilot.

From this point, for the held-out tasks (5 to 12):
- No change to `src/`, `docs/LANGUAGE.md`, `docs/AGENT_WORKFLOW.md`, the checker, the interpreter or the Wasm backend.
- A construct the language lacks makes that task a Sigil failure and is recorded as a language gap (per `docs/EXPERIMENT.md`). It is not added and the run is not repeated.
- Harness fixes (scoring, workspace builder) are allowed only if they are applied to every run and logged in `experiments/README.md`.
- Bugs found in the checker are logged and reported; one that lets a violation escape counts against claim 2.

Known gaps carried in from the DEV set (reported, not fixed): validators cannot be called from code; no `get` in the interpreter; range analysis ignores `if` conditions; an undeclared type name crashes the checker; enum case names are global but not enforced; `Rule:` cannot carry prose; `Money` cannot express negatives; `always` and `forall` cannot see effects; `match` on a literal enum argument warns "can never match"; `requires` is unused by the checker; builtin arity is unchecked in places; flow labels default to public.

## Post-freeze changes (v1), not part of the frozen set

The freeze applies to the frozen experiment, not to the project. Changes made after it are numbered here and have to be stated whenever results are reported, because they change what "the language" means:

- v1 (2026-11-04, after the C1 to C3 Haiku runs): `fold` (bounded iteration with a declared accumulator type), `Str :max N`, `chars`, `from-chars`, `append`, `take`, `drop`, `at`. Motivated by the C1 language gap and the unrolled workarounds in C2 and C3. Any run on a held-out task made after this point uses v1 and is labelled so; those tasks are no longer blind (their gaps and failures were seen), so results are reported separately from the frozen runs and not pooled with them.
- v1 workflow and diagnostics (2026-11-04): `verify --fast`, `sigil fix`, no full `verify` inside the agent loop (the scorer still runs it), unknown-type crash replaced by an E-name error, bare `Int`/`List` parse errors, hints for unknown functions, and `E-type` for a number where a record is declared. These came from a transcript analysis of 21 runs (`/home/claude/exp-work/toolcall-analysis.md`); the first of the known gaps above (undeclared type crash) is fixed.
- v1 sort and proposals (2026-11-04, after the r3 BRIEF.md runs): `sort` (stable merge sort with a comparator lambda; C3 r3 ran out of fuel on a quadratic rank-by-counting workaround), and `proposed-policy.sigil` (an agent may propose narrow declassifiers where the spec itself requires a release; `verify` reports `CLEAN, PENDING HUMAN APPROVAL`, a finished state, and the harness records `verify: clean-pending-approval`). Also a single `BRIEF.md` read for both arms (`NO_BRIEF=1` restores the old flow).
- v1 Wasm validation (2026-11-05, PR #48): every Wasm export is a validating wrapper (declared Int ranges, Bool, enum indices, Str handles and `:max`, Result tags, list lengths), host results the code relies on are range-checked, ABI version 2 with a `validated` flag, and a violation maps to the interpreter's `ContractViolation` with the same reason and place. This closes the gap that compiled modules trusted the caller's input check. It changes only the Wasm backend, which no frozen-experiment run used, so no earlier result is affected. The trust model (what is validated and what is still trusted) is in the Wasm README.
