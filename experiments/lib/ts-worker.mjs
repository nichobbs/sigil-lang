// Runs a TypeScript solution in a worker thread so the harness can enforce a per-case timeout
// (terminate + respawn) and a crash can never take the harness down. Expected results never enter this thread.
import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

const here = import.meta.url;
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
  try {
    const raw = await run(m.args, host);
    if (raw === undefined) throw new Error('run returned undefined');
    const result = toJson(raw, 'result');
    parentPort.postMessage({ id: m.id, result, effects: effects() });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: `crash: ${e && e.message ? e.message : String(e)}`.slice(0, 300) });
  }
});
parentPort.postMessage({ ready: true });
