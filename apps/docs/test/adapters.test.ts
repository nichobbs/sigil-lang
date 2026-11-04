import { conformance } from './conformance.js';
import { MemoryAuditLog, MemoryDocStore, WebAuditLog, WebDocStore, type KV } from '../src/adapters.js';
import { SqliteAuditLog, SqliteDocStore, openDb } from '../src/sqlite.js';

conformance('memory', () => {
  const store = new MemoryDocStore();
  return { store, audit: new MemoryAuditLog(), breakStore: () => (store.failing = true) };
});

conformance('sqlite', () => {
  const db = openDb();
  const store = new SqliteDocStore(db);
  return { store, audit: new SqliteAuditLog(db), breakStore: () => (store.failing = true) };
});

conformance('web storage', () => {
  const m = new Map<string, string>();
  let broken = false;
  const kv: KV = {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      if (broken) throw new Error('QuotaExceededError');
      m.set(k, v);
    },
  };
  return { store: new WebDocStore(kv), audit: new WebAuditLog(kv), breakStore: () => (broken = true) };
});
