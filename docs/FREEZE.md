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
