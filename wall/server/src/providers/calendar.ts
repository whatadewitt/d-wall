import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { GoogleCalendar, GoogleError, type GoogleEvent } from '../google.js';
import { serverState } from '../state.js';
import { addDays, startOfWeek, todayIn, zonedMidnight } from '../time.js';
import type { Provider, ProviderDeps } from './types.js';

// The calendar provider (spec section 5): poll Google every 60 s for a 10-week window,
// normalize, merge and hash, and publish `calendar.changed` when the hash changes.

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string; // dateTime with offset, or YYYY-MM-DD for all-day events
  end: string;   // exclusive date for all-day events
  allDay: boolean;
  location: string;
  description: string;
}

const POLL_MS = 60_000;
const MIN_GAP_MS = 5_000; // an immediate poll (client connect, wake) is skipped if one ran this recently
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';

// Google descriptions can hold HTML. The client only ever gets plain text.
function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalize(calendarId: string, e: GoogleEvent): CalendarEvent | null {
  if (e.status === 'cancelled') return null;
  if (e.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return null;
  const start = e.start.dateTime ?? e.start.date;
  const end = e.end.dateTime ?? e.end.date;
  if (!start || !end) return null;
  return {
    id: e.id,
    calendarId,
    title: e.summary?.trim() || '(No title)',
    start,
    end,
    allDay: !e.start.dateTime,
    location: e.location?.trim() ?? '',
    description: e.description ? plainText(e.description) : '',
  };
}

export function calendarProvider({ config, log, bus, publishState, hub }: ProviderDeps): Provider {
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  let google: GoogleCalendar | null = null;
  const lastGood = new Map<string, CalendarEvent[]>(); // per calendar, kept when Google is unreachable
  let merged: CalendarEvent[] = [];
  let hash = '';
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | null = null;
  let lastRun = 0;

  async function poll(): Promise<void> {
    if (!google) return;
    lastRun = Date.now();
    const tz = config.timezone;
    const thisWeek = startOfWeek(todayIn(tz), config.weekStart);
    // Last week, this week and 8 weeks ahead: the 10-week window.
    const timeMin = zonedMidnight(addDays(thisWeek, -7), tz);
    const timeMax = zonedMidnight(addDays(thisWeek, 63), tz);

    const results = await Promise.allSettled(
      config.calendars.map((c) => google!.listEvents(c.googleId, timeMin, timeMax, tz)),
    );
    let failed = 0;
    results.forEach((r, i) => {
      const cal = config.calendars[i];
      if (r.status === 'fulfilled') {
        lastGood.set(cal.id, r.value.flatMap((e) => normalize(cal.id, e) ?? []));
      } else {
        failed++;
        const err = r.reason;
        // Calendar config id only: Google ids and event content never reach the log.
        const reason = err instanceof GoogleError ? err.reason : String(err?.cause?.code ?? err?.name ?? err);
        log.warn({ calendar: cal.id, http: err instanceof GoogleError ? err.status : undefined, reason }, 'calendar poll failed');
      }
    });

    merged = config.calendars
      .flatMap((c) => lastGood.get(c.id) ?? [])
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const next = createHash('sha1').update(JSON.stringify(merged)).digest('hex');

    const wasStale = serverState.calendar.stale;
    if (failed === 0) serverState.calendar.lastSuccess = new Date().toISOString();
    serverState.calendar.stale = failed > 0;
    if (wasStale !== serverState.calendar.stale) publishState();

    if (next !== hash) {
      hash = next;
      log.info({ events: merged.length, calendars: config.calendars.length, failed }, 'calendar changed');
      hub.publish('calendar.changed', { at: new Date().toISOString() });
    }
  }

  function pollNow(): void {
    if (running || Date.now() - lastRun < MIN_GAP_MS) return;
    running = poll()
      .catch((err) => log.error({ err: { message: String(err?.message ?? err) } }, 'calendar poll crashed'))
      .finally(() => {
        running = null;
      });
  }

  return {
    id: 'calendar',
    topics: ['calendar.changed'],

    routes(app: FastifyInstance) {
      app.get<{ Querystring: { from: string; to: string } }>('/api/calendar/events', {
        schema: {
          querystring: {
            type: 'object',
            required: ['from', 'to'],
            properties: { from: { type: 'string', pattern: DATE }, to: { type: 'string', pattern: DATE } },
          },
        },
      }, async (req, reply) => {
        // `from` and `to` are both inclusive calendar dates in the configured time zone.
        const { from, to } = req.query;
        const toExclusive = addDays(to, 1);
        if (toExclusive <= from || toExclusive > addDays(from, 70)) return reply.code(400).send({ error: 'bad range' });
        const rangeStart = zonedMidnight(from, config.timezone).getTime();
        const rangeEnd = zonedMidnight(toExclusive, config.timezone).getTime();
        reply.header('cache-control', 'no-store');
        return merged.filter((e) =>
          e.allDay
            ? e.start < toExclusive && e.end > from
            : Date.parse(e.start) < rangeEnd && Date.parse(e.end) > rangeStart,
        );
      });
    },

    start() {
      if (!credentials) {
        log.warn({ calendar: 'disabled' }, 'calendar: set GOOGLE_SA_KEY_FILE in .env to the service account key file');
        return;
      }
      try {
        google = new GoogleCalendar(credentials);
      } catch (err) {
        log.error({ calendar: 'disabled', error: err instanceof Error ? err.message : String(err) }, 'calendar: could not read the service account key');
        return;
      }
      // Poll at once when a client connects or the tablet wakes (section 5).
      bus.on('client-connected', pollNow);
      bus.on('tablet-state', (state: string) => state === 'active' && pollNow());
      pollNow();
      timer = setInterval(pollNow, POLL_MS);
    },

    stop() {
      clearInterval(timer);
    },
  };
}
