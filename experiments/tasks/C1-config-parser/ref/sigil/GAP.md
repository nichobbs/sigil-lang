# C1 Sigil reference: not written (language gap)

`docs/LANGUAGE.md` ("Not supported") allows only `text`, `money` and `=` on `Str`: "no length, slice, split, parse, regex match,
case change, formatting widths". `parse-config` takes the whole file as one `Str` and has to look inside it. The Sigil arm therefore cannot
pass this task, and no `app.sigil` is written. The Sigil arm scores as a failure for C1 (a language gap, per the freeze rule in `docs/EXPERIMENT.md`).

Missing constructs, each the minimum the natural task needs:

1. **Character access or a way to take a `Str` apart.** Any of: `char-at`/`substring`, `split` on a delimiter, or `str->list` to a
   `(List Str ..)` or `(List (Int 0 1114111) ..)`. Without one, the parser cannot find a newline, the first `=`, a `#` or a `"`.
   (A `Str` can only be built with `text`, rendered with `money`, and compared with `=`.)
2. **Iteration over the characters of the input.** Even with (1), a scanner is a left-to-right pass with state (in string or not, seen
   `=` or not). `map`/`filter`/`sum` cannot carry state from one element to the next, and there is no fold, loop or recursion
   (functions are non-recursive, call depth is limited to 8). A bounded `fold` (or a `scan`) over a list of at most 2000 elements would do it.
3. **Parsing digits to an integer** (`parse-int`, or digit-to-value on characters). `Int` values cannot be derived from `Str`
   at all, so the settings' `num` field could not be filled. With (1) and (2) it could be done as a fold with `add`/`mul`.
4. **Calling a validator.** `Str :validated` types with a `(regex ...)` exist, but validators are "not callable from code" and a validated
   value "can only arrive as a parameter". The key and the integer syntax are regular, yet they cannot be tested from code.

Not a gap, handled by other means: duplicate detection (`filter` and `len` on the settings found so far), the range check on integers
(`<=`, `>=`), the result and error records, and the enum for reasons. Those exist; the first four items above are what is missing.

`hidden/cases.json` was validated with the TypeScript reference and an independent Python oracle (a character-scanner written separately;
not committed). `visible/glossary.sigil` was checked only against a stub `app.sigil` (all phrases bind; the Examples and Always
properties fail against the stub, as expected), because no implementation can pass them.
