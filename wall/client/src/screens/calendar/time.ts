// Calendar dates (YYYY-MM-DD) and time-zone helpers. Arithmetic runs in UTC so DST never shifts a day.
export type Ymd = string;

const pad = (n: number) => String(n).padStart(2, '0');
const toUtc = (d: Ymd) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd));
};

export function addDays(d: Ymd, n: number): Ymd {
  const t = toUtc(d);
  t.setUTCDate(t.getUTCDate() + n);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export const dayOfWeek = (d: Ymd) => toUtc(d).getUTCDay();
export const diffDays = (a: Ymd, b: Ymd) => Math.round((toUtc(a).getTime() - toUtc(b).getTime()) / 86_400_000);
export const startOfWeek = (d: Ymd, weekStart: number) => addDays(d, -((dayOfWeek(d) - weekStart + 7) % 7));

// An instant's calendar date and minutes after midnight in a time zone.
export function zoner(tz: string): (ms: number) => { date: Ymd; minutes: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  return (ms) => {
    const p: Record<string, string> = {};
    for (const part of f.formatToParts(ms)) p[part.type] = part.value;
    return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
  };
}

// Labels for calendar dates. Formatting in UTC keeps the date as written.
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...o, timeZone: 'UTC' });
const monthDay = fmt({ month: 'short', day: 'numeric' });
const weekdayShort = fmt({ weekday: 'short' });
const dayLong = fmt({ weekday: 'long', month: 'short', day: 'numeric' });
const dayLongYear = fmt({ weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

export function weekTitle(start: Ymd): string {
  const end = addDays(start, 6);
  const [sy, sm] = start.split('-');
  const [ey, em, ed] = end.split('-');
  if (sy !== ey) return `${monthDay.format(toUtc(start))}, ${sy} – ${monthDay.format(toUtc(end))}, ${ey}`;
  if (sm !== em) return `${monthDay.format(toUtc(start))} – ${monthDay.format(toUtc(end))}, ${ey}`;
  return `${monthDay.format(toUtc(start))} – ${Number(ed)}, ${ey}`;
}

export const dayTitle = (d: Ymd) => dayLongYear.format(toUtc(d));
export const dayLabel = (d: Ymd) => dayLong.format(toUtc(d));
export const weekdayLabel = (d: Ymd) => weekdayShort.format(toUtc(d)).toUpperCase();
export const dayNumber = (d: Ymd) => Number(d.slice(8));

// Clock-style labels from minutes after midnight.
export function clockLabel(minutes: number, clock: '12h' | '24h', withPeriod: boolean): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = pad(minutes % 60);
  if (clock === '24h') return `${pad(h)}:${m}`;
  const h12 = ((h + 11) % 12) + 1;
  return withPeriod ? `${h12}:${m} ${h < 12 ? 'AM' : 'PM'}` : `${h12}:${m}`;
}

export function hourLabel(hour: number, clock: '12h' | '24h'): string {
  if (clock === '24h') return `${pad(hour)}:00`;
  return `${((hour + 11) % 12) + 1} ${hour < 12 ? 'AM' : 'PM'}`;
}
