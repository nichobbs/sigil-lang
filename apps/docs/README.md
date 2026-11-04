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
  src/wasmio.ts      serialises the compiler's per-function reports (shapes for marshalling) next to app.wasm
  build-wasm.ts      check + compile to Wasm; writes web/app.wasm and web/app.reports.json
  src/browser.ts     UI; ?backend=remote talks to the server, default runs the engine in the page over localStorage
  test/              adapter conformance suite (3 adapters), engine, HTTP mapping, differential memory vs SQLite vs real server, wasm vs interpreter, Playwright e2e
```

Run: `npm run docs:build && npm run docs:serve` (http://localhost:8787). Query options: `?backend=remote` talks to the server, `?engine=wasm` runs the compiled module in the page. `npm run docs:serve:wasm` starts the server with the compiled module (`DOCS_ENGINE=wasm`). `docs:build` bundles the UI and compiles `app.sigil` to `web/app.wasm` plus `web/app.reports.json` (refuses unless the program checks clean and every function the shell calls compiles). Tests: `npx vitest run apps` and `npm run docs:e2e` (Chromium).

## What is demonstrated

- The business rules live only in `app.sigil`; they are verified (examples, 7 properties, privacy flow) and have no copy in the shell.
- The UI gating comes from the program's `doc-view` function (`can-update`, `can-delete`, `can-publish`), not from JavaScript rules.
- The title (personal data) never reaches the audit log: proved by the checker and re-checked end to end (the e2e asserts the audit log holds no title text).
- Local and remote backends produce identical observable state at every step.
- The same program runs as interpreted code and as compiled Wasm. The Wasm path calls the module through the host ABI: `put` and `emit` reach the same adapters (memory, SQLite, localStorage). Tests: 1200 random requests per run (outcomes, stored documents, audit logs, view models, injected store failures, out-of-range input) agree between the interpreter, Wasm over memory and Wasm over SQLite; the Playwright script gives identical DOM, messages and audit logs across local/remote x interpreter/wasm.

## Known limits

- Authentication is out of scope: the actor arrives in `x-actor-id` and `x-actor-role` headers.
- Documents are seeded; creating a document is not a program operation yet.
- The reference interpreter's Host is synchronous, and so is the Wasm host adapter, so only synchronous adapters work (memory, SQLite via node:sqlite, localStorage). Async stores need effect batching or a CPS interpreter.
- The compiled module validates its own arguments: every export checks each argument against its declared type before the unchecked body runs and fails with the interpreter's `ContractViolation` (same reason and place), so out-of-range input fails the same way on both backends even without the shell (tested by calling the module directly). The shell still validates every argument with `Interp.checkType` before calling either backend, as defence in depth. See "Trust model" in the top-level README for what is still trusted (the host's string table and effect results).
