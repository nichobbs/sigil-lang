// C2 sales report: reference implementation (TypeScript).
// Self-contained on purpose: the harness loads this file alone.

type Region = 'North' | 'South' | 'East' | 'West';
type Scope = 'AllRegions' | 'OnlyNorth' | 'OnlySouth' | 'OnlyEast' | 'OnlyWest';
interface Sale {
  region: Region;
  product: number;
  qty: number;
  unit: number;
  refunded: boolean;
}
interface Args {
  sales: Sale[];
  scope: Scope;
}

const SCOPE_REGION: Record<Scope, Region | null> = {
  AllRegions: null,
  OnlyNorth: 'North',
  OnlySouth: 'South',
  OnlyEast: 'East',
  OnlyWest: 'West',
};

export default function run({ sales, scope }: Args) {
  const only = SCOPE_REGION[scope];
  const counted = sales.filter((s) => !s.refunded && (only === null || s.region === only));

  const byRegion: Record<Region, number> = { North: 0, South: 0, East: 0, West: 0 };
  const byProduct = new Map<number, number>();
  let total = 0;
  for (const s of counted) {
    const v = s.qty * s.unit;
    total += v;
    byRegion[s.region] += v;
    byProduct.set(s.product, (byProduct.get(s.product) ?? 0) + v);
  }

  let best = -1;
  let bestRev = -1;
  for (const [code, rev] of byProduct) {
    if (rev > bestRev || (rev === bestRev && code < best)) {
      best = code;
      bestRev = rev;
    }
  }

  const n = counted.length;
  const average = n === 0 ? 0 : Math.floor((2 * total + n) / (2 * n));
  return {
    total,
    north: byRegion.North,
    south: byRegion.South,
    east: byRegion.East,
    west: byRegion.West,
    count: n,
    best,
    average,
  };
}
