# F1: s-expression reader

Implement `read-sexp`: read one s-expression from a text and return its syntax tree as a flat list of nodes in post-order.
`intent.feature` (with `glossary.sigil` and `policy.sigil`) says what it must do. This file fixes the interface, so that an
automatic scorer can call your program. The scorer runs hidden cases against it; the examples in `intent.feature` are only a sample.

This is a pure function: no effects, no capabilities.

## Entry point

Name: `read-sexp` in Sigil, `run` in TypeScript. Parameter: `src` (`Source`), the text to read. Result: `Result Tree ReadError`.

## Types

| Type | Definition |
|---|---|
| `Source` | text of at most 200 characters (characters are Unicode code points) |
| `Offset` | integer 0 to 200 |
| `Index` | integer -1 to 59 (a position in the node list, or -1 for none) |
| `NodeKind` | one of `Atom`, `Text`, `Form` |
| `ReadError` | one of `Empty`, `Trailing`, `Unclosed`, `Stray`, `UnterminatedText`, `TooBig` |
| `Node` | record `kind` (NodeKind), `start` (Offset), `end` (Offset), `parent` (Index), `arity` (integer 0 to 60) |
| `Tree` | list of `Node`, 1 to 60 nodes |

## Reading rules

- Spaces, tabs and newlines separate things. A semicolon starts a comment that runs to the end of the line (a newline ends it).
- `(` opens a **form**, `)` closes the innermost open form. A form holds any number of items (atoms, texts, forms), including none.
- A **text** starts with a double quote and ends at the next double quote, and can hold any characters including newlines,
  parentheses and semicolons. There are no escapes.
- An **atom** is a maximal run of characters that are not spaces, tabs, newlines, parentheses, semicolons or double quotes.
- The source must hold exactly one top-level item (an atom, a text or a form).

## The tree

Nodes are listed in **post-order**: an item's children come before it, in source order; the top-level item is the last node.
For each node, `start` is the offset of its first character and `end` the offset just after its last character (offsets count
characters from 0; a form runs from its `(` to just after its `)`). `arity` is the number of direct children (0 for atoms and
texts). `parent` is the index in the list of the node's parent form, and -1 for the top-level item.

## Errors

The source is scanned from left to right and the first problem found decides the error:

- a `)` with no open form: `Stray`;
- a second top-level item starting after the first one is complete: `Trailing`;
- a text with no closing double quote: `UnterminatedText`;
- a node that would be the 61st: `TooBig` (a node counts when it is complete: an atom or text at its end, a form at its `)`);
- at the end of the source, when forms are still open: `Unclosed`; when there was no item at all: `Empty`.

## Sigil arm

Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them.

## TypeScript arm

Put your program in `solution.ts`. It default-exports `run(args, host)` (the host is unused), where `args` is `{ "src": <string> }`.

## JSON conventions

Strings are strings; integers JSON numbers; enum values the case name as a string; records objects with the field names above; lists arrays.
The result is `{"ok": [<Node>, ...]}` or `{"err": "Stray"}` and so on.
