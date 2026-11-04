# Agent workflow

`DIR` holds `app.sigil` (yours), plus the human-owned `policy.sigil`, `glossary.sigil` and one `*.feature`. Edit only `app.sigil`.

```
npx tsx src/cli.ts check  DIR    # fast: ranges, capabilities, flow, ensures
npx tsx src/cli.ts verify DIR    # check + scenarios, rules, properties, privacy, mutation
```

Run `check` after every edit, `verify` when `check` is clean. Exit code 0 means no error diagnostics and no failed scenario; exit 2 means a parse error (`error: line:col: message`).

Reading the output, top to bottom:
- Range evidence: one line per function. Lines `FAILED` or `UNPROVED` are defects even though they do not change the exit code. `PROVED (SMT)` is good.
- Capability manifest and flow matrix: confirm each secret source reaches only sinks you expect. `(REJECTED)` marks a violation.
- Diagnostics: `ERROR E-code [fn] message`, with `src: a -> b -> sink` paths for flows. `WARN` should also be cleared.
- Scenarios (`verify`): `FAIL` shows the line and values; `ERR` usually means a glossary phrase or name mismatch (it lists the nearest phrases).
- Mutation: a SURVIVED mutant means no scenario pins that behaviour; it is informational, report it rather than editing the spec.

Repair loop: read the first error only; fix its root cause using the code table in LANGUAGE.md; rerun `check`. Never silence a flow error by relabelling a field, widening a type to hide a range problem, or editing `policy.sigil`, the glossary or the feature. If the only fix needs a policy or intent change, stop and report it.
