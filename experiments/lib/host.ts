// TypeScript-arm host: the same mock semantics as the reference interpreter's Host (src/interp.ts).
//   - every call is observed; a call whose "handle op" is in `fail` has no effect and reports failure
//   - effects counted for scoring are the SUCCESSFUL ones: put -> stored value, post -> sent payload, emit -> emitted event
//   - rand.fresh uses the interpreter's seeded PRNG, so both languages see the same sequence for a seed
// The interface is async (like real I/O). Effects are recorded synchronously at call time.

import { mulberry32 } from '../../src/interp.js';
import { Json, toJson } from './json.js';

export interface HostConfig {
  store?: Record<string, Record<string, Json>>;
  fail?: { handle: string; op: string }[];
  seed?: number;
}

export interface Effects {
  stored: Json[];
  sent: Json[];
  emitted: Json[];
  /** TypeScript arm only: attempts to reach the network or start a process outside the host object (see ts-worker.mjs). */
  egress?: string[];
}

export interface Host {
  store: {
    put(handle: string, key: string | number, value: unknown): Promise<{ ok: boolean }>;
    get(handle: string, key: string | number): Promise<{ ok: true; value: unknown | null } | { ok: false }>;
  };
  net: { post(handle: string, payload: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
  rand: { fresh(handle: string): Promise<number> };
}

export function makeHost(cfg: HostConfig = {}): { host: Host; effects: () => Effects } {
  const failing = new Set((cfg.fail ?? []).map((f) => `${f.handle}.${f.op}`));
  const rnd = mulberry32(cfg.seed ?? 1);
  const seeded = cfg.store ?? {};
  const eff: Effects = { stored: [], sent: [], emitted: [] };
  const fails = (h: string, op: string) => failing.has(`${h}.${op}`);
  const host: Host = {
    store: {
      async put(h, _key, value) {
        const v = toJson(value, `put(${h}).value`);
        if (fails(h, 'put')) return { ok: false };
        eff.stored.push(v);
        return { ok: true };
      },
      async get(h, key) {
        if (fails(h, 'get')) return { ok: false };
        const v = seeded[h]?.[String(key)];
        return { ok: true, value: v === undefined ? null : v };
      },
    },
    net: {
      async post(h, payload) {
        const v = toJson(payload, `post(${h}).payload`);
        if (fails(h, 'post')) return { ok: false };
        eff.sent.push(v);
        return { ok: true };
      },
    },
    audit: {
      async emit(h, event) {
        const v = toJson(event, `emit(${h}).event`);
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
