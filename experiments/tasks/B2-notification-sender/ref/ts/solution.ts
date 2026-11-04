// B2 notification sender with a retry policy: reference implementation (TypeScript).
// Self-contained on purpose: the harness loads this file alone.

type Channel = 'Email' | 'Sms';
type Kind = 'Receipt' | 'Reminder' | 'Alert';
interface Recipient {
  id: number;
  name: string;
  email: string;
  phone: string;
  channel: Channel;
  optedOut: boolean;
}
interface AttemptPolicy {
  maxAttempts: number;
  fallback: boolean;
}
interface Args {
  recipient: Recipient;
  kind: Kind;
  policy: AttemptPolicy;
}
interface Host {
  net: { post(handle: string, payload: unknown): Promise<{ ok: boolean }> };
  audit: { emit(handle: string, event: unknown): Promise<void> };
}
interface Report {
  outcome: 'Delivered' | 'Failed' | 'Skipped';
  attempts: number;
}

const MAX_ATTEMPTS = 3;
const LINES: Record<Kind, string> = {
  Receipt: 'your receipt is ready',
  Reminder: 'this is a reminder',
  Alert: 'this is an alert',
};

function channelFor(pref: Channel, fallback: boolean, n: number): Channel {
  if (fallback && n === 2) return pref === 'Email' ? 'Sms' : 'Email';
  return pref;
}

async function attemptOnce(r: Recipient, kind: Kind, channel: Channel, n: number, host: Host): Promise<boolean> {
  const notice = {
    to: channel === 'Email' ? r.email : r.phone,
    kind,
    channel,
    attempt: n,
    text: `Hello ${r.name}, ${LINES[kind]}`,
  };
  const res = await host.net.post(channel === 'Email' ? 'net:email' : 'net:sms', notice);
  return res.ok;
}

async function deliver({ recipient, kind, policy }: Args, host: Host): Promise<Report> {
  if (recipient.optedOut) {
    if (kind !== 'Alert') return { outcome: 'Skipped', attempts: 0 };
    const ok = await attemptOnce(recipient, kind, recipient.channel, 1, host);
    return { outcome: ok ? 'Delivered' : 'Failed', attempts: 1 };
  }
  const limit = Math.min(policy.maxAttempts, MAX_ATTEMPTS);
  for (let n = 1; n <= limit; n++) {
    if (await attemptOnce(recipient, kind, channelFor(recipient.channel, policy.fallback, n), n, host)) {
      return { outcome: 'Delivered', attempts: n };
    }
  }
  return { outcome: 'Failed', attempts: limit };
}

export default async function run(args: Args, host: Host): Promise<Report> {
  const report = await deliver(args, host);
  await host.audit.emit('audit', {
    recipient: args.recipient.id,
    kind: args.kind,
    outcome: report.outcome,
    attempts: report.attempts,
  });
  return report;
}
