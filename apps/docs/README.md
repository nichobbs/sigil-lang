# Docs: a Sigil app end to end

The B1 document service (authorise, refuse, store, audit) as a running app, in Node and in the browser, with the **same Sigil program**.

```
apps/docs/
  sigil/        human + agent layers: intent.feature, glossary.sigil, policy.sigil, app.sigil (verify with: npm run sigil -- verify apps/docs/sigil)
  src/engine.ts      trusted shell: load, decide, store (Sigil has no read; the shell loads the document, the program decides and requests put/emit)
  src/adapters.ts    synchronous adapters: memory, Web Storage (browser)      src/sqlite.ts: node:sqlite (Node)
  src/routes.ts      human-owned: route table and DocError -> HTTP status (exhaustively tested)
  src/http.ts        transport-agnostic (method, path, headers, body) -> (status, body); used by the Node server, the browser local backend and the tests
  src/server.ts      Node HTTP server over SQLite, also serves the UI
  src/render.ts      trusted renderer with a closed vocabulary; program strings only ever reach textContent
  src/browser.ts     UI; ?backend=remote talks to the server, default runs the engine in the page over localStorage
  test/              adapter conformance suite (3 adapters), engine, HTTP mapping, differential memory vs SQLite vs real server, Playwright e2e
```

Run: `npm run docs:build && npm run docs:serve` (http://localhost:8787, add `?backend=remote` for the server backend). Tests: `npx vitest run apps` and `npm run docs:e2e` (Chromium).

## What is demonstrated

- The business rules live only in `app.sigil`; they are verified (examples, 7 properties, privacy flow) and have no copy in the shell.
- The UI gating comes from the program's `doc-view` function (`can-update`, `can-delete`, `can-publish`), not from JavaScript rules.
- The title (personal data) never reaches the audit log: proved by the checker and re-checked end to end (the e2e asserts the audit log holds no title text).
- Local and remote backends produce identical observable state at every step.

## Known limits

- Execution is the reference interpreter. Its Host is synchronous, so only synchronous adapters work (memory, SQLite via node:sqlite, localStorage). Async stores need effect batching or a CPS interpreter.
- Authentication is out of scope: the actor arrives in `x-actor-id` and `x-actor-role` headers.
- Documents are seeded; creating a document is not a program operation yet.
- The Wasm backend does not compile this program's entry point (see the Wasm work on branch `wasm/language-gaps`).
