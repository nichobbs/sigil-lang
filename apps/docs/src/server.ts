// Node HTTP server: one engine over SQLite. Serves the browser UI at / (remote backend mode) and the JSON API.
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DocsEngine, seed } from './engine.js';
import { reportsFromJson } from './wasmio.js';
import { handle } from './http.js';
import { SqliteAuditLog, SqliteDocStore, openDb } from './sqlite.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const APP_SOURCE = readFileSync(`${HERE}../sigil/app.sigil`, 'utf8');

export async function makeServer(opts: { dbPath?: string; webDir?: string; wasm?: boolean } = {}): Promise<{ server: Server; engine: DocsEngine; store: SqliteDocStore }> {
  const db = openDb(opts.dbPath);
  const store = new SqliteDocStore(db);
  seed(store);
  const audit = new SqliteAuditLog(db);
  const web = opts.webDir ?? `${HERE}../web`;
  const engine = opts.wasm
    ? await DocsEngine.withWasm(APP_SOURCE, store, audit, readFileSync(`${web}/app.wasm`), reportsFromJson(readFileSync(`${web}/app.reports.json`, 'utf8')))
    : new DocsEngine(APP_SOURCE, store, audit);
  const server = createServer((rq, rs) => {
    const chunks: Buffer[] = [];
    rq.on('data', (c: Buffer) => chunks.push(c));
    rq.on('end', () => {
      const path = (rq.url ?? '/').split('?')[0];
      const STATIC: Record<string, [string, string]> = {
        '/': ['index.html', 'text/html'],
        '/index.html': ['index.html', 'text/html'],
        '/app.js': ['app.js', 'text/javascript'],
        '/app.wasm': ['app.wasm', 'application/wasm'],
        '/app.reports.json': ['app.reports.json', 'application/json'],
      };
      if (rq.method === 'GET' && STATIC[path]) {
        const f = `${web}/${STATIC[path][0]}`;
        if (!existsSync(f)) { rs.writeHead(404).end('UI not built: run npm run docs:build'); return; }
        rs.writeHead(200, { 'content-type': STATIC[path][1] }).end(readFileSync(f));
        return;
      }
      let body: unknown;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined; } catch { rs.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad json"}'); return; }
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(rq.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
      const res = handle(engine, { method: rq.method ?? 'GET', path, headers, body: body as never });
      rs.writeHead(res.status, { 'content-type': 'application/json' }).end(JSON.stringify(res.body));
    });
  });
  return { server, engine, store };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server, engine } = await makeServer({ dbPath: process.env.DOCS_DB, wasm: process.env.DOCS_ENGINE === 'wasm' });
  const port = Number(process.env.PORT ?? 8787);
  server.listen(port, () => console.log(`docs app on http://localhost:${port} (engine: ${engine.mode})`));
}
