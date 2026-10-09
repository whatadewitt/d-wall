// Fully Kiosk's JavaScript interface, the second wake signal (spec section 8).
// Needs "Enable JavaScript Interface" on in Fully Kiosk's settings. Event names are unconfirmed
// against the installed version; see docs/reports/milestone-0.md.
declare global {
  interface Window {
    fully?: { bind(event: string, code: string): void };
    __wallFully?: (event: string) => void;
  }
}

export const FULLY_EVENTS = ['screenOn', 'screenOff', 'onMotion'] as const;

export function bindFully(handler: (event: string) => void): boolean {
  if (typeof window.fully?.bind !== 'function') return false;
  window.__wallFully = handler;
  for (const ev of FULLY_EVENTS) window.fully.bind(ev, `window.__wallFully && window.__wallFully('${ev}')`);
  return true;
}
