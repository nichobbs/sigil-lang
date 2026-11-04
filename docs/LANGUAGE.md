# Sigil language spec (for the agent writing code)

You write one file, `app.sigil`: types, validators, functions, and one `program` wiring form. Humans own the intent spec (`*.feature`, `glossary.sigil`) and `policy.sigil`; you cannot change them. Syntax is S-expressions; `;` starts a comment. Names are kebab-case (`price-invoice`); `a.b.c` reads nested fields. Integer literals may be negative (`-5`) or use `_` (`1_000`). Strings are `"..."` with `\n \t \" \\`. Keywords look like `:name`. There are no float, char, null, map, loop or exception values.

## Types

```sigil
; prelude shared by the examples in this spec
(type Cents (Int 0 1000000000000000))   ; (Int lo hi): inclusive, both bounds required, no bare Int
(type Pct (Int 0 100))
(type Plan (var Free Pro Enterprise))   ; enum; case names are global, so unique across all enums
(type Err (var TooSmall StoreFailed MailFailed))
(type Email (Str :validated))           ; Str = text; :validated = must come from a validator
(type Note (Str :max 200))              ; :max N = at most N characters (code points); needed before `chars`
(type Line (rec (unit (Int 0 1000000)) (qty (Int 1 1000))))
(type Customer (rec (id (Int 0 1000000)) (name Str :pii) (email Email :pii) (plan Plan :internal)))
(type Mail (rec (to Email :pii) (subject Str) (body Str :pii)))   ; (field Type flags...)
(type Receipt (rec (cust (Int 0 1000000))))
(validator parse-email (in (s Str)) (out Email) (regex "^[a-z.]+@[a-z.]+$") (sample "a@x.com"))
```

- Other type forms: `Bool`, `Unit`, `(List T min max)` (both bounds required, `0 <= min <= max`), `(Result Ok Err)`. Types may be named or written inline and may nest, except that `Err` in a `Result` that you `try` must be an enum.
- Field flags: confidentiality `:internal < :pii < :secret` (default public) and `:control` (value selects a target or capability; must be validated). A field's flag is an upper bound on what may be stored in it.
- Every integer is an exact mathematical integer with a declared range. Never assume wrapping. Representation (i32/i64/bigint) is derived by the toolchain.
- Name every `:validated` Str type and give it a validator with `(sample ...)` values that match its regex; tests generate values from samples. Validators are not callable from code. A validated value can only arrive as a parameter whose type is a validated type.
- There is no type inference across functions: declare every parameter and result.

## Functions

```sigil
(fn gross
  (in (ls (List Line 1 200)))              ; (in (name Type)...)   zero params: (in)
  (out Cents)                              ; required
  (sum (map ls (fn (l) (mul l.unit l.qty)))))

(fn discount (in (p Plan)) (out Pct)
  (match p (Free 0) (Pro 10) (Enterprise 20)))   ; arms: (Case body); exhaustive

(fn price
  (in (p Plan) (ls (List Line 1 200)))
  (out Cents)
  (ensures (<= out (gross ls)))            ; postcondition over params and `out`; proved or tested
  (div-floor (mul (gross ls) (sub 100 (discount p))) 100))
```

Clauses in order: `in`, `out`, then optional `needs`, `declassifies`, `requires`, `ensures`; the rest is the body (several body forms mean `do`). Functions are total, first-order and non-recursive (no self or mutual calls); define callees anywhere in the file. `requires` is only checked at runtime in tests and raises `W-requires`: encode input constraints in parameter types instead.

## Expressions

| form | meaning |
|---|---|
| `42` `"s"` `true` `false` `x` `x.f.g` | literals, variables, field reads. A bare enum case (`Pro`) is a value. |
| `(f a b)` | call a user function (positional only) |
| `(T a b c)` or `(T :f1 a :f2 b)` | build record `T`: all fields, in declared order or by keyword; no mixing |
| `(let [x e1 y e2] body...)` | sequential bindings; value of last body form |
| `(do e1 e2)` | evaluate in order, value of last |
| `(if c a b)` | `c` must be Bool; both branches required |
| `(match e (Case body)... )` | on an enum: one arm per case. On a Result: `(ok v body)` and `(err e body)`, both required. Binder is optional for enum arms |
| `(fn (x) body)` | one-parameter lambda; only as the 2nd argument of `map` or `filter`. `fold` takes a two-parameter lambda `(fn (acc x) body)`, `sort` a two-parameter comparator `(fn (a b) before)` |
| `(try e :on-err Case)` | `e` is a Result: Ok gives its value, Err returns `(err Case)` from the whole function (function must return a Result with enum Err containing `Case`) |
| `(ok e)` `(err e)` | build a Result |

Builtins (`E-arity` on a wrong count for fixed arities):

| name | args | result |
|---|---|---|
| `add sub mul min max` | 2 | Int |
| `div-floor` | 2 | Int, floor division; divisor range must exclude 0 |
| `neg` | 1 | Int |
| `sum` | 1 list of Int | Int |
| `len` | 1 list | Int |
| `map` `filter` | list, lambda | list (`filter` length becomes 0..max) |
| `sort` | list, `(fn (a b) before)` | the same list, reordered. `before` is true when `a` must come strictly before `b`; the sort is stable (ties keep their input order), so break ties inside `before`, e.g. `(or (< a.price b.price) (and (= a.price b.price) (< a.id b.id)))`. Same length bound and element facts; labels of the comparator flow into the result. About n log n comparisons: use it instead of counting ranks by hand (which is quadratic and can run out of fuel). Not yet compiled to Wasm |
| `fold` | list, Type, init, `(fn (acc x) body)` | a value of Type. Loops over the list in order; `Type` (a declared type name, e.g. `Cents` or a record) is the accumulator's invariant: `init` and every step result must fit it (checked as obligations and at run time), and inside the body `acc` is assumed to be any value of Type. Clamp with `min`/`max` so each step provably fits. Not yet compiled to Wasm |
| `list` | n | list of exactly n elements: `(list)` is the empty list, `(list 0)` is a list holding one 0 (not an empty list) |
| `=` | 2 | Bool, structural equality on any values |
| `< <= > >=` | 2 or more | Bool, chained: `(<= 0 x 100)` |
| `and or` | n | Bool |
| `not` | 1 | Bool |
| `text` | n | Str, concatenates strings and renders other values |
| `money` | 1 Int cents | Str `"$12.34"` |
| `chars` | 1 Str with `:max N` | list of code points, `(List (Int 0 1114111) 0 N)`. Counts characters, not UTF-16 units. A Str without `:max` is `E-type` |
| `from-chars` | 1 list of code points | Str (each element must be 0..1114111; unproved if its range is wider) |
| `append` | list, element | the list with the element at the end (length grows by 1: wrap in `take` to fit a declared max) |
| `take` `drop` | list, n | first n elements, or all but the first n; n below 0 counts as 0, above the length as the length |
| `at` | list, index, default | the element at a 0-based index, or the default when the index is out of range (total, never fails) |
| `ok err` | 1 | Result |
| `put get post emit fresh` | see Capabilities | |
| `declassify` | name, expr | see Declassifiers |

Ranges are interval-based and path-insensitive: `if` conditions do not narrow ranges. Write `(max 0 (sub a b))`, `(min (add a b) 1000000000000000)` or `(div-floor a (max 1 b))` so the result provably fits its declared type. Mixed `Result` and plain values are your responsibility; the checker is not a full type checker, so match record and parameter shapes carefully.

```sigil
(fn half (in (n Cents)) (out (Result Cents Err))
  (if (> n 0) (ok (div-floor n 2)) (err TooSmall)))

(fn quarter (in (n Cents)) (out (Result Cents Err))
  (let [h (try (half n) :on-err TooSmall)]
    (ok (div-floor h 2))))

(fn half-or-zero (in (n Cents)) (out Cents)
  (match (half n) (ok v v) (err e 0)))

(fn clamp-sub (in (a Cents) (b Cents)) (out Cents) (max 0 (sub a b)))
```

Patterns. There is no mutable state: pass state in as parameters and return updated values by building a new record. Authorization is a `match` on a role enum returning `Err`. Counting and totalling use `filter`, `map`, `len`, `sum`; anything stateful across a list (running totals, caps on a running balance, first match) uses `fold`, with a record type as the accumulator when you need several values: `(fold xs Acc (Acc 0 0) (fn (a x) (Acc (min (add a.sum x) 1000000000000000) (min (add a.n 1) 1000))))`.

```sigil
(type Role (var Admin Member))
(type RefundErr (var Denied TooLarge))

(fn refund (in (role Role) (amt Cents) (paid Cents)) (out (Result Cents RefundErr))
  (match role
    (Admin (if (<= amt paid) (ok amt) (err TooLarge)))
    (Member (err Denied))))

```

## Information flow

Every value carries a confidentiality label (public < internal < pii < secret) and an integrity label (untrusted < screened < validated < approved < trusted). Labels come from types: fields flagged `:pii` produce pii data when read; a plain `Str` parameter is untrusted; `Int`, `Bool`, enums and validated Str parameters are validated; literals are trusted. Labels join through every operation (confidentiality rises, integrity falls), including branching: data computed or emitted under an `if` or `match` on a pii value is itself pii (implicit flow).

- Building a record: each field's value must not exceed the field's confidentiality (`E-flow`), and a `:control` or `:validated` field needs integrity of at least validated (`E-integrity`).
- Capability operation arguments must not exceed the sink's policy level (`E-flow`).

```sigil-error
; expect: E-flow
(fn leak-name (in (c Customer)) (out Mail)
  (Mail c.email c.name "hello"))          ; pii name into the public `subject` field
```

```sigil-error
; expect: E-integrity
(fn trust-me (in (addr Str)) (out Mail)
  (Mail addr "hi" "body"))                ; untrusted Str into a :validated field
```

Fix hints: give the receiving field the right flag (only if the intent spec allows it), send something else, or take a validated parameter type. Do not launder data through `text`, `=`, `len` and so on: labels follow it.

## Capabilities, wiring, policy

A function touches the outside world only through handles named in its `needs`. A handle is `kind` or `kind:name` (`audit`, `store:orders`, `net:mail`). A function must list every handle used by itself and by every function it calls.

| op | kind | args | result |
|---|---|---|---|
| `(put h key value)` | store | 3 | `(Result Unit _)` |
| `(post h payload)` | net | 2 | `(Result Unit _)` |
| `(emit h event)` | audit | 2 | Unit |
| `(fresh h)` | rand | 1 | Int in 0..9007199254740991 |

(`get` exists in the checker but the reference interpreter cannot run it; do not use it.) Other kinds (`clock fs gpu device`) can be bound but have no operations. Unit has no literal: a Unit function ends with `emit` or similar. Do not discard a `put` or `post` result silently: use `try` or `match`.

`program` is the only place platform and authority appear. `(bind handle (kind caveats...))` needs `handle` to start with `kind`; a caveat is `(key "value"...)` or a bare symbol. Targets are `server browser native`; kinds `fs` needs server or native, `gpu` browser or native, `device` native only (`E-target`).

`policy.sigil` is human-owned. `(allow kind (key "pattern"))` caps what a bind may ask for (a trailing `*` is a prefix glob; `(allow kind)` allows any). `(sink handle (accepts conf))` is the highest confidentiality that handle may receive; a handle with no sink accepts only public. A bind outside the policy is `E-policy`.

```sigil-policy
(policy
  (allow store (ns "app/*"))
  (allow net (connect "https://mail.acme.com"))
  (allow audit)
  (sink store:orders (accepts pii))
  (sink net:mail (accepts pii))
  (sink audit (accepts internal)))
```

```sigil
(fn issue
  (in (c Customer))
  (out (Result Receipt Err))
  (needs store:orders net:mail audit)
  (let [r (Receipt c.id)]
    (try (put store:orders c.id r) :on-err StoreFailed)
    (match (post net:mail (Mail c.email "Receipt" (text "Hello " c.name)))
      (ok _ (do (emit audit r) (ok r)))
      (err _ (err MailFailed)))))

(program shop
  (targets server browser)
  (entry issue
    (bind store:orders (store (ns "app/orders")))
    (bind net:mail (net (connect "https://mail.acme.com")))
    (bind audit (audit))))
```

```sigil-error
; expect: E-cap
(fn ping (in (c Customer)) (out Unit)
  (post net:mail c.email))                ; uses net:mail without (needs net:mail)
```

```sigil-error
; expect: E-flow
(fn log-customer (in (c Customer)) (out Unit)
  (needs audit)
  (emit audit c))                         ; pii reaches audit, which accepts only internal
```

## Declassifiers

Releasing labelled data is possible only through a declassifier declared in the policy; code names it in `declassifies` and applies `(declassify name expr)`. It lowers confidentiality from at most `from` to `to`; integrity is unchanged; data above `from` is `E-flow`. The policy's `fields` and `fns` restrict where it applies (`E-policy`). The checker does not check that `expr` really reduces information: write a coarse expression such as a band.

```sigil-policy
(policy
  (declassify salary-band (from pii) (to internal)
    (reason "Audit may record a salary only as a 10,000-wide band.")
    (fields Applicant.salary) (fns screen)))
```

```sigil
(type Applicant (rec (id (Int 0 1000000)) (salary (Int 0 10000000) :pii)))
(type Screened (rec (id (Int 0 1000000)) (band (Int 0 1000) :internal)))

(fn screen (in (a Applicant)) (out Unit)
  (needs audit)
  (declassifies salary-band)
  (emit audit (Screened a.id (declassify salary-band (div-floor a.salary 10000)))))
```

## Reading the intent spec

You do not write these, but your code must match them. The feature file uses `Feature:`, `Rule:` (a `|` table), `Example:` with `Given/When/Then/And/But` lines, `Always:`, `Privacy:` and `Unresolved:` (human questions; leave them). Each sentence must match a glossary phrase, where `{name:Type}` captures a value. Placeholder types: `Int`, `Str` (`"..."`), `Money` (`$10.00`, cents), `Pct` (`10%`), any enum, any Int-range type, any validated Str type (the literal must match its validator regex).

```sigil-glossary
(glossary
  (given "a {plan:Plan} customer" (set plan plan))
  (given "an order of {qty:Int} x {unit:Money}" (append lines (Line unit qty)))
  (given "the mail service is unavailable" (fail net:mail post))
  (when "the order is priced" (default plan Free) (call total price plan lines))
  (when "an order is issued"
    (call result issue (Customer 7 "Ada" "a@x.com" Free)))
  (then "the total is {amount:Money}" (expect (= total amount)))
  (then "the issue fails with \"mail failed\"" (expect (= result (err MailFailed))))
  (then "the failed order is stored once" (expect (= (len (stored store:orders)) 1)))
  (rule "Discount depends on the customer's plan" discount (Plan Pct))
  (always "The price never exceeds the undiscounted total."
    (forall ((p Plan) (ls (List Line 1 200))) (<= 0 (price p ls) (gross ls))))
  (privacy "The customer's name is only sent to mail.acme.com."
    (source Customer.name) (allow net:mail) (run issue)))
```

```sigil-feature
Feature: Shop

  Rule: Discount depends on the customer's plan
    | Plan       | Discount |
    | Free       | 0%       |
    | Pro        | 10%      |
    | Enterprise | 20%      |

  Example: A Pro customer gets 10% off
    Given a Pro customer
    And an order of 2 x $10.00
    When the order is priced
    Then the total is $18.00

  Example: A failed email is reported but the order is kept
    Given the mail service is unavailable
    When an order is issued
    Then the issue fails with "mail failed"
    And the failed order is stored once

  Always: The price never exceeds the undiscounted total.

  Privacy: The customer's name is only sent to mail.acme.com.
```

- Glossary actions: `(set n e)`, `(default n e)` (only if unset), `(append n e)` (to a list), `(call n fn args...)` (result into `n`; your function must have that name, arity and parameter order), `(fail handle op)` (make that capability op return Err; ops `put post emit fresh`), `(expect bool-expr)`. Expressions may use your types, record constructors (positional order is your declared field order), enum cases, builtins, and `(sent h)`, `(stored h)`, `(emitted h)`, which list successful posts, stored values and emitted events.
- `rule "T" fn (ColType...)`: table columns are the arguments then the expected result. `always`: 500 random inputs. `privacy`: static flow check plus two runs differing only in the source field; flows to other sinks fail. `(declassified name)` in a privacy binding means a human accepted that release.
- Types or functions the glossary mentions must exist in `app.sigil` with those names. Functions that run as properties or privacy targets get random arguments, so validated Str params need a named type with a validator and samples.

## Checks

`check` runs: parse; names, fields and arities; interval ranges (every call argument, record field and result must provably fit its declared type, no division by a possible zero); enum and Result matches; capabilities against `needs`, binds, targets and policy; confidentiality and integrity flow with a path from source to sink; `ensures` (intervals, then SMT). `verify` adds the feature scenarios, rules, properties, privacy runs and mutation testing. The exit code is non-zero on any error diagnostic or failed scenario. Lines marked `FAILED` or `UNPROVED` in the range evidence are also defects: fix them.

| code | meaning | fix |
|---|---|---|
| E-name | unknown function, variable, type, or builtin | spell it as declared; validators are not callable |
| E-field | no such field on a value or in a record constructor | use the declared field names |
| E-arity | wrong argument count, missing record fields, mixed positional and keyword | match the signature or table above |
| E-type | arithmetic on a non-number | pass an Int, e.g. `(len xs)` not `xs` |
| E-cap | handle not in `needs`, no `bind`, wrong kind, or unknown kind | add it to `needs` (also for callees) and to `program` |
| E-flow | data above a field's or sink's level | remove the data, or ask for a policy change or declassifier; never relabel |
| E-integrity | untrusted data into a `:validated`/`:control` field | take a validated parameter type |
| E-match | non-exhaustive match (warning if an arm can never match) | one arm per case |
| E-try | `try` in a function not returning Result, or `:on-err` not an Err case | return a Result with enum Err |
| E-lambda | lambda outside `map`/`filter`/`fold`/`sort`, or wrong parameter count (1, or 2 for `fold` and `sort`) | inline it |
| E-target | capability kind unavailable on a declared target | change targets or kind |
| E-policy | bind exceeds `allow`, or declassifier undeclared or out of scope | lower the bind, or ask a human to change the policy |
| (crash) `unknown type X` | a type name is not declared; the checker aborts with a stack trace | declare the type |
| other | E-entry (`entry` not a fn), E-declassify (not in `declassifies`), W-depth (recursion), W-declassify (unused), W-requires | name a real fn, declare `declassifies`, flatten helpers, remove it, move the constraint into types |

## Not supported

No recursion, loops (other than `fold` over a bounded list), mutation, closures as values, user-defined generics, higher-kinded types, floats, maps, sets, tuples, optionals or null, string operations beyond `text`, `money`, `=` and taking a bounded Str apart with `chars` / putting one back with `from-chars` (no split, regex match, case change, formatting widths: build them with `chars` and `fold`; digits to a number is `(sub code 48)` in a fold), no date or time, no random or I/O other than `put post emit fresh`, no imports or modules (one `app.sigil`), no unbounded `Int` or `List`, no `concat`, `zip` or `reverse` (build them with `fold` and `append`), no user-callable validators, and no Wasm or syntax choices on your side. If the task needs something here, model it with bounded integers, enums, lists processed by `map`/`filter`/`sum`/`len`/`fold`, or report the gap instead of faking it.
