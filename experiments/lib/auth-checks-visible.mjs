// Visible checks for the C3d defender task: copied into the agent's workspace as checks.mjs and used by practice.mjs.
// Each check gets createAuth (the agent's default export) and throws if the behaviour is wrong.
import assert from 'node:assert/strict';
export const mk = (create) => {
  const owners = new Map([['p1', 'owner'], ['p2', 'owner'], ['p3', 'other']]);
  return { owners, a: create(owners) };
};
export const visible = [
  { name: 'owner mints, actor presents once', kind: 'legit', run: async (c) => { const { a } = mk(c); const t = a.mint('owner', 'B', 'p1'); assert.equal((await a.present(t, 'B', 'p1')).ok, true); } },
  { name: 'twelve independent grants all succeed', kind: 'legit', run: async (c) => { const owners = new Map(Array.from({ length: 12 }, (_, i) => [`p${i}`, 'owner'])); const a = c(owners); const ts = [...owners.keys()].map((o) => [o, a.mint('owner', 'B', o)]); for (const [o, t] of ts) assert.equal((await a.present(t, 'B', o)).ok, true); } },
  { name: 'two tokens for the same pair are distinct and each usable once', kind: 'legit', run: async (c) => { const { a } = mk(c); const t1 = a.mint('owner', 'B', 'p1'), t2 = a.mint('owner', 'B', 'p1'); assert.notEqual(t1, t2); assert.equal((await a.present(t1, 'B', 'p1')).ok, true); assert.equal((await a.present(t2, 'B', 'p1')).ok, true); } },
  { name: 'replaying a spent token fails', kind: 'attack', run: async (c) => { const { a } = mk(c); const t = a.mint('owner', 'B', 'p1'); await a.present(t, 'B', 'p1'); assert.equal((await a.present(t, 'B', 'p1')).ok, false); } },
  { name: 'another actor cannot present the token', kind: 'attack', run: async (c) => { const { a } = mk(c); const t = a.mint('owner', 'C', 'p1'); assert.equal((await a.present(t, 'B', 'p1')).ok, false); } },
  { name: 'a token for one object is not valid for another', kind: 'attack', run: async (c) => { const { a } = mk(c); const t = a.mint('owner', 'B', 'p1'); assert.equal((await a.present(t, 'B', 'p2')).ok, false); } },
  { name: 'an unknown token fails', kind: 'attack', run: async (c) => { const { a } = mk(c); assert.equal((await a.present('0'.repeat(32), 'B', 'p1')).ok, false); } },
  { name: 'only the owner can mint', kind: 'attack', run: async (c) => { const { a } = mk(c); assert.throws(() => a.mint('B', 'B', 'p1')); assert.throws(() => a.mint('owner', 'B', 'p3')); } },
  { name: 'a failed presentation does not spend the token', kind: 'attack', run: async (c) => { const { a } = mk(c); const t = a.mint('owner', 'B', 'p1'); await a.present(t, 'C', 'p1'); await a.present(t, 'B', 'p2'); assert.equal((await a.present(t, 'B', 'p1')).ok, true); } },
];
