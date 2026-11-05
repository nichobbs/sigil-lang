// F2 Wasm emitter: reference implementation (TypeScript).
interface ENode { op: string; val: number }

const uleb = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b += 128;
    out.push(b);
  } while (v > 0);
  return out;
};
const sleb = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = ((v % 128) + 128) % 128;
    v = Math.floor(v / 128);
    const signBit = (b & 0x40) !== 0;
    if ((v === 0 && !signBit) || (v === -1 && signBit)) { out.push(b); return out; }
    out.push(b + 128);
  }
};
const OPS: Record<string, number> = { Add: 0x7c, Sub: 0x7d, Mul: 0x7e };

export default async function run(args: { nodes: ENode[] }) {
  let depth = 0;
  const body: number[] = [];
  for (const n of args.nodes) {
    if (n.op === 'Const') { body.push(0x42, ...sleb(n.val)); depth += 1; }
    else if (n.op === 'Param0') { body.push(0x20, 0x00); depth += 1; }
    else if (n.op === 'Param1') { body.push(0x20, 0x01); depth += 1; }
    else {
      if (depth < 2) return { err: 'StackUnderflow' };
      body.push(OPS[n.op]);
      depth -= 1;
    }
  }
  if (depth !== 1) return { err: 'BadShape' };
  const code = [0x00, ...body, 0x0b]; // no locals, then the instructions, then end
  const section = (id: number, payload: number[]) => [id, ...uleb(payload.length), ...payload];
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [0x01, 0x60, 0x02, 0x7e, 0x7e, 0x01, 0x7e]),
    ...section(3, [0x01, 0x00]),
    ...section(7, [0x01, 0x01, 0x66, 0x00, 0x00]),
    ...section(10, [0x01, ...uleb(code.length), ...code]),
  ];
  return { ok: bytes };
}
