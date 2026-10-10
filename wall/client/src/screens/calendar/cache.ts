// The last calendar events, kept in this module so they survive unmount (spec section 4,
// "Switch speed"): the visible week plus one either side, never more.
import type { Ymd } from './time';

export interface CalEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
}

export const weeks = new Map<Ymd, CalEvent[]>();
export const contact = { last: 0 }; // last successful fetch from the server, for the stale note

export function keepOnly(keys: Ymd[]): void {
  for (const k of [...weeks.keys()]) if (!keys.includes(k)) weeks.delete(k);
}
