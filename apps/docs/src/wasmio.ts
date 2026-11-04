// (De)serialisation of the compiler's per-function reports. The .wasm file carries the host ABI (custom section) but not the
// parameter and result shapes the caller needs to marshal arguments, so the build writes them next to it as JSON.
// bigints (declared Int ranges) are tagged so the round trip is exact.
import type { FnReport } from '../../../src/wasm/compile.js';

export function reportsToJson(fns: FnReport[], names: string[]): string {
  const keep = fns.filter((f) => names.includes(f.name));
  return JSON.stringify(keep, (_k, v) => (typeof v === 'bigint' ? { $big: v.toString() } : v));
}

export function reportsFromJson(json: string): Map<string, FnReport> {
  const xs = JSON.parse(json, (_k, v) => (v && typeof v === 'object' && '$big' in v ? BigInt((v as { $big: string }).$big) : v)) as FnReport[];
  return new Map(xs.map((f) => [f.name, f]));
}
