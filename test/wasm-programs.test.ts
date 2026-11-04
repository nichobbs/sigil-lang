// Stage 4: whole programs. The entry point of each reference app (experiments/tasks/*/ref/sigil/app.sigil) compiles
// to an exported Wasm function, and running it on random inputs with injected capability failures agrees with the
// reference interpreter on the result and on the complete effect log.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Val, enumVal } from '../src/interp.js';
import { parsePolicy, parseProgram } from '../src/parse.js';
import { check } from '../src/check.js';
import { compileProgram } from '../src/wasm/compile.js';
import { instantiate } from '../src/wasm/abi.js';
import { differentialEffects } from './helpers/wasm-effects.js';

const root = new URL('../experiments/tasks/', import.meta.url).pathname;
const TASKS = ['A1-tiered-pricing', 'A2-ledger-postings', 'A3-rate-limiter', 'A4-authorised-transfer', 'B1-document-service', 'B2-notification-sender', 'B3-audited-refund', 'B4-record-import', 'C2-sales-report', 'C3-catalogue-search', 'C4-schedule-conflicts'];

function load(task: string) {
  const prog = parseProgram(readFileSync(join(root, task, 'ref/sigil/app.sigil'), 'utf8'));
  const polFile = join(root, task, 'visible/policy.sigil');
  const res = check(prog, parsePolicy(existsSync(polFile) ? readFileSync(polFile, 'utf8') : '(policy)'));
  return { prog, res, out: compileProgram(prog, res) };
}

// What each entry must be seen to do across the random runs (so the agreement is not vacuous).
const EXPECT_OUTCOMES: Record<string, string[]> = {
  'A1-tiered-pricing': ['ok', 'err NeedsApproval', 'err StoreFailed'],
  'A2-ledger-postings': ['ok', 'err AcctFrozen', 'err Insufficient'],
  'A3-rate-limiter': ['ok', 'err Rejection{reason: TooLarge, retryAfter: 0}'],
  'A4-authorised-transfer': ['ok', 'err NotAllowed', 'err StoreFailed'],
  'B1-document-service': ['ok', 'err NotAllowed', 'err Gone'],
  'B3-audited-refund': ['ok', 'err ExceedsRemaining', 'err StoreFailed'],
  'C4-schedule-conflicts': ['ok'],
};
const EXPECT_OPS: Record<string, string[]> = {
  'A1-tiered-pricing': ['store:quotes.put', 'audit.emit', 'audit.emit (failed)'],
  'B2-notification-sender': ['net:email.post', 'net:sms.post', 'audit.emit', 'net:email.post (failed)'],
  'B4-record-import': ['store:records.put', 'audit.emit'],
  'A3-rate-limiter': ['store:limits.put', 'audit.emit'],
};

// Domain-shaped inputs for the entries whose random wide inputs mostly land on one refusal path.
type Rnd = () => number;
const ri = (r: Rnd, lo: number, hi: number) => BigInt(lo + Math.floor(r() * (hi - lo + 1)));
const pick = <T,>(r: Rnd, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const rec = (type: string, fields: Record<string, Val>): Val => ({ $: 'rec', type, fields });
const NOTES = ['', 'ok', 'a note', 'ünï'];

const TARGETED: Record<string, { args: (r: Rnd) => Val[]; outcomes?: string[]; ops?: string[] }> = {
  'B4-record-import': {
    args: (r) => {
      const bad = () => r() < 0.12;
      const n = Number(ri(r, 1, 20));
      const records = Array.from({ length: n }, () =>
        rec('Raw', {
          id: bad() ? ri(r, -5, 0) : ri(r, 1, 25),
          quantity: bad() ? ri(r, -3, 0) : ri(r, 1, 1000),
          unitPrice: bad() ? ri(r, -3, 0) : ri(r, 1, 10000000),
          category: bad() ? ri(r, 10, 12) : ri(r, 0, 9),
          note: pick(r, NOTES),
        }),
      );
      const imported = Array.from({ length: Number(ri(r, 0, 12)) }, () => ri(r, 1, 25));
      return [records, imported];
    },
    ops: ['store:records.put', 'store:records.put (failed)', 'audit.emit'],
  },
  'C4-schedule-conflicts': {
    args: (r) => {
      const existing = Array.from({ length: Number(ri(r, 0, 12)) }, (_, i) => {
        const s = Number(ri(r, 0, 2000));
        return rec('Booking', { id: BigInt(i + 1), start: BigInt(s), end: BigInt(s + Number(ri(r, 1, 300))), status: enumVal(pick(r, ['Tentative', 'Confirmed'])) });
      });
      const s = Number(ri(r, 0, 2000));
      return [existing, ri(r, 500, 900), BigInt(s), BigInt(Math.max(0, s + Number(ri(r, -40, 400)))), ri(r, 0, 30), enumVal(pick(r, ['Staff', 'Manager']))];
    },
    outcomes: ['ok', 'err Refusal{reason: BadRange, blocker: 0}', 'err Refusal{reason: StoreFailed, blocker: 0}'],
    ops: ['store:bookings.put', 'audit.emit'],
  },
  'C3-catalogue-search': {
    args: (r) => {
      const items = Array.from({ length: Number(ri(r, 0, 100)) }, (_, i) =>
        rec('Item', { id: BigInt(i * 3 + Number(ri(r, 0, 2))), category: enumVal(pick(r, ['Books', 'Games', 'Garden', 'Kitchen', 'Toys'])), price: ri(r, 0, 500), rating: ri(r, 0, 50), stock: ri(r, 0, 3), hidden: r() < 0.15, title: pick(r, NOTES) }),
      );
      const lo = Number(ri(r, 0, 200));
      const query = rec('Query', {
        anyCategory: r() < 0.5, category: enumVal(pick(r, ['Books', 'Games', 'Garden', 'Kitchen', 'Toys'])), minPrice: BigInt(lo), maxPrice: BigInt(lo + Number(ri(r, 0, 400))),
        minRating: ri(r, 0, 30), inStockOnly: r() < 0.4, order: enumVal(pick(r, ['PriceAsc', 'PriceDesc', 'RatingDesc'])), pageSize: ri(r, 1, 20), page: ri(r, 0, 5),
      });
      return [items, query];
    },
  },
  'C2-sales-report': {
    args: (r) => [
      Array.from({ length: Number(ri(r, 0, 200)) }, () =>
        rec('Sale', { region: enumVal(pick(r, ['North', 'South', 'East', 'West'])), product: ri(r, 0, 49), qty: ri(r, 1, 1000), unit: ri(r, 1, 1000000), refunded: r() < 0.2 }),
      ),
      enumVal(pick(r, ['AllRegions', 'OnlyNorth', 'OnlySouth', 'OnlyEast', 'OnlyWest'])),
    ],
  },
};

describe('wasm programs: domain-shaped inputs for the entries that wide random inputs barely exercise', () => {
  for (const [task, t] of Object.entries(TARGETED)) {
    it(`${task}: result and effect log agree on 250 domain-shaped runs`, async () => {
      const { prog, out } = load(task);
      const entry = prog.entries[0];
      const d = await differentialEffects(prog, out, entry, { n: 250, seed: 99, args: (r) => t.args(r) });
      expect(d.mismatches.slice(0, 5)).toEqual([]);
      for (const o of t.outcomes ?? []) expect(d.outcomes.get(o) ?? 0, `outcome ${o} in ${JSON.stringify([...d.outcomes]).slice(0, 600)}`).toBeGreaterThan(0);
      for (const o of t.ops ?? []) expect(d.ops.get(o) ?? 0, `op ${o} in ${JSON.stringify([...d.ops])}`).toBeGreaterThan(0);
      if (!t.ops) expect(new Set(d.outcomes.keys()).size).toBe(1); // pure entries return plain values
    });
  }
});

describe('wasm programs: reference apps compile whole and agree with the interpreter', () => {
  for (const task of TASKS) {
    describe(task, () => {
      const { prog, out } = load(task);
      const entry = prog.entries[0];

      it('every function and the program entry point compile', () => {
        for (const f of out.fns) expect(f.compilable, `${f.name}: ${f.reason}`).toBe(true);
        expect(out.entries).toEqual([...new Set(prog.entries)]);
        expect(out.fns.find((f) => f.name === entry)!.entry).toBe(true);
        expect(WebAssembly.validate(new Uint8Array(out.bytes))).toBe(true);
      });

      it('the entry is exported and the module runs under the host adapter', async () => {
        const ex = await instantiate(out.bytes);
        expect(typeof ex[entry]).toBe('function');
      });

      it(`entry ${entry}: result and effect log agree on 250 random runs with injected failures`, async () => {
        const d = await differentialEffects(prog, out, entry, { n: 250, seed: 20260701 });
        expect(d.mismatches.slice(0, 5)).toEqual([]);
        expect(d.runs).toBe(250);
        for (const o of EXPECT_OUTCOMES[task] ?? []) expect(d.outcomes.get(o) ?? 0, `outcome ${o} in ${JSON.stringify([...d.outcomes])}`).toBeGreaterThan(0);
        for (const o of EXPECT_OPS[task] ?? []) expect(d.ops.get(o) ?? 0, `op ${o} in ${JSON.stringify([...d.ops])}`).toBeGreaterThan(0);
        expect([...d.outcomes.keys()].length).toBeGreaterThan(0);
      });
    });
  }
});
