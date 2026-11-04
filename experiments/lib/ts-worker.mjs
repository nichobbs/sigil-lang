// Runs a TypeScript solution in a worker thread so the harness can enforce a per-case timeout
// (terminate + respawn) and a crash can never take the harness down. Expected results never enter this thread.
import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

const here = import.meta.url;

// Egress guard: a solution may only talk to the world through the host object. Any attempt to open a network connection or start a
// process is recorded (and answered with a harmless fake) so the scorer can fail the case. The attempt is the violation, not the outcome.
import { createRequire } from 'node:module';
import { syncBuiltinESMExports } from 'node:module';
let egress = [];
{
  const req = createRequire(import.meta.url);
  const rec = (kind, what) => egress.push(`${kind}: ${String(what).slice(0, 120)}`);
  globalThis.fetch = async (u) => {
    rec('fetch', u && u.url ? u.url : u);
    return new Response('{}', { status: 200 });
  };
  const fake = (kind, argOf) => function () {
    rec(kind, argOf(arguments));
    const { EventEmitter } = req('node:events');
    const e = new EventEmitter();
    e.end = () => e; e.write = () => true; e.destroy = () => e; e.setTimeout = () => e;
    return e;
  };
  for (const m of ['node:http', 'node:https']) {
    const mod = req(m);
    for (const f of ['request', 'get']) mod[f] = fake(`${m}.${f}`, (a) => (typeof a[0] === 'string' ? a[0] : JSON.stringify(a[0])));
  }
  const net = req('node:net');
  for (const f of ['connect', 'createConnection']) net[f] = fake(`net.${f}`, (a) => JSON.stringify(a[0]));
  const cp = req('node:child_process');
  for (const f of ['exec', 'execSync', 'spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) cp[f] = fake(`child_process.${f}`, (a) => a[0]);
  syncBuiltinESMExports();
}
let run;
let toJson;
let makeHost;
let initError = null;
try {
  ({ toJson } = await tsImport('./json.ts', here));
  ({ makeHost } = await tsImport('./host.ts', here));
  const mod = await tsImport(workerData.solution, here);
  run = mod.default;
  // A solution outside a "type": "module" package is loaded as CommonJS: its default export may be nested once more.
  if (typeof run !== 'function' && run && typeof run.default === 'function') run = run.default;
  if (typeof run !== 'function') initError = 'solution must default-export a function run(args, host)';
} catch (e) {
  initError = `could not load solution: ${e && e.message ? e.message : String(e)}`.slice(0, 300);
}

parentPort.on('message', async (m) => {
  if (initError) return parentPort.postMessage({ id: m.id, error: initError });
  const { host, effects } = makeHost(m.host);
  egress = [];
  try {
    const raw = await run(m.args, host);
    if (raw === undefined) throw new Error('run returned undefined');
    const result = toJson(raw, 'result');
    parentPort.postMessage({ id: m.id, result, effects: { ...effects(), egress } });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: `crash: ${e && e.message ? e.message : String(e)}`.slice(0, 300) });
  }
});
parentPort.postMessage({ ready: true });
