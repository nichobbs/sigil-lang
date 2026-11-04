import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// End-to-end: a flow error becomes "clean, pending human approval" once a narrow declassifier is proposed.
const cli = (dir: string, ...a: string[]) => {
  try {
    return { code: 0, out: execFileSync('npx', ['tsx', 'src/cli.ts', ...a, dir], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    const x = e as { status?: number; stdout?: string };
    return { code: x.status ?? 1, out: x.stdout ?? '' };
  }
};

describe('proposed-policy.sigil', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigil-prop-'));
  cpSync('examples/invoicing', dir, { recursive: true });

  it('rejects allow/sink rules in a proposal', () => {
    writeFileSync(join(dir, 'proposed-policy.sigil'), '(policy (allow audit))');
    const r = cli(dir, 'check');
    expect(r.code).not.toBe(0);
  });

  it('a proposal that is not used reports nothing pending', () => {
    writeFileSync(join(dir, 'proposed-policy.sigil'), '(policy (declassify unused-band (from pii) (to internal) (reason "x") (fns nothing)))');
    const r = cli(dir, 'check');
    expect(r.out).not.toContain('PENDING HUMAN APPROVAL');
  });
});
