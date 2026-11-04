// Information-flow labels: two axes (confidentiality, integrity) plus provenance.
// Provenance (srcs) maps each labelled source field to the shortest flow path seen so far;
// it is what turns a type error into a counterexample.

import { CONFS, Conf, INTEGS, Integ } from './ast.js';

export interface Label {
  conf: Conf;
  integ: Integ;
  srcs: Map<string, string[]>;
}

export const confRank = (c: Conf) => CONFS.indexOf(c);
export const integRank = (i: Integ) => INTEGS.indexOf(i);

export const confLE = (a: Conf, b: Conf) => confRank(a) <= confRank(b);
export const integGE = (a: Integ, b: Integ) => integRank(a) >= integRank(b);

export const confMax = (a: Conf, b: Conf): Conf => (confRank(a) >= confRank(b) ? a : b);
export const integMin = (a: Integ, b: Integ): Integ => (integRank(a) <= integRank(b) ? a : b);

export function bottom(): Label {
  return { conf: 'public', integ: 'trusted', srcs: new Map() };
}

/** Join: confidentiality rises, integrity falls, provenance unions (keeping the first path). */
export function join(a: Label, b: Label): Label {
  const srcs = new Map(a.srcs);
  for (const [k, v] of b.srcs) if (!srcs.has(k)) srcs.set(k, v);
  return { conf: confMax(a.conf, b.conf), integ: integMin(a.integ, b.integ), srcs };
}

export function joinAll(ls: Label[]): Label {
  return ls.reduce(join, bottom());
}

/** Record a hop on every provenance path (bounded, to keep counterexamples readable). */
export function step(l: Label, hop: string): Label {
  const srcs = new Map<string, string[]>();
  for (const [k, path] of l.srcs) {
    const last = path[path.length - 1];
    srcs.set(k, last === hop ? path : [...path, hop].slice(-8));
  }
  return { ...l, srcs };
}

export function sourceLabel(src: string, conf: Conf, integ: Integ, at: string): Label {
  return { conf, integ, srcs: conf === 'public' ? new Map() : new Map([[src, [at]]]) };
}

export function withIntegrity(l: Label, integ: Integ): Label {
  return { ...l, integ };
}
