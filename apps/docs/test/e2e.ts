// Browser end-to-end: drive the same script against the local (in-page, localStorage) and remote (Node + SQLite) backends in
// real Chromium and require identical observable state at every step. Run: npm run docs:e2e (needs `npm run docs:build`).
import { createRequire } from 'node:module';
import { makeServer } from '../src/server.js';

const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: any }; // playwright is preinstalled outside the repo; kept untyped on purpose

type Snap = { cards: string[]; buttons: string[]; message: string; audit: string };

async function drive(base: string, query: string): Promise<{ steps: Snap[]; xss: boolean }> {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}/${query}`);
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
  return { steps, xss };
}

const { server } = makeServer();
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let failed = false;
try {
  const local = await drive(base, '');
  const remote = await drive(base, '?backend=remote');
  for (const [name, r] of [['local', local], ['remote', remote]] as const) {
    if (r.xss) { console.error(`FAIL ${name}: title was interpreted as markup`); failed = true; }
  }
  const a = JSON.stringify(local.steps);
  const b = JSON.stringify(remote.steps);
  if (a !== b) { failed = true; console.error('FAIL: local and remote differ\nlocal :', a, '\nremote:', b); }
  const last = local.steps[local.steps.length - 1];
  const checks: [string, boolean][] = [
    ['viewer sees no buttons', local.steps[2].buttons.every((x) => x.endsWith(':'))],
    ['empty draft cannot be published', !local.steps[3].buttons[2].includes('Publish')],
    ['doc 1 ends Deleted with no buttons', last.cards[0].includes('|Deleted|') && last.buttons[0] === '1:'],
    ['audit has 3 entries and no title', (JSON.parse(last.audit) as unknown[]).length === 3 && !last.audit.includes('onerror')],
  ];
  for (const [n, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`); if (!ok) failed = true; }
  console.log(failed ? 'E2E FAILED' : `E2E OK: ${local.steps.length} steps identical on local and remote backends`);
} finally {
  server.close();
}
process.exit(failed ? 1 : 0);
