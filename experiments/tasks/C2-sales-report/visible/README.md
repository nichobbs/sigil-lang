# C2: sales report

Implement `build-report`: aggregate a list of sale lines into one report record.
`intent.feature` (with `glossary.sigil` and `policy.sigil`) says what it must do. This file fixes the interface, so
that an automatic scorer can call your program. The scorer runs hidden cases against it; the examples in
`intent.feature` are only a sample.

The program is a pure computation over its parameters. It has no effects: it stores nothing, sends nothing and audits
nothing, and it keeps no state between calls.

## Entry point

Name: `build-report`. Parameters, in order:

| Parameter | Type | Meaning |
|---|---|---|
| `sales` | `(List Sale 0 200)` | 0 to 200 sale lines |
| `scope` | `Scope` | which region the report covers |

Result: a `Report` record (not a `Result`: this function cannot fail).

## Types

| Type | Definition |
|---|---|
| `Cents` | integer 0 to 1 000 000 000 000 (money is whole cents everywhere) |
| `Product` | integer 0 to 49 (a product code) |
| `Region` | one of `North`, `South`, `East`, `West` |
| `Scope` | one of `AllRegions`, `OnlyNorth`, `OnlySouth`, `OnlyEast`, `OnlyWest` |
| `Sale` | record `region` (Region), `product` (Product), `qty` (integer 1 to 1000), `unit` (integer 1 to 1 000 000, cents per unit), `refunded` (Bool) |
| `Report` | record `total` (Cents), `north` (Cents), `south` (Cents), `east` (Cents), `west` (Cents), `count` (integer 0 to 200), `best` (integer -1 to 49), `average` (Cents) |

Case names are global in Sigil, which is why the `Scope` cases are not just `All`, `North`, and so on.

## What the report holds

All of these are computed from the **counted** sales only. A sale is counted when it is not refunded and it is in the
region the scope names (`AllRegions` counts every region).

- The revenue of a sale is `qty * unit`, in cents.
- `total`: the sum of the revenue of the counted sales.
- `north`, `south`, `east`, `west`: the sum of the revenue of the counted sales in that region. A region the scope
  excludes has `0`.
- `count`: the number of counted sales (each line is one sale, whatever its `qty`).
- `best`: the product code with the highest revenue, where a product's revenue is the sum of the revenue of its counted
  sales. If two or more products tie on revenue, the lowest product code wins (not the first one seen). If no sale is
  counted, `best` is `-1`, meaning none.
- `average`: `total` divided by `count`, rounded half up to a whole cent: `floor((2 * total + count) / (2 * count))`.
  A fraction of exactly one half is rounded up; this is not truncation, and not round half to even. If `count` is `0`,
  `average` is `0`.

Everything fits the declared ranges for every input the scorer sends: the largest possible total is 200 x 1000 x
1 000 000 = 200 000 000 000 cents.

Data classification: there is no personal or secret data. Everything is public.

## Effects

None. The scorer expects no stored values, no posts and no audit events.

## Sigil arm

- Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them.
- `glossary.sigil` needs the types `Region`, `Scope`, `Sale`, `Report`, and the entry `build-report`; no other function is named.
- `(program ... (entry build-report))` needs no `bind`, because the entry needs no capability.

## TypeScript arm

- Put your program in `solution.ts`. It default-exports `run(args, host)`, which may be `async`. It does not use `host`:

```ts
export default function run(
  args: { sales: Sale[]; scope: Scope },
  host: unknown,
): Report
```

- Values are plain JSON (see below). Integers are JS numbers; every amount here stays below 2^53.

## JSON conventions (what the scorer sends and expects)

- integers: JSON numbers; booleans: `true` / `false`; enum values (`Region`, `Scope`): the case name as a string, e.g. `"North"`, `"OnlyEast"`.
- records: objects with the field names above; lists: arrays.
- the result is the report object itself, for example
  `{"total": 2500, "north": 2000, "south": 500, "east": 0, "west": 0, "count": 2, "best": 3, "average": 1250}`.
