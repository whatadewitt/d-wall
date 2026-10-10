// The calendar screen (spec section 5). Week view by default, day view from a day header,
// a read-only sheet for an event. Every timer, subscription and fetch comes from ctx.
import { createRef, render } from 'preact';
import type { Mount } from '../types';
import { contact, keepOnly, weeks, type CalEvent } from './cache';
import { addDays, clockLabel, dayTitle, startOfWeek, weekTitle, zoner, type Ymd } from './time';
import { CalendarView, SHAPES, type CalInfo } from './view';
import './calendar.css';

const SWIPE_PX = 80;
const FLICK_PX = 30;
const FLICK_SPEED = 0.5; // px per ms
const SLIDE_MS = 200;
const RETURN_MS = 60_000;
const STALE_MS = 5 * 60_000;

export const mount: Mount = (root, ctx) => {
  const { config } = ctx;
  const zone = zoner(config.timezone);
  const calendars: CalInfo[] = config.calendars.map((c, i) => ({ ...c, shape: SHAPES[i % SHAPES.length] }));
  const calById = new Map(calendars.map((c) => [c.id, c]));
  const refs = { card: createRef<HTMLElement>(), pane: createRef<HTMLDivElement>(), scroll: createRef<HTMLDivElement>() };

  const today = () => zone(Date.now()).date;
  const thisWeek = () => startOfWeek(today(), config.weekStart);
  // The server holds last week through 8 weeks ahead; navigation stays inside that window.
  const firstWeek = () => addDays(thisWeek(), -7);
  const lastWeek = () => addDays(thisWeek(), 56);

  let mode: 'week' | 'day' = 'week';
  let anchor: Ymd = thisWeek(); // week start in week mode, the day in day mode
  let sheet: CalEvent | null = null;
  let lastTouch = Date.now();
  let scrollPending = true;
  let serverCal: { lastSuccess: string | null; stale: boolean } | null = null;

  const visibleWeek = () => (mode === 'week' ? anchor : startOfWeek(anchor, config.weekStart));
  const days = (): Ymd[] => (mode === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(anchor, i)) : [anchor]);

  // Data: the visible week plus one either side, each fetched on its own.
  async function load(week: Ymd): Promise<void> {
    try {
      const res = await ctx.fetch(`/api/calendar/events?from=${week}&to=${addDays(week, 6)}`);
      if (!res.ok) return;
      weeks.set(week, (await res.json()) as CalEvent[]);
      contact.last = Date.now();
      draw();
    } catch {
      // Aborted on unmount, or the server is unreachable: keep what is cached.
    }
  }

  function refresh(all: boolean): void {
    const w = visibleWeek();
    const keys = [w, addDays(w, -7), addDays(w, 7)].filter((k) => k >= firstWeek() && k <= lastWeek());
    keepOnly(keys);
    for (const k of keys) if (all || !weeks.has(k)) void load(k);
  }

  function canMove(dir: number): boolean {
    if (mode === 'week') {
      const next = addDays(anchor, 7 * dir);
      return next >= firstWeek() && next <= lastWeek();
    }
    const next = addDays(anchor, dir);
    return next >= firstWeek() && next <= addDays(lastWeek(), 6);
  }

  function setView(nextMode: 'week' | 'day', nextAnchor: Ymd): void {
    mode = nextMode;
    anchor = nextAnchor;
    sheet = null;
    scrollPending = true;
    refresh(false);
    draw();
  }

  function move(dir: number, fromDx = 0): void {
    if (!canMove(dir)) return springBack(fromDx);
    setView(mode, addDays(anchor, (mode === 'week' ? 7 : 1) * dir));
    const pane = refs.pane.current;
    if (!pane) return;
    pane.style.transform = '';
    const start = dir > 0 ? pane.offsetWidth + fromDx : -pane.offsetWidth + fromDx;
    pane.animate([{ transform: `translateX(${start}px)` }, { transform: 'translateX(0)' }], { duration: SLIDE_MS, easing: 'ease-out' });
  }

  function springBack(dx: number): void {
    const pane = refs.pane.current;
    if (!pane) return;
    pane.style.transform = '';
    if (dx) pane.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], { duration: 150, easing: 'ease-out' });
  }

  // Horizontal swipe moves a week (or a day). Vertical drags are left to the browser (touch-action: pan-y).
  let drag: { id: number; x: number; y: number; t: number; dx: number; horizontal: boolean | null } | null = null;
  let suppressClickUntil = 0;
  const pointer = {
    onPointerDown(e: PointerEvent) {
      if (sheet || drag || !e.isPrimary) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, dx: 0, horizontal: null };
    },
    onPointerMove(e: PointerEvent) {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (drag.horizontal === null && Math.hypot(dx, dy) > 10) {
        drag.horizontal = Math.abs(dx) > Math.abs(dy);
        if (drag.horizontal) (e.currentTarget as Element).setPointerCapture(e.pointerId);
      }
      if (drag.horizontal && refs.pane.current) {
        drag.dx = dx;
        refs.pane.current.style.transform = `translateX(${dx}px)`;
      }
    },
    onPointerUp(e: PointerEvent) {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (!d.horizontal) return;
      suppressClickUntil = e.timeStamp + 300;
      const speed = Math.abs(d.dx) / Math.max(1, e.timeStamp - d.t);
      const go = Math.abs(d.dx) > SWIPE_PX || (speed > FLICK_SPEED && Math.abs(d.dx) > FLICK_PX);
      if (go) move(d.dx < 0 ? 1 : -1, d.dx);
      else springBack(d.dx);
    },
    onPointerCancel(e: PointerEvent) {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = drag.dx;
      drag = null;
      springBack(dx);
    },
    onClickCapture(e: MouseEvent) {
      if (e.timeStamp < suppressClickUntil) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
  };

  function staleSince(now: number): string | null {
    let since: number | null = null;
    if (contact.last && now - contact.last > STALE_MS) since = contact.last;
    if (serverCal?.stale && serverCal.lastSuccess) {
      const ok = Date.parse(serverCal.lastSuccess);
      if (now - ok > STALE_MS) since = Math.min(since ?? ok, ok);
    }
    return since === null ? null : clockLabel(zone(since).minutes, config.clock, true);
  }

  function scrollIntoPlace(): void {
    const el = refs.scroll.current;
    if (!el) return;
    const hourPx = el.scrollHeight / 24;
    const t = today();
    const showsToday = days().includes(t);
    el.scrollTop = showsToday ? (zone(Date.now()).minutes / 60) * hourPx - el.clientHeight / 3 : 7 * hourPx;
  }

  function draw(): void {
    const now = Date.now();
    const t = today();
    render(
      <CalendarView
        mode={mode}
        title={mode === 'week' ? weekTitle(anchor) : dayTitle(anchor)}
        days={days()}
        today={t}
        nowMin={zone(now).minutes}
        events={weeks.get(visibleWeek()) ?? []}
        calendars={calendars}
        calById={calById}
        clock={config.clock}
        zone={zone}
        staleSince={staleSince(now)}
        canPrev={canMove(-1)}
        canNext={canMove(1)}
        sheet={sheet}
        refs={refs}
        on={{
          prev: () => move(-1),
          next: () => move(1),
          today: () => setView(mode, mode === 'week' ? thisWeek() : t),
          week: () => setView('week', startOfWeek(anchor, config.weekStart)),
          day: (d) => setView('day', d),
          open: (e) => {
            sheet = e;
            draw();
          },
          close: () => {
            sheet = null;
            draw();
          },
          touch: () => {
            lastTouch = Date.now();
          },
          pointer,
        }}
      />,
      root,
    );
    if (scrollPending) {
      scrollPending = false;
      scrollIntoPlace();
    }
  }

  // After 60 s without touch anywhere but this week's week view, go back to this week (sections 5 and 9).
  function tick(): void {
    const home = mode === 'week' && anchor === thisWeek();
    if (!home && Date.now() - lastTouch >= RETURN_MS) setView('week', thisWeek());
    else draw();
  }

  ctx.subscribe('calendar.changed', () => refresh(true));
  ctx.subscribe('state', (msg) => {
    serverCal = (msg as { calendar?: typeof serverCal }).calendar ?? null;
    draw();
  });
  ctx.every(10_000, tick); // header clock, now line, stale note, return to this week
  ctx.every(60_000, () => refresh(true)); // also proves contact with the server for the stale note
  ctx
    .fetch('/api/state')
    .then((r) => (r.ok ? r.json() : null))
    .then((s: { calendar?: typeof serverCal } | null) => {
      if (s?.calendar) serverCal = s.calendar;
    })
    .catch(() => {});
  ctx.signal.addEventListener('abort', () => render(null, root));

  draw(); // paints at once from the cache
  refresh(true);
};
