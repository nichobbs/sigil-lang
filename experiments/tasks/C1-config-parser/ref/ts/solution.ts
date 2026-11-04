// C1 config parser: reference implementation (TypeScript).
// Self-contained on purpose: the harness loads this file alone.

type Kind = 'IntValue' | 'BoolValue' | 'TextValue';
type Reason = 'BadKey' | 'BadValue' | 'Duplicate' | 'Unterminated';
interface Setting {
  key: string;
  kind: Kind;
  num: number;
  flag: boolean;
  text: string;
}
type Result = { ok: { settings: Setting[] } } | { err: { line: number; reason: Reason } };

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const KEY_MAX = 64;

const isBlank = (c: string) => c === ' ' || c === '\t';
const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const INT = /^[+-]?[0-9]+$/;

/** A setting, or the reason this line is bad. Duplicates are the caller's business (last check). */
function parseLine(line: string): 'skip' | Reason | Setting {
  let i = 0;
  while (i < line.length && isBlank(line[i])) i++;
  if (i === line.length || line[i] === '#') return 'skip';

  const eq = line.indexOf('=', i);
  if (eq < 0) return 'BadKey';
  let end = eq;
  while (end > i && isBlank(line[end - 1])) end--;
  const key = line.slice(i, end);
  if (key.length > KEY_MAX || !KEY.test(key)) return 'BadKey';

  let j = eq + 1;
  while (j < line.length && isBlank(line[j])) j++;
  if (j === line.length || line[j] === '#') return 'BadValue';

  let setting: Setting;
  let rest: number;
  if (line[j] === '"') {
    const close = line.indexOf('"', j + 1);
    if (close < 0) return 'Unterminated';
    setting = { key, kind: 'TextValue', num: 0, flag: false, text: line.slice(j + 1, close) };
    rest = close + 1;
  } else {
    let k = j;
    while (k < line.length && !isBlank(line[k]) && line[k] !== '#') k++;
    const token = line.slice(j, k);
    rest = k;
    if (token === 'true' || token === 'false') {
      setting = { key, kind: 'BoolValue', num: 0, flag: token === 'true', text: '' };
    } else if (INT.test(token)) {
      const n = Number(token); // exact for anything near the range; huge digit runs only get larger
      if (!(n >= INT_MIN && n <= INT_MAX)) return 'BadValue';
      setting = { key, kind: 'IntValue', num: n === 0 ? 0 : n, flag: false, text: '' };
    } else {
      return 'BadValue';
    }
  }
  while (rest < line.length && isBlank(line[rest])) rest++;
  if (rest < line.length && line[rest] !== '#') return 'BadValue';
  return setting;
}

export default function run(args: { text: string }): Result {
  const lines = args.text.split('\n');
  const settings: Setting[] = [];
  const seen = new Set<string>();
  for (let n = 0; n < lines.length; n++) {
    const r = parseLine(lines[n]);
    if (r === 'skip') continue;
    if (typeof r === 'string') return { err: { line: n + 1, reason: r } };
    if (seen.has(r.key)) return { err: { line: n + 1, reason: 'Duplicate' } };
    seen.add(r.key);
    settings.push(r);
  }
  return { ok: { settings } };
}
