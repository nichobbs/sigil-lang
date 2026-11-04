// Sigil runner: parse the program, decode JSON args with the entry function's declared parameter
// types, run on the reference interpreter with a mock Host, encode the result and the effect log back to JSON.

import { parseProgram } from '../../src/parse.js';
import { Host, Interp } from '../../src/interp.js';
import { Case, CaseFile, Outcome, Score, allFail, score } from './score.js';
import { Json, decodeVal, encodeVal } from './json.js';

export async function runSigil(cf: CaseFile, source: string): Promise<Score> {
  let prog;
  try {
    prog = parseProgram(source);
  } catch (e) {
    return allFail(cf, `parse error: ${(e as Error).message}`);
  }
  const fn = prog.fns.get(cf.entry);
  if (!fn) return allFail(cf, `entry function ${cf.entry} is not defined`);

  const exec = async (c: Case): Promise<Outcome> => {
    const seeded = Object.values(c.host?.store ?? {}).some((m) => Object.keys(m).length > 0);
    if (seeded) return { error: 'harness: seeded host.store is not supported by the Sigil interpreter (no readable get)' };
    const host = new Host(c.host?.seed ?? 1);
    for (const f of c.host?.fail ?? []) host.fail(f.handle, f.op);
    let args;
    try {
      // The task README fixes the parameter order; names are the agent's choice. Bind by name when every name matches,
      // otherwise by position (the case file lists arguments in README order).
      const byName = fn.params.every((p) => p.name in c.args);
      const given = Object.values(c.args);
      if (!byName && given.length !== fn.params.length) throw new Error(`entry takes ${fn.params.length} parameters, case has ${given.length}`);
      args = fn.params.map((p, i) => decodeVal(prog, p.type, byName ? c.args[p.name] : given[i], p.name));
    } catch (e) {
      return { error: `argument encoding: ${(e as Error).message}` };
    }
    let out;
    try {
      out = new Interp(prog, host).callFn(cf.entry, args);
    } catch (e) {
      return { error: `runtime: ${(e as Error).message}`.slice(0, 300) };
    }
    const ok = host.log.filter((o) => o.ok);
    const enc = (xs: unknown[]): Json[] => xs.map((x) => encodeVal(x as never));
    try {
      return {
        result: encodeVal(out),
        effects: {
          stored: enc(ok.filter((o) => o.op === 'put').map((o) => o.args[1])),
          sent: enc(ok.filter((o) => o.op === 'post').map((o) => o.args[0])),
          emitted: enc(ok.filter((o) => o.op === 'emit').map((o) => o.args[0])),
        },
      };
    } catch (e) {
      return { error: `result encoding: ${(e as Error).message}` };
    }
  };
  return score(cf, exec);
}
