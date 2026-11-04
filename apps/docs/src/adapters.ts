// Synchronous host adapters. The interpreter's Host.call is synchronous, so every adapter here is too:
// in-memory, node:sqlite (Node) and Web Storage (browser). All three pass the same conformance suite.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface DocStore {
  get(id: number): Json | null;
  /** Returns false when the store is unavailable; nothing is stored then. */
  put(id: number, value: Json): boolean;
}

export interface AuditLog {
  emit(event: Json): void;
  all(): Json[];
}

export class MemoryDocStore implements DocStore {
  private m = new Map<number, string>();
  failing = false;
  get(id: number): Json | null {
    const s = this.m.get(id);
    return s === undefined ? null : (JSON.parse(s) as Json);
  }
  put(id: number, value: Json): boolean {
    if (this.failing) return false;
    this.m.set(id, JSON.stringify(value));
    return true;
  }
}

export class MemoryAuditLog implements AuditLog {
  private xs: string[] = [];
  emit(event: Json): void {
    this.xs.push(JSON.stringify(event));
  }
  all(): Json[] {
    return this.xs.map((s) => JSON.parse(s) as Json);
  }
}

/** The subset of Web Storage the browser adapters use (localStorage, or a fake in tests). */
export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export class WebDocStore implements DocStore {
  constructor(private kv: KV, private prefix = 'docs:') {}
  get(id: number): Json | null {
    const s = this.kv.getItem(this.prefix + id);
    return s === null ? null : (JSON.parse(s) as Json);
  }
  put(id: number, value: Json): boolean {
    try {
      this.kv.setItem(this.prefix + id, JSON.stringify(value));
      return true;
    } catch {
      return false; // quota exceeded or storage disabled
    }
  }
}

export class WebAuditLog implements AuditLog {
  constructor(private kv: KV, private key = 'audit') {}
  emit(event: Json): void {
    this.kv.setItem(this.key, JSON.stringify([...this.all(), event]));
  }
  all(): Json[] {
    const s = this.kv.getItem(this.key);
    return s === null ? [] : (JSON.parse(s) as Json[]);
  }
}
