// Shared adapter conformance suite: every DocStore/AuditLog implementation must pass it.
import { describe, expect, it } from 'vitest';
import type { AuditLog, DocStore } from '../src/adapters.js';

export function conformance(name: string, make: () => { store: DocStore; audit: AuditLog; breakStore: () => void }): void {
  describe(`adapter conformance: ${name}`, () => {
    it('get of a missing id is null', () => {
      expect(make().store.get(42)).toBeNull();
    });
    it('put then get round-trips JSON, including unicode and large ids', () => {
      const { store } = make();
      const d = { id: 9007199254740991, owner: 1, title: 'plan é中 "q" \n', size: 3, status: 'Draft' };
      expect(store.put(d.id, d)).toBe(true);
      expect(store.get(d.id)).toEqual(d);
    });
    it('put replaces', () => {
      const { store } = make();
      store.put(1, { a: 1 });
      store.put(1, { a: 2 });
      expect(store.get(1)).toEqual({ a: 2 });
    });
    it('a failing store reports false and keeps the old value', () => {
      const { store, breakStore } = make();
      store.put(1, { a: 1 });
      breakStore();
      expect(store.put(1, { a: 2 })).toBe(false);
      expect(store.get(1)).toEqual({ a: 1 });
    });
    it('audit keeps order and content', () => {
      const { audit } = make();
      audit.emit({ n: 1 });
      audit.emit({ n: 2, s: 'x' });
      expect(audit.all()).toEqual([{ n: 1 }, { n: 2, s: 'x' }]);
    });
  });
}
