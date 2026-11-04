// C3 catalogue search: reference implementation (TypeScript).
// Self-contained on purpose: the harness loads this file alone.

type Category = 'Books' | 'Games' | 'Garden' | 'Kitchen' | 'Toys';
type SortOrder = 'PriceAsc' | 'PriceDesc' | 'RatingDesc';
interface Item {
  id: number;
  category: Category;
  price: number;
  rating: number;
  stock: number;
  hidden: boolean;
  title: string;
}
interface Query {
  anyCategory: boolean;
  category: Category;
  minPrice: number;
  maxPrice: number;
  minRating: number;
  inStockOnly: boolean;
  order: SortOrder;
  pageSize: number;
  page: number;
}
interface Args {
  items: Item[];
  query: Query;
}

function matches(q: Query, i: Item): boolean {
  return (
    !i.hidden &&
    (q.anyCategory || i.category === q.category) &&
    i.price >= q.minPrice &&
    i.price <= q.maxPrice &&
    i.rating >= q.minRating &&
    (!q.inStockOnly || i.stock > 0)
  );
}

function compare(order: SortOrder, a: Item, b: Item): number {
  const byId = a.id - b.id; // ties are always broken by id ascending, in every order
  switch (order) {
    case 'PriceAsc':
      return a.price - b.price || byId;
    case 'PriceDesc':
      return b.price - a.price || byId;
    case 'RatingDesc':
      return b.rating - a.rating || byId;
  }
}

export default function run({ items, query }: Args) {
  const found = items.filter((i) => matches(query, i)).sort((a, b) => compare(query.order, a, b));
  const start = query.page * query.pageSize;
  return {
    ids: found.slice(start, start + query.pageSize).map((i) => i.id),
    total: found.length,
    hasMore: start + query.pageSize < found.length,
  };
}
