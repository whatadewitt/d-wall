import type { CalEvent } from './cache';
import { addDays, diffDays, type Ymd } from './time';

const DAY_MIN = 24 * 60;
const MIN_VISUAL_MIN = 40; // short events still take room, so they count as at least this long when packing
export const MAX_LANES = 3;

export interface Block {
  ev: CalEvent;
  key: string;
  day: number;       // column index into the visible days
  startMin: number;
  endMin: number;
  col: number;       // side-by-side position within its overlap group
  cols: number;      // width of its overlap group
}

export interface Bar {
  ev: CalEvent;
  key: string;
  startCol: number;
  endCol: number;    // inclusive
  lane: number;
}

type Zone = (ms: number) => { date: Ymd; minutes: number };

const eventKey = (e: CalEvent) => `${e.calendarId}/${e.id}`;

// All-day events, and timed events of 24 hours or more, go in the all-day row. Everything
// else is a block in the hour grid, split at midnight when it crosses one.
export function isBar(e: CalEvent): boolean {
  return e.allDay || Date.parse(e.end) - Date.parse(e.start) >= DAY_MIN * 60_000;
}

export function layoutBars(events: CalEvent[], days: Ymd[], zone: Zone): { bars: Bar[]; lanes: number; hidden: number[] } {
  const first = days[0];
  const placed: Omit<Bar, 'lane'>[] = [];
  for (const e of events) {
    if (!isBar(e)) continue;
    let s: Ymd, last: Ymd;
    if (e.allDay) {
      s = e.start;
      last = addDays(e.end, -1);
    } else {
      s = zone(Date.parse(e.start)).date;
      const end = zone(Date.parse(e.end));
      last = end.minutes === 0 ? addDays(end.date, -1) : end.date;
    }
    const startCol = Math.max(0, diffDays(s, first));
    const endCol = Math.min(days.length - 1, diffDays(last, first));
    if (endCol < 0 || startCol > days.length - 1 || endCol < startCol) continue;
    placed.push({ ev: e, key: eventKey(e), startCol, endCol });
  }
  placed.sort((a, b) => a.startCol - b.startCol || b.endCol - b.startCol - (a.endCol - a.startCol));

  const laneEnds: number[] = [];
  const bars: Bar[] = [];
  const hidden = days.map(() => 0);
  for (const p of placed) {
    let lane = laneEnds.findIndex((end) => end < p.startCol);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = p.endCol;
    if (lane < MAX_LANES) bars.push({ ...p, lane });
    else for (let c = p.startCol; c <= p.endCol; c++) hidden[c]++;
  }
  return { bars, lanes: Math.min(laneEnds.length, MAX_LANES), hidden };
}

export function layoutBlocks(events: CalEvent[], days: Ymd[], zone: Zone): Block[] {
  const perDay: Omit<Block, 'col' | 'cols'>[][] = days.map(() => []);
  for (const e of events) {
    if (isBar(e)) continue;
    const s = zone(Date.parse(e.start));
    const en = zone(Date.parse(e.end));
    days.forEach((day, i) => {
      if (day < s.date || day > en.date) return;
      const startMin = day === s.date ? s.minutes : 0;
      const endMin = day === en.date ? en.minutes : DAY_MIN;
      if (endMin <= startMin && !(startMin === endMin && day === s.date && day === en.date)) return;
      perDay[i].push({ ev: e, key: `${eventKey(e)}@${day}`, day: i, startMin, endMin: Math.max(endMin, startMin) });
    });
  }

  // Overlapping events sit side by side: pack each group of overlaps into columns.
  const blocks: Block[] = [];
  for (const list of perDay) {
    list.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
    let group: Block[] = [];
    let colEnds: number[] = [];
    let groupEnd = -1;
    const close = () => {
      for (const b of group) b.cols = colEnds.length;
      blocks.push(...group);
      group = [];
      colEnds = [];
    };
    for (const item of list) {
      const visualEnd = Math.max(item.endMin, item.startMin + MIN_VISUAL_MIN);
      if (item.startMin >= groupEnd && group.length) close();
      let col = colEnds.findIndex((end) => end <= item.startMin);
      if (col === -1) col = colEnds.length;
      colEnds[col] = visualEnd;
      groupEnd = Math.max(group.length ? groupEnd : 0, visualEnd);
      group.push({ ...item, col, cols: 1 });
    }
    if (group.length) close();
  }
  return blocks;
}
