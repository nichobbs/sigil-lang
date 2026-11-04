import { describe, expect, it } from 'vitest';
import { Host, Interp, RuntimeFault } from '../src/interp.js';
import { parseProgram } from '../src/parse.js';

describe('record construction arity at run time', () => {
  const prog = parseProgram(`(type Evt (rec (a (Int 0 9)) (b (Int 0 9))))
(fn mk (in (x (Int 0 9))) (out Evt) (Evt x))`);

  it('reports a clear RuntimeFault (not a TypeError) when a record is built with too few arguments', () => {
    const it = new Interp(prog, new Host(1));
    expect(() => it.callFn('mk', [1n])).toThrow(RuntimeFault);
    expect(() => it.callFn('mk', [1n])).toThrow(/Evt has 2 field\(s\) \(a, b\) but is built with 1 argument/);
  });
});
