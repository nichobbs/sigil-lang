// Browser end-to-end: drive the same script against the local (in-page, localStorage) and remote (Node + SQLite) backends in
// real Chromium and require identical observable state at every step. Run: npm run docs:e2e (needs `npm run docs:build`).
import { createRequire } from 'node:module';
import { makeServer } from '../src/server.js';

const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: any }; // playwright is preinstalled outside the repo; kept untyped on purpose

type Snap = { cards: string[]; buttons: string[]; message: string; audit: string };

async function drive(base: string, query: string): Promise<{ steps: Snap[]; xss: boolean; label: string }> {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}/${query}`);
  await page.waitForFunction(() => (document.getElementById('backend')!.textContent ?? '') !== '');
  const label = (await page.textContent('#backend')) ?? '';
  const snap = async (): Promise<Snap> => {
    await page.waitForFunction(() => document.body.dataset.busy === '0' && document.querySelectorAll('[data-doc]').length > 0);
    return page.evaluate(() => ({
      cards: [...document.querySelectorAll('[data-doc]')].map((c) => `${c.getAttribute('data-doc')}|${c.querySelector('[data-field=title]')!.textContent}|${c.querySelector('[data-field=status]')!.textContent}|${c.querySelector('[data-field=size]')!.textContent}`),
      buttons: [...document.querySelectorAll('[data-doc]')].map((c) => `${c.getAttribute('data-doc')}:` + [...c.querySelectorAll('button')].map((b) => b.textContent).join(',')),
      message: document.getElementById('message')!.textContent ?? '',
      audit: document.getElementById('audit')!.textContent ?? '',
    }));
  };
  const idle = () => page.waitForFunction(() => document.body.dataset.busy === '0');
  const as = async (id: number, role: string) => {
    await page.fill('#actor-id', String(id));
    await page.selectOption('#actor-role', role);
    await page.dispatchEvent('#actor-id', 'change');
    await idle();
  };
  const settle = async (msg?: RegExp) => { await idle(); if (msg) await page.waitForFunction((s: string) => new RegExp(s).test(document.getElementById('message')!.textContent ?? ''), msg.source); };
  const steps: Snap[] = [];
  steps.push(await snap()); // Editor 10 initial
  await page.fill('[data-doc="1"] input[name=title]', '<img src=x onerror="window.__x=1">');
  await page.fill('[data-doc="1"] input[name=size]', '10');
  await page.click('[data-doc="1"] form button');
  await settle(/ok \(200\)/);
  steps.push(await snap());
  await as(5, 'Viewer');
  await page.waitForFunction(() => !document.querySelector('[data-doc="1"] button'));
  steps.push(await snap());
  await as(1, 'Admin');
  await page.waitForSelector('[data-doc="1"] [data-action=publish]');
  steps.push(await snap());
  await page.click('[data-doc="1"] [data-action=publish]');
  await settle(/ok \(200\)/);
  steps.push(await snap());
  await page.click('[data-doc="1"] [data-action=delete]');
  await settle(/ok \(200\)/);
  steps.push(await snap());
  const xss = await page.evaluate(() => (window as unknown as { __x?: number }).__x === 1);
  await browser.close();
  return { steps, xss, label };
}

const interp = await makeServer();
const wasm = await makeServer({ wasm: true });
const listen = async (srv: typeof interp.server) => {
  await new Promise<void>((r) => srv.listen(0, r));
  return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
};
const baseI = await listen(interp.server);
const baseW = await listen(wasm.server);
let failed = false;
try {
  // Four configurations, one script: the in-page engine (interpreter, Wasm) and the Node server (interpreter, Wasm).
  const runs = {
    'local interp': await drive(baseI, ''),
    'local wasm': await drive(baseI, '?engine=wasm'),
    'remote interp': await drive(baseI, '?backend=remote'),
    'remote wasm': await drive(baseW, '?backend=remote'),
  };
  for (const [name, r] of Object.entries(runs)) {
    console.log(`${name}: ${r.label}`);
    if (r.xss) { console.error(`FAIL ${name}: title was interpreted as markup`); failed = true; }
    if (name.endsWith('wasm') !== r.label.includes('wasm')) { console.error(`FAIL ${name}: page reports "${r.label}"`); failed = true; }
  }
  const ref = JSON.stringify(runs['local interp'].steps);
  for (const [name, r] of Object.entries(runs)) {
    if (JSON.stringify(r.steps) !== ref) { failed = true; console.error(`FAIL: ${name} differs from local interp\nlocal interp:`, ref, `\n${name}:`, JSON.stringify(r.steps)); }
  }
  const last = runs['local wasm'].steps[runs['local wasm'].steps.length - 1];
  const s = runs['local wasm'].steps;
  const checks: [string, boolean][] = [
    ['viewer sees no buttons', s[2].buttons.every((x) => x.endsWith(':'))],
    ['empty draft cannot be published', !s[3].buttons[2].includes('Publish')],
    ['doc 1 ends Deleted with no buttons', last.cards[0].includes('|Deleted|') && last.buttons[0] === '1:'],
    ['audit has 3 entries and no title', (JSON.parse(last.audit) as unknown[]).length === 3 && !last.audit.includes('onerror')],
  ];
  for (const [n, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${n} (wasm)`); if (!ok) failed = true; }
  console.log(failed ? 'E2E FAILED' : `E2E OK: ${s.length} steps identical across local/remote x interpreter/wasm`);
} finally {
  interp.server.close();
  wasm.server.close();
}
process.exit(failed ? 1 : 0);
