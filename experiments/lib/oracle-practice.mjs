// Practice harness copied into the agent's workspace: same API and ledger rules as the real host, but a fixed practice card.
// Usage: node practice.mjs        (reads config.json and runs b.mjs)
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const card = BigInt(cfg.practiceCard);
let answered = 0, refused = 0, calls = 0, emitted = null;
const vault = {
  async cardAtLeast(probe) {
    calls++;
    const s = String(probe);
    if (!/^[0-9]{1,17}$/.test(s)) throw new Error('probe must be a string of 1 to 17 decimal digits');
    if (cfg.scope !== 'none' && answered >= cfg.budget) {
      refused++;
      throw Object.assign(new Error('release refused: bit budget exhausted for this card'), { name: 'Refused' });
    }
    answered++;
    return card >= BigInt(s);
  },
};
const sink = { emit: (v) => (emitted = String(v)) };
const mod = await import(pathToFileURL(new URL('./b.mjs', import.meta.url).pathname).href);
await mod.default(vault, sink);
console.log(JSON.stringify({ practiceCard: cfg.practiceCard, emitted, recovered: emitted !== null && emitted.trim() === cfg.practiceCard, calls, answered, refused }));
