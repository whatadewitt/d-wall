import type { RefObject } from 'preact';
import type { CalEvent } from './cache';
import { layoutBars, layoutBlocks, MAX_LANES, type Block } from './layout';
import { addDays, clockLabel, dayLabel, dayNumber, hourLabel, weekdayLabel, type Ymd } from './time';

export type Shape = 'circle' | 'square' | 'diamond' | 'triangle';
export const SHAPES: Shape[] = ['circle', 'square', 'diamond', 'triangle'];
export interface CalInfo { id: string; name: string; color: string; shape: Shape }

export interface ViewProps {
  mode: 'week' | 'day';
  title: string;
  days: Ymd[];
  today: Ymd;
  nowMin: number;
  events: CalEvent[];
  calendars: CalInfo[];
  calById: Map<string, CalInfo>;
  clock: '12h' | '24h';
  zone: (ms: number) => { date: Ymd; minutes: number };
  staleSince: string | null;
  canPrev: boolean;
  canNext: boolean;
  sheet: CalEvent | null;
  refs: { card: RefObject<HTMLElement>; pane: RefObject<HTMLDivElement>; scroll: RefObject<HTMLDivElement> };
  on: {
    prev(): void;
    next(): void;
    today(): void;
    week(): void;
    day(d: Ymd): void;
    open(e: CalEvent): void;
    close(): void;
    touch(): void;
    pointer: {
      onPointerDown(e: PointerEvent): void;
      onPointerMove(e: PointerEvent): void;
      onPointerUp(e: PointerEvent): void;
      onPointerCancel(e: PointerEvent): void;
      onClickCapture(e: MouseEvent): void;
    };
  };
}

const calStyle = (info?: CalInfo) => (info ? `--cal: ${info.color}` : '');
const ShapeMark = ({ shape }: { shape?: Shape }) => <span class={`shape shape-${shape ?? 'circle'}`} aria-hidden="true" />;

const ChevronLeft = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6l-6 6 6 6" /></svg>
);
const ChevronRight = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 6l6 6-6 6" /></svg>
);

function Header(p: ViewProps) {
  return (
    <header class="cal-head">
      <div class="cal-head__nav">
        <h1 class="cal-title">{p.title}</h1>
        <button type="button" class="cal-round" aria-label={p.mode === 'week' ? 'Previous week' : 'Previous day'} disabled={!p.canPrev} onClick={p.on.prev}><ChevronLeft /></button>
        <button type="button" class="cal-round" aria-label={p.mode === 'week' ? 'Next week' : 'Next day'} disabled={!p.canNext} onClick={p.on.next}><ChevronRight /></button>
        <button type="button" class="cal-pill" onClick={p.on.today}>Today</button>
        {p.mode === 'day' && <button type="button" class="cal-pill" onClick={p.on.week}>Week</button>}
        {p.staleSince && <span class="cal-stale">Not updated since {p.staleSince}</span>}
      </div>
      <div class="cal-head__side">
        <div class="cal-legend">
          {p.calendars.map((c) => (
            <span class="cal-legend__item" style={calStyle(c)}><ShapeMark shape={c.shape} />{c.name}</span>
          ))}
        </div>
        <div class="cal-clock">
          <div class="cal-clock__time">{clockLabel(p.nowMin, p.clock, true)}</div>
          <div class="cal-clock__date">{dayLabel(p.today)}</div>
        </div>
      </div>
    </header>
  );
}

function DayHeads(p: ViewProps) {
  return (
    <div class="cal-days cal-cols">
      <div />
      {p.days.map((d) => {
        const label = (
          <>
            <span class="cal-day__name">{weekdayLabel(d)}</span>
            <span class="cal-day__num">{dayNumber(d)}</span>
          </>
        );
        return p.mode === 'week' ? (
          <button type="button" class="cal-day" data-today={d === p.today || undefined} onClick={() => p.on.day(d)}>{label}</button>
        ) : (
          <div class="cal-day" data-today={d === p.today || undefined}>{label}</div>
        );
      })}
    </div>
  );
}

function AllDay(p: ViewProps) {
  const { bars, lanes, hidden } = layoutBars(p.events, p.days, p.zone);
  const more = hidden.some((n) => n > 0);
  const n = p.days.length;
  return (
    <div class="cal-allday cal-cols" style={`--lanes: ${Math.max(lanes, 1) + (more ? 1 : 0)}`}>
      <div class="cal-allday__label">all day</div>
      <div class="cal-allday__lanes">
        {bars.map((b) => {
          const info = p.calById.get(b.ev.calendarId);
          return (
            <button
              type="button"
              class="cal-chip"
              style={`${calStyle(info)}; left: calc(${b.startCol / n} * 100% + var(--sp-4)); width: calc(${(b.endCol - b.startCol + 1) / n} * 100% - var(--sp-8)); top: calc(${b.lane} * var(--lane) + var(--sp-4))`}
              onClick={() => p.on.open(b.ev)}
            >
              <ShapeMark shape={info?.shape} />
              <span class="cal-chip__title">{b.ev.title}</span>
            </button>
          );
        })}
        {hidden.map((count, c) =>
          count ? (
            <span class="cal-more" style={`left: calc(${c / n} * 100%); width: calc(${1 / n} * 100%); top: calc(${MAX_LANES} * var(--lane) + var(--sp-4))`}>+{count}</span>
          ) : null,
        )}
      </div>
    </div>
  );
}

function EventBlock({ b, p }: { b: Block; p: ViewProps }) {
  const info = p.calById.get(b.ev.calendarId);
  const dur = b.endMin - b.startMin;
  const past = p.days[b.day] === p.today && b.endMin <= p.nowMin;
  return (
    <button
      type="button"
      class="cal-event"
      data-past={past || undefined}
      style={`${calStyle(info)}; top: calc(var(--hour) * ${b.startMin / 60}); height: max(calc(var(--hour) * ${dur / 60} - var(--sp-2)), var(--event-min)); left: calc(var(--sp-4) + (100% - var(--sp-8)) * ${b.col / b.cols}); width: calc((100% - var(--sp-8)) / ${b.cols} - var(--sp-2))`}
      onClick={() => p.on.open(b.ev)}
    >
      <span class="cal-event__title"><ShapeMark shape={info?.shape} /><span class="cal-event__text">{b.ev.title}</span></span>
      {dur >= 75 && <span class="cal-event__time">{clockLabel(b.startMin, p.clock, false)} – {clockLabel(b.endMin, p.clock, false)}</span>}
    </button>
  );
}

function Grid(p: ViewProps) {
  const blocks = layoutBlocks(p.events, p.days, p.zone);
  const todayCol = p.days.indexOf(p.today);
  const nowTop = `calc(var(--hour) * ${p.nowMin / 60})`;
  return (
    <div class="cal-scroll" ref={p.refs.scroll}>
      <div class="cal-grid cal-cols">
        <div class="cal-gutter">
          {Array.from({ length: 24 }, (_, h) => (h === 0 ? null : <span class="cal-hour" style={`top: calc(var(--hour) * ${h})`}>{hourLabel(h, p.clock)}</span>))}
        </div>
        {p.days.map((d, i) => (
          <div class="cal-col" data-today={d === p.today || undefined}>
            {blocks.filter((b) => b.day === i).map((b) => <EventBlock key={b.key} b={b} p={p} />)}
            {i === todayCol && (
              <>
                <div class="cal-now" style={`top: ${nowTop}`} />
                <div class="cal-now__dot" style={`top: ${nowTop}`} />
              </>
            )}
          </div>
        ))}
        {todayCol >= 0 && <span class="cal-now__pill" style={`top: ${nowTop}`}>{clockLabel(p.nowMin, p.clock, false)}</span>}
      </div>
    </div>
  );
}

function when(e: CalEvent, p: ViewProps): string {
  if (e.allDay) {
    const last = addDays(e.end, -1);
    return last === e.start ? dayLabel(e.start) : `${dayLabel(e.start)} – ${dayLabel(last)}`;
  }
  const s = p.zone(Date.parse(e.start));
  const en = p.zone(Date.parse(e.end));
  if (s.date === en.date) return `${dayLabel(s.date)} · ${clockLabel(s.minutes, p.clock, true)} – ${clockLabel(en.minutes, p.clock, true)}`;
  return `${dayLabel(s.date)}, ${clockLabel(s.minutes, p.clock, true)} – ${dayLabel(en.date)}, ${clockLabel(en.minutes, p.clock, true)}`;
}

function Sheet({ e, p }: { e: CalEvent; p: ViewProps }) {
  const info = p.calById.get(e.calendarId);
  const desc = e.description.length > 300 ? `${e.description.slice(0, 300).trimEnd()}…` : e.description;
  return (
    <div class="cal-scrim" onClick={p.on.close}>
      <div class="cal-sheet" role="dialog" aria-label={e.title} style={calStyle(info)} onClick={(ev) => ev.stopPropagation()}>
        <div class="cal-sheet__cal"><ShapeMark shape={info?.shape} />{info?.name ?? e.calendarId}</div>
        <h2 class="cal-sheet__title">{e.title}</h2>
        <div class="cal-sheet__row">{when(e, p)}</div>
        {e.location && <div class="cal-sheet__row">{e.location}</div>}
        {desc && <p class="cal-sheet__desc">{desc}</p>}
      </div>
    </div>
  );
}

export function CalendarView(p: ViewProps) {
  return (
    <div class="cal" data-mode={p.mode} onPointerDownCapture={p.on.touch}>
      <Header {...p} />
      <section class="cal-card" ref={p.refs.card} style={`--days: ${p.days.length}`} {...p.on.pointer}>
        <div class="cal-pane" ref={p.refs.pane}>
          <DayHeads {...p} />
          <AllDay {...p} />
          <Grid {...p} />
        </div>
      </section>
      {p.sheet && <Sheet e={p.sheet} p={p} />}
    </div>
  );
}
