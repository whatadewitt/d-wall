import type { ClientConfig } from './config';

// Quiet hours (spec section 8), as "HH:MM" in the configured time zone. A range past midnight wraps.
const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function quietChecker(config: Pick<ClientConfig, 'idle' | 'timezone'>): (now?: number) => boolean {
  const q = config.idle.quietHours;
  if (!q?.from || !q?.to) return () => false;
  const from = minutes(q.from);
  const to = minutes(q.to);
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return (now = Date.now()) => {
    const p = Object.fromEntries(clock.formatToParts(now).map((x) => [x.type, x.value]));
    const m = Number(p.hour) * 60 + Number(p.minute);
    return from <= to ? m >= from && m < to : m >= from || m < to;
  };
}
