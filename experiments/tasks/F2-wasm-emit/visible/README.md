# F2: expression to WebAssembly

Implement `emit-module`: turn an arithmetic expression, given as a flat list of nodes in post-order (reverse Polish), into the
bytes of a WebAssembly module. `intent.feature` (with `glossary.sigil` and `policy.sigil`) says what it must do. This file fixes the
interface, so that an automatic scorer can call your program. The scorer runs hidden cases against it; the examples in
`intent.feature` are only a sample. It is a small piece of what a compiler's Wasm backend does.

This is a pure function: no effects, no capabilities.

## Entry point

Name: `emit-module` in Sigil, `run` in TypeScript. Parameter: `nodes` (`Expr`). Result: `Result Module EmitError`.

## Types

| Type | Definition |
|---|---|
| `Op` | one of `Const`, `Param0`, `Param1`, `Add`, `Sub`, `Mul` |
| `Lit` | integer -1 000 000 to 1 000 000 |
| `ENode` | record `op` (Op), `val` (Lit): `val` is the constant for `Const` and is ignored (any value) for every other op |
| `Expr` | list of `ENode`, 1 to 40 nodes |
| `Byte` | integer 0 to 255 |
| `Module` | list of `Byte`, 0 to 400 bytes |
| `EmitError` | one of `StackUnderflow`, `BadShape` |

## The expression

The nodes are a stack program evaluated left to right: `Const` pushes its `val`, `Param0` and `Param1` push the function's first and
second argument, and `Add`, `Sub`, `Mul` pop two values and push their result (`Sub` computes the first-pushed operand minus the
second-pushed one). An `Add`, `Sub` or `Mul` with fewer than 2 values on the stack is refused as `StackUnderflow`, checked in node order. When
all nodes are consumed and the stack does not hold exactly one value, the result is refused as `BadShape`. All arithmetic is 64-bit
integer arithmetic (wrapping).

## The module (exactly these bytes, nothing else)

A module is the 8 header bytes `00 61 73 6D 01 00 00 00`, then four sections, each written as: the section id, the payload length
as an unsigned LEB128, then the payload.

1. Type section (id 1), payload `01 60 02 7E 7E 01 7E` (one function type: two i64 parameters, one i64 result).
2. Function section (id 3), payload `01 00` (one function of type 0).
3. Export section (id 7), payload `01 01 66 00 00` (one export, the name "f", a function, index 0).
4. Code section (id 10), payload: `01` (one body), the body length as an unsigned LEB128, then the body. The body is `00`
   (no local declarations), then the instructions, then `0B` (end).

Instructions: `Const` is `42` followed by the value as a signed LEB128; `Param0` is `20 00`; `Param1` is `20 01`; `Add` is `7C`, `Sub` is `7D`,
`Mul` is `7E`.

LEB128 uses the minimal number of bytes. Unsigned: 7 bits at a time, least significant first, high bit set on every byte except the last.
Signed: the same, two's complement, and the last byte is the first one whose remaining value is 0 (when bit 6 of the byte is clear) or -1
(when bit 6 is set).

## Sigil arm

Put your program in `app.sigil`. Declare the types above under exactly these names, because `glossary.sigil` uses them.

## TypeScript arm

Put your program in `solution.ts`. It default-exports `run(args, host)` (the host is unused), where `args` is `{ "nodes": [ {"op": "Const", "val": 5}, ... ] }`.

## JSON conventions

Integers are JSON numbers, enum values the case name as a string, records objects with the field names above, lists arrays.
The result is `{"ok": [<byte>, ...]}` or `{"err": "BadShape"}`.
