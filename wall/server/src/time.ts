// Calendar dates (YYYY-MM-DD) and time-zone helpers. Date arithmetic runs in UTC so DST never shifts a day.
const pad = (n: number) => String(n).padStart(2, '0');

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function dayOfWeek(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function startOfWeek(ymd: string, weekStart: number): string {
  return addDays(ymd, -((dayOfWeek(ymd) - weekStart + 7) % 7));
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string): Record<string, number> {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return Object.fromEntries(f.formatToParts(ms).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
}

export function todayIn(tz: string, ms = Date.now()): string {
  const p = parts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// The instant of 00:00 on a calendar date in a time zone.
export function zonedMidnight(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, tz);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += target - shown;
  }
  return new Date(guess);
}

// The local date and minutes past local midnight in a time zone.
export function localTime(tz: string, ms = Date.now()): { ymd: string; minutes: number } {
  const p = parts(ms, tz);
  return { ymd: `${p.year}-${pad(p.month)}-${pad(p.day)}`, minutes: p.hour * 60 + p.minute };
}

// "HH:MM" as minutes past midnight.
export function hhmm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

// Quiet hours (spec section 8): "HH:MM" to "HH:MM" in a time zone. A range past midnight wraps.
export function inQuietHours(q: { from: string; to: string } | undefined, tz: string, ms = Date.now()): boolean {
  if (!q?.from || !q?.to) return false;
  const now = localTime(tz, ms).minutes;
  const from = hhmm(q.from);
  const to = hhmm(q.to);
  return from <= to ? now >= from && now < to : now >= from || now < to;
}
