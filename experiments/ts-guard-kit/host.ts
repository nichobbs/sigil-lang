// Mock host for tests in the TypeScript arm: same semantics as the scorer's host.
// makeHost({ fail: [{ handle: 'store:quotes', op: 'put' }], seed: 1 }) -> { host, effects }
// A call whose "handle.op" is in `fail` has no effect and reports failure. effects() lists the successful ones.

export interface HostConfig {
  store?: Record<string, Record<string, unknown>>;
  fail?: { handle: string; op: string }[];
  seed?: number;
}
export interface Effects {
  stored: unknown[];
  sent: unknown[];
  emitted: unknown[];
}
// Data-classification policy, enforced by the type checker (human-owned, like policy.sigil in the Sigil arm):
// a value typed Pii (see types.ts) cannot be passed to audit.emit or net.post. store.put accepts anything.
export interface PiiMarker {
  piiOnly(): never;
}
export type Pii = { readonly __pii: PiiMarker };
export type Public = string | number | boolean | null | readonly Public[] | { readonly [k: string]: Public };

export interface Host {
  store: {
    put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }>;
    get(handle: string, key: string | number): Promise<{ ok: true; value: unknown | null } | { ok: false }>;
  };
  net: { post(handle: string, payload: Public): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: Public): Promise<void> };
  rand: { fresh(handle: string): Promise<number> };
}

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeHost(cfg: HostConfig = {}): { host: Host; effects: () => Effects } {
  const failing = new Set((cfg.fail ?? []).map((f) => `${f.handle}.${f.op}`));
  const rnd = mulberry32(cfg.seed ?? 1);
  const seeded = cfg.store ?? {};
  const eff: Effects = { stored: [], sent: [], emitted: [] };
  const fails = (h: string, op: string) => failing.has(`${h}.${op}`);
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;
  const host: Host = {
    store: {
      async put(h, _k, value) {
        const v = plain(value);
        if (fails(h, 'put')) return { ok: false };
        eff.stored.push(v);
        return { ok: true };
      },
      async get(h, key) {
        if (fails(h, 'get')) return { ok: false };
        const v = (seeded[h] as Record<string, unknown> | undefined)?.[String(key)];
        return { ok: true, value: v === undefined ? null : v };
      },
    },
    net: {
      async post(h, payload) {
        const v = plain(payload);
        if (fails(h, 'post')) return { ok: false };
        eff.sent.push(v);
        return { ok: true };
      },
    },
    audit: {
      async emit(h, event) {
        const v = plain(event);
        if (fails(h, 'emit')) return;
        eff.emitted.push(v);
      },
    },
    rand: {
      async fresh(h) {
        if (fails(h, 'fresh')) throw new Error(`host: ${h}.fresh failed`);
        return Math.floor(rnd() * Number.MAX_SAFE_INTEGER);
      },
    },
  };
  return { host, effects: () => eff };
}
