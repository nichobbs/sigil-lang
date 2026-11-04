# Agent workflow

`DIR` holds `app.sigil` (yours), plus the human-owned `policy.sigil`, `glossary.sigil` and one `*.feature`. Edit only `app.sigil`.

```
npx tsx src/cli.ts verify DIR --fast   # check + scenarios, rules, properties, privacy (seconds). Use this one.
npx tsx src/cli.ts verify DIR          # the same plus mutation testing: minutes, and it will time out in a shell. Do not run it; the harness runs it after you finish
npx tsx src/cli.ts check  DIR          # ranges, capabilities, flow, ensures only
npx tsx src/cli.ts fix    DIR          # exact edits for open findings (see below)
```

Write the whole program in one go, then run `verify DIR --fast` and iterate on it (it includes `check`, so do not run `check` first). Stop when it is clean: mutation survivors are for the humans who own the spec, not for you. Exit code 0 means no error diagnostics and no failed scenario; exit 2 means a parse error (`error: line:col: message`).

Reading the output, top to bottom:
- Range evidence: one line per function. Lines `FAILED` or `UNPROVED` are defects even though they do not change the exit code. `PROVED (SMT)` is good.
- Capability manifest and flow matrix: confirm each secret source reaches only sinks you expect. `(REJECTED)` marks a violation.
- Diagnostics: `ERROR E-code [fn] message`, with `src: a -> b -> sink` paths for flows. `WARN` should also be cleared.
- Scenarios (`verify`): `FAIL` shows the line and values; `ERR` usually means a glossary phrase or name mismatch (it lists the nearest phrases).
- Mutation (full `verify` only, run by the harness): a SURVIVED mutant means no scenario pins that behaviour; it is informational for the spec owners.

`fix DIR` lists, for each UNPROVED range, list length or divisor, the exact expression to replace and its replacement (a `min`/`max` clamp, a `take`, a `(max 1 d)`), and which `needs` entries to add. It only suggests: a clamp changes behaviour for values outside the range, so apply it only when the intent spec allows that. A `FAILED` obligation (always out of range) has no suggestion because it is a logic error. Apply the first suggestion per function, then rerun: later ones often disappear.

Repair loop: read the first error only; fix its root cause using the code table in LANGUAGE.md; rerun `check`. Never silence a flow error by relabelling a field, widening a type to hide a range problem, or editing `policy.sigil`, the glossary or the feature. If the only fix needs a policy or intent change, stop and report it.
