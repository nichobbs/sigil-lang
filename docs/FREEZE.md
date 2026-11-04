# Language freeze (v0)

Frozen at commit `b202e1b`, 2026-11-04, after the DEV set (A1 to A4) and the cost pilot.

From this point, for the held-out tasks (5 to 12):
- No change to `src/`, `docs/LANGUAGE.md`, `docs/AGENT_WORKFLOW.md`, the checker, the interpreter or the Wasm backend.
- A construct the language lacks makes that task a Sigil failure and is recorded as a language gap (per `docs/EXPERIMENT.md`). It is not added and the run is not repeated.
- Harness fixes (scoring, workspace builder) are allowed only if they are applied to every run and logged in `experiments/README.md`.
- Bugs found in the checker are logged and reported; one that lets a violation escape counts against claim 2.

Known gaps carried in from the DEV set (reported, not fixed): validators cannot be called from code; no `get` in the interpreter; range analysis ignores `if` conditions; an undeclared type name crashes the checker; enum case names are global but not enforced; `Rule:` cannot carry prose; `Money` cannot express negatives; `always` and `forall` cannot see effects; `match` on a literal enum argument warns "can never match"; `requires` is unused by the checker; builtin arity is unchecked in places; flow labels default to public.
