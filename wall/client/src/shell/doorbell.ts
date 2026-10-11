import type { Screen } from '../screens/types';
import type { ServerSnapshot } from './config';
import { emit } from './events';
import type { ScreenHost } from './host';
import { playDing } from './sound';
import { every } from './timers';

// The doorbell popup's lifecycle (spec section 7). The shell owns when it opens and closes; the
// overlay module (overlays/doorbell) draws it and runs the live video. The popup follows state as
// well as the event: a page that was asleep or reconnecting opens it from /api/state, silently.

const ACTIVE_MS = 45_000; // the server's activeUntil window, used until its `state` refines it
const TOUCH_MS = 30_000;  // a touch on the panel keeps it open 30 s from that touch
const MAX_MS = 180_000;   // up to 3 minutes in total

// What the overlay receives on the local `doorbell.popup` topic (null when it closes).
// Times are this page's clock (Date.now()).
export interface PopupMessage {
  at: string;          // the ring, server time
  cameraId: string;
  until: number;
  resetAt: number;     // when `until` was last set, for the countdown bar
  beneath: string | null; // ctx.go(beneath) closes the popup and keeps that screen
  timing: { via: 'event' | 'state'; from: string; receivedAt: number; skew: number; sound: string };
}

export function createDoorbell(o: {
  host: ScreenHost;
  screen: Screen;
  sound: boolean;
  quiet(): boolean;
  tabletState(): string;
  wake(): void;          // wake the tablet and make sure a screen is mounted beneath
  beneath(): string | null;
  hold(on: boolean): void;
  skew(): number;        // server clock minus this page's clock, ms
}) {
  let popup: (PopupMessage & { capAt: number }) | null = null;
  let handled: string | null = null; // the last ring shown or dismissed, so `state` never reopens it
  let stopTick: (() => void) | null = null;

  const send = () => {
    if (!popup) return;
    const { capAt: _, ...msg } = popup;
    emit('doorbell.popup', { ...msg, beneath: o.beneath() });
  };

  // Missed rings stay silent: only a ring this page hears live dings, and not in quiet hours.
  const ding = (): string => (!o.sound ? 'off' : o.quiet() ? 'quiet' : playDing());

  function open(at: string, cameraId: string, remaining: number, via: 'event' | 'state', sound: string): void {
    const receivedAt = Date.now();
    const from = o.tabletState();
    handled = at;
    o.wake();
    popup = {
      at,
      cameraId,
      until: receivedAt + remaining,
      resetAt: receivedAt,
      capAt: receivedAt + MAX_MS,
      beneath: null,
      timing: { via, from, receivedAt, skew: o.skew(), sound },
    };
    o.hold(true);
    stopTick = every(1000, () => {
      if (popup && Date.now() >= popup.until) close();
    });
    void o.host.show(o.screen).then(send);
  }

  // A second ring while it is open extends it (the server already ignores rings within 10 s).
  function extend(at: string, cameraId: string, remaining: number): void {
    if (!popup) return;
    const now = Date.now();
    handled = at;
    popup.at = at;
    popup.cameraId = cameraId || popup.cameraId;
    popup.until = Math.max(popup.until, now + remaining);
    popup.capAt = now + MAX_MS;
    popup.resetAt = now;
    send();
  }

  function close(): boolean {
    o.host.unmount();
    if (!popup) return false;
    popup = null;
    stopTick?.();
    stopTick = null;
    emit('doorbell.popup', null);
    o.hold(false); // also restarts the idle clock, so the screen does not go straight back to sleep
    return true;
  }

  return {
    get open() {
      return popup !== null;
    },
    close,

    // A live `doorbell.ring` event.
    ring(msg: unknown): void {
      const r = msg as { cameraId?: string; at?: string } | null;
      if (!r?.at) return;
      if (popup) {
        if (popup.at !== r.at) {
          ding();
          extend(r.at, r.cameraId ?? '', ACTIVE_MS);
        }
        return;
      }
      if (handled === r.at) return;
      const sound = ding();
      open(r.at, r.cameraId ?? '', ACTIVE_MS, 'event', sound);
    },

    // A `state` snapshot: on connect, reconnect, or any change on the server.
    state(msg: unknown): void {
      const s = msg as ServerSnapshot | null;
      const d = s?.doorbell;
      if (!s || !d?.activeUntil || !d.at) return;
      const remaining = Date.parse(d.activeUntil) - Date.parse(s.serverTime);
      if (!(remaining > 0)) return;
      if (popup) {
        if (popup.at !== d.at) extend(d.at, d.cameraId ?? '', remaining);
        else if (Date.now() + remaining > popup.until) {
          popup.until = Date.now() + remaining;
          send();
        }
        return;
      }
      if (handled === d.at) return;
      open(d.at, d.cameraId ?? '', remaining, 'state', 'none');
    },

    // A touch on the panel: 30 s from now, never shorter than it already was, capped at 3 minutes.
    touched(): void {
      if (!popup) return;
      const now = Date.now();
      const next = Math.min(Math.max(popup.until, now + TOUCH_MS), popup.capAt);
      if (next === popup.until) return;
      popup.until = next;
      popup.resetAt = now;
      send();
    },
  };
}
