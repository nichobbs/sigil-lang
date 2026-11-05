// Human-owned: `run` must accept exactly the RefundArgs of types.ts (no re-declared looser argument type).
import type { Host } from './host';
import type { RefundArgs } from './types';
import run from './solution';

export const guard: (args: RefundArgs, host: Host) => Promise<unknown> = run;
export const guardReverse: Parameters<typeof run>[0] extends RefundArgs ? (RefundArgs extends Parameters<typeof run>[0] ? true : never) : never = true;
