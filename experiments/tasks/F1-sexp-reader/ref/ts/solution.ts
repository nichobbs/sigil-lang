// F1 s-expression reader: reference implementation (TypeScript).
type Kind = 'Atom' | 'Text' | 'Form';
interface Node { kind: Kind; start: number; end: number; parent: number; arity: number }
const MAX_NODES = 60;
const WS = new Set([' ', '\t', '\n']);

export default async function run(args: { src: string }) {
  const cs = Array.from(args.src);
  const nodes: Node[] = [];
  // Open forms: start offset and the indexes of completed children.
  const open: { start: number; kids: number[] }[] = [];
  let top = 0; // completed top-level forms
  const done = (n: Omit<Node, 'parent'>): string | null => {
    if (nodes.length >= MAX_NODES) return 'TooBig';
    const idx = nodes.length;
    nodes.push({ ...n, parent: -1 });
    if (open.length > 0) open[open.length - 1].kids.push(idx);
    else top += 1;
    return null;
  };
  let i = 0;
  while (i < cs.length) {
    const c = cs[i];
    if (WS.has(c)) { i += 1; continue; }
    if (c === ';') { while (i < cs.length && cs[i] !== '\n') i += 1; continue; }
    const startsForm = c !== ')';
    if (startsForm && open.length === 0 && top >= 1) return { err: 'Trailing' };
    if (c === '(') { open.push({ start: i, kids: [] }); i += 1; continue; }
    if (c === ')') {
      const f = open.pop();
      if (!f) return { err: 'Stray' };
      const e = done({ kind: 'Form', start: f.start, end: i + 1, arity: f.kids.length });
      if (e) return { err: e };
      const idx = nodes.length - 1;
      for (const k of f.kids) nodes[k].parent = idx;
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < cs.length && cs[j] !== '"') j += 1;
      if (j >= cs.length) return { err: 'UnterminatedText' };
      const e = done({ kind: 'Text', start: i, end: j + 1, arity: 0 });
      if (e) return { err: e };
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < cs.length && !WS.has(cs[j]) && cs[j] !== '(' && cs[j] !== ')' && cs[j] !== ';' && cs[j] !== '"') j += 1;
    const e = done({ kind: 'Atom', start: i, end: j, arity: 0 });
    if (e) return { err: e };
    i = j;
  }
  if (open.length > 0) return { err: 'Unclosed' };
  if (top === 0) return { err: 'Empty' };
  // A top-level atom or text has no parent; a form's children were patched at close.
  return { ok: nodes };
}
