// JS host adapter for compiled Sigil modules: implements the module's `host` imports on top of the interpreter's
// Host class (src/interp.ts), so that effect logs of the interpreter and of the compiled Wasm can be compared.
//
// Host ABI (all imports are in module "host"; the module's custom section `sigil.abi` describes them):
//
//   Strings are opaque i32 handles into a table owned by the host. Handle 0 is "", handles 1..n are the module's
//   literals (AbiDescriptor.strings), later handles are created by the host on demand and live until the next call.
//     str_eq(a: i32, b: i32) -> i32                 1 when the two strings are equal
//     str_concat(a: i32, b: i32) -> i32             a ++ b
//     str_int(v: i64) -> i32                        the decimal rendering of v (what `text` shows for an Int)
//     str_money(cents: i64) -> i32                  "$12.34"
//     str_chars(s: i32, dst: i32, max: i32) -> i32  writes the code points of s as i64 slots at dst, returns the count
//     str_from_chars(ptr: i32, len: i32) -> i32     the string of the i64 code points at ptr
//
//   Capability operations (one import per operation and argument shape: put$0, put$1, post$0, emit$0, fresh$0 ...).
//   The first parameter is a handle id (an index into AbiDescriptor.handles); the rest are the leaves of the
//   operation's arguments in order, with every Int widened to i64 (a list is its (ptr, len) pair into memory).
//     put$k(h, key..., value...) -> i32             1 when the store accepted the write, 0 when it failed
//     post$k(h, payload...) -> i32                  1 when sent, 0 on failure
//     emit$k(h, event...) -> i32                    1 when recorded (the compiled code ignores it)
//     fresh$k(h) -> i64                             a fresh value in 0..9007199254740991
//   Each effect import's AbiDescriptor.effects entry lists the shapes of its arguments, so the host can rebuild the
//   interpreter's values (records, strings, lists) and call Host.call(handle, op, args), producing the same log.

import { Host, Val, moneyStr } from '../interp.js';
import { AbiDescriptor } from './compile.js';
import { Raw, StrTable, liftVal } from './marshal.js';
import { SLOT } from './shape.js';

export const EMPTY_ABI: AbiDescriptor = { version: 1, strings: [], handles: [], effects: [] };

export function readAbi(mod: WebAssembly.Module): AbiDescriptor {
  const secs = WebAssembly.Module.customSections(mod, 'sigil.abi');
  if (!secs.length) return EMPTY_ABI;
  return JSON.parse(new TextDecoder().decode(secs[0])) as AbiDescriptor;
}

export class WasmHost {
  strings: StrTable;
  memory?: WebAssembly.Memory;
  constructor(
    public abi: AbiDescriptor,
    public host: Host,
  ) {
    this.strings = new StrTable(abi.strings);
  }

  /** The import object for `mod`. */
  imports(mod: WebAssembly.Module): WebAssembly.Imports {
    const fns: Record<string, (...a: never[]) => unknown> = {};
    for (const im of WebAssembly.Module.imports(mod)) {
      if (im.module !== 'host' || im.kind !== 'function') throw new Error(`unexpected import ${im.module}.${im.name}`);
      fns[im.name] = this.impl(im.name);
    }
    return { host: fns };
  }

  private view(): DataView {
    if (!this.memory) throw new Error('host: the module has no memory');
    return new DataView(this.memory.buffer);
  }

  private impl(name: string): (...a: never[]) => unknown {
    const S = this.strings;
    const f = (g: (...a: any[]) => unknown) => g as (...a: never[]) => unknown;
    switch (name) {
      case 'str_eq':
        return f((a: number, b: number) => (S.get(a) === S.get(b) ? 1 : 0));
      case 'str_concat':
        return f((a: number, b: number) => S.intern(S.get(a) + S.get(b)));
      case 'str_int':
        return f((v: bigint) => S.intern(v.toString()));
      case 'str_money':
        return f((v: bigint) => S.intern(moneyStr(v)));
      case 'str_chars':
        return f((h: number, dst: number, max: number) => {
          const cps = Array.from(S.get(h)).map((c) => c.codePointAt(0)!);
          if (cps.length > max) throw new RangeError(`chars: string of ${cps.length} characters exceeds its declared :max ${max}`);
          const v = this.view();
          cps.forEach((cp, i) => v.setBigInt64(dst + i * SLOT, BigInt(cp), true));
          return cps.length;
        });
      case 'str_from_chars':
        return f((ptr: number, len: number) => {
          const v = this.view();
          let s = '';
          for (let i = 0; i < len; i++) {
            const n = v.getBigInt64(ptr + i * SLOT, true);
            if (n < 0n || n > 1114111n) throw new RangeError(`from-chars: ${n} is not a code point`);
            s += String.fromCodePoint(Number(n));
          }
          return S.intern(s);
        });
    }
    const eff = this.abi.effects.find((e) => e.import === name);
    if (!eff) throw new Error(`host: unknown import ${name}`);
    return f((hid: number, ...raws: Raw[]) => {
      const handle = this.abi.handles[hid];
      if (handle === undefined) throw new Error(`host: invalid capability handle id ${hid}`);
      const pos = { i: 0 };
      const args: Val[] = eff.args.map((sh) => liftVal(sh, raws, pos, { memory: this.memory, strings: this.strings }));
      const r = this.host.call(handle, eff.op, args);
      if (eff.op === 'fresh') return r as bigint;
      return r && typeof r === 'object' && !Array.isArray(r) && r.$ === 'err' ? 0 : 1;
    });
  }
}
