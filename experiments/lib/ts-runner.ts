// TypeScript runner: the solution default-exports run(args, host). It executes in a worker thread
// (tsx loads the .ts), one case at a time, with a per-case timeout. On timeout or worker death the
// worker is replaced and the remaining cases still run.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { Case, CaseFile, Outcome, Score, score } from './score.js';
import type { Effects } from './host.js';
import type { Json } from './json.js';

const WORKER = fileURLToPath(new URL('./ts-worker.mjs', import.meta.url));

type Msg = { ready: true } | { id: number; result?: Json; effects?: Effects; error?: string };

class Slot {
  private w!: Worker;
  private nextId = 1;
  private waiters = new Map<number, (m: Msg) => void>();
  private ready!: Promise<void>;
  private dead = false;
  constructor(private solution: string) {
    this.spawn();
  }
  private spawn() {
    this.w = new Worker(WORKER, { workerData: { solution: this.solution }, stdout: true, stderr: true });
    this.w.stdout.resume();
    this.w.stderr.resume();
    this.ready = new Promise((res) => {
      const w = this.w;
      w.on('message', (m: Msg) => {
        if ('ready' in m) return res();
        if (this.w !== w) return;
        this.waiters.get(m.id)?.(m);
      });
      const die = (why: string) => {
        res();
        if (this.w !== w) return; // a worker we already replaced (timeout): its exit is not news
        this.dead = true;
        for (const [id, f] of this.waiters) f({ id, error: why });
        this.waiters.clear();
      };
      w.on('error', (e) => die(`crash: ${e.message}`.slice(0, 300)));
      w.on('exit', (code) => die(`worker exited (code ${code})`));
    });
  }
  async call(c: Case, timeoutMs: number): Promise<Outcome> {
    if (this.dead) {
      this.dead = false;
      this.spawn();
    }
    await this.ready;
    const id = this.nextId++;
    return new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        this.w.terminate();
        this.spawn();
        resolve({ error: `timeout after ${timeoutMs} ms` });
      }, timeoutMs);
      this.waiters.set(id, (m) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        if ('error' in m && m.error) return resolve({ error: m.error });
        if (!m || !('effects' in m) || m.effects === undefined || m.result === undefined) return resolve({ error: 'wrong shape: no result' });
        resolve({ result: m.result, effects: m.effects });
      });
      this.w.postMessage({ id, args: c.args, host: c.host ?? {} });
    });
  }
  async close() {
    await this.w.terminate();
  }
}

export async function runTs(cf: CaseFile, solutionPath: string, timeoutMs = 2000): Promise<Score> {
  const slot = new Slot(solutionPath);
  try {
    return await score(cf, (c) => slot.call(c, timeoutMs));
  } finally {
    await slot.close();
  }
}
