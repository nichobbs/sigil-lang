# C1: configuration file parser

Implement `parse-config`: read the text of a small configuration file and return the settings in it, or the first
line that is wrong and why. `intent.feature` (with `glossary.sigil` and `policy.sigil`) says what it must do. This file fixes
the interface and the complete grammar, so that an automatic scorer can call your program. The scorer runs hidden cases against it;
the examples in `intent.feature` are only a sample.

The parser is a pure function: no capability is used, nothing is stored, sent or emitted.

## Entry point

Name: `parse-config` in Sigil; `run` in TypeScript. Parameter:

| Parameter | Type | Meaning |
|---|---|---|
| `text` | `Str` | the whole file, at most 2000 characters (the scorer never sends more); may be empty |

Result: `Result Config ParseError`.

## Types

| Type | Definition |
|---|---|
| `Kind` | one of `IntValue`, `BoolValue`, `TextValue` |
| `Reason` | one of `BadKey`, `BadValue`, `Duplicate`, `Unterminated` |
| `Setting` | record `key` (Str), `kind` (Kind), `num` (Int -2147483648 to 2147483647), `flag` (Bool), `text` (Str) |
| `Config` | record `settings` (List of Setting, 0 to 500 entries) |
| `ParseError` | record `line` (Int 1 to 2000), `reason` (Reason) |

A `Setting` holds one value, selected by `kind`; the two fields that do not belong to the kind hold their neutral value
(`0`, `false`, `""`):

| value in the file | `kind` | `num` | `flag` | `text` |
|---|---|---|---|---|
| integer `-42` | `IntValue` | `-42` | `false` | `""` |
| boolean `true` | `BoolValue` | `0` | `true` | `""` |
| boolean `false` | `BoolValue` | `0` | `false` | `""` |
| string `"hi"` | `TextValue` | `0` | `false` | `hi` (without the quotes) |

## Grammar

The text is split into lines at every newline character (`\n`, code 10). The first line is line 1. A final newline at the very
end of the text does not start another line, and in any case an empty line is blank. Every other character, including
a carriage return (`\r`), belongs to its line. Characters are counted as the language counts them; the scorer sends only characters
that are one unit long.

*Blank* = space (code 32) or tab (code 9). Nothing else is blank. Each line is examined on its own, in this order, and the first rule
that fails decides the line's reason. A line that passes every rule is a setting.

1. **Skipped lines.** Skip leading blanks. If nothing is left, or the next character is `#`, the line is skipped (blank line or comment line).
2. **Key.** Find the first `=` on the line. If there is none, the line is `BadKey`. The key text is everything between the leading
   blanks and that `=`, with the blanks just before the `=` removed. It is valid when it has 1 to 64 characters, its first character is
   `A`-`Z`, `a`-`z` or `_`, and every other character is `A`-`Z`, `a`-`z`, `0`-`9`, `_`, `.` or `-` (ASCII only, case matters).
   Otherwise the line is `BadKey`. (So `a #= 1` is `BadKey`: a hash before the equals sign is not a comment there.)
3. **Value.** Skip blanks after the `=`. If nothing is left, or the next character is `#`, the line is `BadValue` (the value is missing).
   - If the next character is `"`, the value is a *string*: it ends at the next `"` on the line, and everything between is the text
     (any characters except `"`, including `#`, `=` and blanks; there are no escape sequences). If there is no closing `"` on the line,
     the line is `Unterminated`.
   - Otherwise the value is the *token* that runs up to the next blank, the next `#` or the end of the line. The token must be
     either exactly `true` or `false` (lower case), or an *integer*: an optional `+` or `-` and then one or more digits `0`-`9`,
     with any number of leading zeros (`0042` is 42, `-0` is 0). An integer whose value is below -2147483648 or above 2147483647
     is `BadValue`, however many digits it has. Any other token (`yes`, `True`, `1.5`, `0x10`, `1_000`, `-`, `5"x`) is `BadValue`.
   - After the string or the token, skip blanks. The rest of the line must be empty or start with `#` (a comment that runs to the end
     of the line); anything else (for example a second value) is `BadValue`.
4. **Duplicate.** If an earlier line of the text is a setting with the same key (compared character for character, so `a` and `A` differ),
   the line is `Duplicate`. This is the last check: a line that is `BadKey`, `Unterminated` or `BadValue` is reported as that, even when its key
   was already set.

The result is `ok` with the settings in the order of their lines, or, as soon as a line is refused, `err` with that line's number and reason:
only the first refused line is reported and later lines are not examined. Whether or not the text ends with a newline makes no difference.

## JSON conventions (what the scorer sends and expects)

- the argument is `{"text": "<the file>"}`; newlines inside the text are `\n` in the JSON string.
- integers: JSON numbers; booleans: booleans; strings: strings; enum values (`Kind`, `Reason`): the case name as a string.
- records are objects with the field names above. A `Setting` is `{"key": "port", "kind": "IntValue", "num": 8080, "flag": false, "text": ""}`.
- the result is `{"ok": {"settings": [<Setting>, ...]}}` or `{"err": {"line": 3, "reason": "BadValue"}}`.
- there are no effects: the scorer expects none.

## Sigil arm

- Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them, and name the function `parse-config`.
- The `program` form needs no `bind`.

## TypeScript arm

- Put your program in `solution.ts`. It default-exports `run(args)`; the `host` argument is passed but not needed.

```ts
export default function run(args: { text: string }): Result
```

- Values are plain JSON as described above. `num` must be a plain number (write `0`, not `-0`, for `-0` in the file).
