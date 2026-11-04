# C3: catalogue search

Implement `search`: given a catalogue (a list of items) and a query, return one page of the matching items, as ids, with the
total number of matches and a flag saying whether more pages follow. `intent.feature` (with `glossary.sigil` and
`policy.sigil`) says what it must do. This file fixes the interface, so that an automatic scorer can call your program. The
scorer runs hidden cases against it; the examples in `intent.feature` are only a sample.

The catalogue is passed in. `search` is a pure function: it reads nothing, stores nothing, sends nothing and audits nothing.

## Entry point

Name: `search`. Parameters, in order:

| Parameter | Type | Meaning |
|---|---|---|
| `items` | `List Item 0 100` | the catalogue, in no particular order; the ids of its items are all different |
| `query` | `Query` | what to look for, how to sort it and which page to return |

Result: `Page`.

## Types

| Type | Definition |
|---|---|
| `Id` | integer 0 to 1 000 000 000 |
| `Cents` | integer 0 to 100 000 000 (money is whole cents everywhere) |
| `Rating` | integer 0 to 50: a rating in tenths of a star, so 35 means 3.5 stars |
| `Stock` | integer 0 to 100 000 |
| `Category` | one of `Books`, `Games`, `Garden`, `Kitchen`, `Toys` |
| `SortOrder` | one of `PriceAsc`, `PriceDesc`, `RatingDesc` |
| `Item` | record `id` (Id), `category` (Category), `price` (Cents), `rating` (Rating), `stock` (Stock), `hidden` (Bool), `title` (Str) |
| `Query` | record `anyCategory` (Bool), `category` (Category), `minPrice` (Cents), `maxPrice` (Cents), `minRating` (Rating), `inStockOnly` (Bool), `order` (SortOrder), `pageSize` (integer 1 to 20), `page` (integer 0 to 100 000) |
| `Page` | record `ids` (list of `Id`, 0 to 20 long), `total` (integer 0 to 100), `hasMore` (Bool) |

How a `Query` is read:

- `anyCategory` true means any category matches and `category` is then meaningless (it still holds some value, which must be
  ignored). `anyCategory` false means only items of `category` match.
- There are no optional fields. "No lower price limit" is `minPrice` 0, "no upper price limit" is `maxPrice` 100 000 000 (the largest
  `Cents`), and "no rating limit" is `minRating` 0. If `minPrice` is greater than `maxPrice`, nothing matches.
- `inStockOnly` true means an item matches only if its `stock` is at least 1.
- `order` is the sort order and `pageSize` and `page` select the page (`page` counts from 0).

`Page` fields: `ids` are the ids of the items on the requested page, in order (the order of the sorted matches); `total` is the
number of matching items over all pages; `hasMore` says whether positions after this page exist. A page past the end has an
empty `ids`.

Every item has a `title`, which the search never looks at. Ids and amounts here stay far below 2^53.

## Effects

None. There is no capability (no store, network, audit, clock or randomness). The scorer compares only the returned value.

## Sigil arm

- Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them.
- The `program` form needs no `bind`.
- There is no sort in Sigil; if you need a sorted order, build it from what the language has.

## TypeScript arm

- Put your program in `solution.ts`. It default-exports `run(args, host)`, which may be `async`; `host` is not used here:

```ts
export default function run(args: { items: Item[]; query: Query }, host?: unknown): Page
```

- Values are plain JSON (see below). Integers are JS numbers.

## JSON conventions (what the scorer sends and expects)

- integers: JSON numbers; booleans: booleans; `Str`: strings; enum values (`Category`, `SortOrder`): the case name as a string, e.g. `"PriceAsc"`.
- records: objects with the field names above; lists: arrays.
- the result is the `Page` object itself (it is not wrapped in `ok`): `{"ids": [3, 1, 2], "total": 3, "hasMore": false}`.
