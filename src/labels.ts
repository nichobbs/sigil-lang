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
  // If the same source arrives by two paths, keep the one that did NOT pass a declassifier: the
  // undeclassified path is the stronger claim and must not be hidden by a declassified one.
  for (const [k, v] of b.srcs) {
    const cur = srcs.get(k);
    if (!cur || (isVia(cur) && !isVia(v))) srcs.set(k, v);
  }
  return { conf: confMax(a.conf, b.conf), integ: integMin(a.integ, b.integ), srcs };
}

export function joinAll(ls: Label[]): Label {
  return ls.reduce(join, bottom());
}

const DECL = 'declassify ';
const isDeclStep = (h: string) => h.startsWith(DECL);
/** Did this provenance path pass through a declassifier? */
export const isVia = (path: string[]) => path.some(isDeclStep);
/** Names of the declassifiers on a provenance path, in order. */
export const viaNames = (path: string[]): string[] => path.filter(isDeclStep).map((h) => h.slice(DECL.length).split(' ')[0]);

/** Keep paths readable (8 hops) but never drop a declassify step: that is the audit-relevant part. */
function bound(path: string[]): string[] {
  const out = [...path];
  for (let i = 0; out.length > 8 && i < out.length; ) {
    if (isDeclStep(out[i])) i++;
    else out.splice(i, 1);
  }
  return out;
}

/** Record a hop on every provenance path (bounded, to keep counterexamples readable). */
export function step(l: Label, hop: string): Label {
  const srcs = new Map<string, string[]>();
  for (const [k, path] of l.srcs) {
    const last = path[path.length - 1];
    srcs.set(k, last === hop ? path : bound([...path, hop]));
  }
  return { ...l, srcs };
}

export function sourceLabel(src: string, conf: Conf, integ: Integ, at: string): Label {
  return { conf, integ, srcs: conf === 'public' ? new Map() : new Map([[src, [at]]]) };
}

export function withIntegrity(l: Label, integ: Integ): Label {
  return { ...l, integ };
}

/**
 * Apply a declassifier: confidentiality above `to` becomes `to` (never raised); integrity is untouched.
 * `lowered(src)` says whether a provenance source actually needed the release, so that sources that were
 * already at or below `to` are not reported as passing through the declassifier.
 */
export function declassifyLabel(l: Label, to: Conf, name: string, from: Conf, lowered: (src: string) => boolean): Label {
  const hop = `${DECL}${name} (${from} -> ${to})`;
  const srcs = new Map<string, string[]>();
  for (const [k, path] of l.srcs) srcs.set(k, lowered(k) && path[path.length - 1] !== hop ? bound([...path, hop]) : path);
  return { conf: confRank(l.conf) > confRank(to) ? to : l.conf, integ: l.integ, srcs };
}
