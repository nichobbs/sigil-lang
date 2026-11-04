// node:sqlite adapters (Node only; kept out of adapters.ts so the browser bundle never imports it).
import { createRequire } from 'node:module';
import type { DatabaseSync as Db } from 'node:sqlite';
import type { AuditLog, DocStore, Json } from './adapters.js';

// Loaded through require: bundlers and vite do not know node:sqlite as a builtin yet.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = Db;

export function openDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)');
  return db;
}

export class SqliteDocStore implements DocStore {
  failing = false;
  constructor(private db: DatabaseSync) {}
  get(id: number): Json | null {
    const row = this.db.prepare('SELECT body FROM docs WHERE id = ?').get(id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Json) : null;
  }
  put(id: number, value: Json): boolean {
    if (this.failing) return false;
    try {
      this.db.prepare('INSERT INTO docs (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(id, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }
}

export class SqliteAuditLog implements AuditLog {
  constructor(private db: DatabaseSync) {}
  emit(event: Json): void {
    this.db.prepare('INSERT INTO audit (body) VALUES (?)').run(JSON.stringify(event));
  }
  all(): Json[] {
    return (this.db.prepare('SELECT body FROM audit ORDER BY seq').all() as { body: string }[]).map((r) => JSON.parse(r.body) as Json);
  }
}
