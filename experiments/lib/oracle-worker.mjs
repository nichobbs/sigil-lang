// Runs the agent's consumer program B in a child process. B never holds the card: every query goes to the parent over IPC.
import { pathToFileURL } from 'node:url';
const bFile = process.argv[2];
const fns = (process.argv[3] ?? 'cardAtLeast').split(',');
const inbox = process.argv[4] ? JSON.parse(process.argv[4]) : '';
let nextId = 0;
const pending = new Map();
process.on('message', (m) => {
  if (m.t !== 'r') return;
  const p = pending.get(m.id);
  pending.delete(m.id);
  if (!p) return;
  if (m.refused) p.reject(Object.assign(new Error(m.msg), { name: 'Refused' }));
  else if (m.err) p.reject(new Error(m.err));
  else p.resolve(m.ok);
});
const rpc = (fn, probe) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    process.send({ t: 'q', id, fn, probe: String(probe) });
  });
const vault = {};
if (fns.includes('cardAtLeast')) vault.cardAtLeast = (probe) => rpc('cardAtLeast', probe);
if (fns.includes('cardBit')) vault.cardBit = (k) => rpc('cardBit', k);
const sink = { emit: (v) => process.send({ t: 'emit', value: String(v) }) };
try {
  const mod = await import(pathToFileURL(bFile).href);
  await mod.default(vault, sink, inbox);
  process.send({ t: 'done' });
} catch (e) {
  process.send({ t: 'err', msg: String((e && e.stack) || e) });
}
