// Capability kinds, their operations, and per-target availability.
// This is the "capability set is the portability layer" idea in miniature.

export interface CapOp {
  kind: string;
  arity: number; // including the handle argument
}

export const CAP_OPS: Record<string, CapOp> = {
  put: { kind: 'store', arity: 3 }, // (put handle key value) -> Result<Unit,_>
  get: { kind: 'store', arity: 2 },
  post: { kind: 'net', arity: 2 }, // (post handle payload) -> Result<Unit,_>
  emit: { kind: 'audit', arity: 2 }, // (emit handle event) -> Unit
  fresh: { kind: 'rand', arity: 1 }, // (fresh handle) -> Int
};

export const TARGETS = ['server', 'browser', 'native'] as const;

// Which targets provide which capability kinds.
export const KIND_TARGETS: Record<string, string[]> = {
  store: ['server', 'browser', 'native'],
  net: ['server', 'browser', 'native'],
  audit: ['server', 'browser', 'native'],
  rand: ['server', 'browser', 'native'],
  clock: ['server', 'browser', 'native'],
  fs: ['server', 'native'],
  gpu: ['browser', 'native'],
  device: ['native'],
};

export function kindOfHandle(handle: string): string {
  const i = handle.indexOf(':');
  return i < 0 ? handle : handle.slice(0, i);
}

// Arity of builtin functions. -1 = variadic (count is explicit in compact/prefix syntaxes).
export const BUILTIN_ARITY: Record<string, number> = {
  add: 2,
  sub: 2,
  mul: 2,
  'div-floor': 2,
  neg: 1,
  min: 2,
  max: 2,
  sum: 1,
  len: 1,
  map: 2,
  filter: 2,
  text: -1,
  list: -1,
  '=': 2,
  '<=': -1,
  '<': -1,
  '>=': -1,
  '>': -1,
  and: -1,
  or: -1,
  not: 1,
  ok: 1,
  err: 1,
};

// Query builtins available only to scenario glossaries (observations of the effect log).
export const WORLD_BUILTINS = ['sent', 'stored'];

export function isBuiltin(name: string): boolean {
  return name in BUILTIN_ARITY || name in CAP_OPS;
}
