// Runs the agent's caller program B in a child process. B holds no service state: every refund goes to the parent over IPC.
import { pathToFileURL } from 'node:url';
const bFile = process.argv[2];
const init = JSON.parse(process.argv[3]);
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
const rpc = (payment, token) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    process.send({ t: 'q', id, payment, token });
  });
const host = {
  grants: init.grants,
  inbox: init.inbox,
  requests: init.requests,
  refund: (paymentId, token) => rpc(paymentId, token),
};
const sink = { emit: (v) => process.send({ t: 'emit', value: String(v) }) };
try {
  const mod = await import(pathToFileURL(bFile).href);
  await mod.default(host, sink);
  process.send({ t: 'done' });
} catch (e) {
  process.send({ t: 'err', msg: String((e && e.stack) || e) });
}
