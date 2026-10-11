import type { ClientConfig } from './config';
import { every } from './timers';

export type IdleState = 'active' | 'idle' | 'off';

const QUIET_OFF_MS = 60_000;

// The idle clock (spec section 8): Active -> Idle after toIdleSec without touch, Idle -> Off
// after toOffMin more. In quiet hours Idle is skipped and the screen goes Off after 1 minute.
export function createIdleClock(opts: {
  idle: ClientConfig['idle'];
  paused: boolean;
  quiet(): boolean;
  onChange(state: IdleState, via: string): void;
}) {
  let state: IdleState = 'active';
  let lastTouch = Date.now();
  let wokeAt = 0;
  let held = false; // the doorbell popup holds the clock: nothing steps down while it is open

  const set = (next: IdleState, via: string) => {
    if (next === state) return;
    state = next;
    if (next === 'active') wokeAt = Date.now();
    opts.onChange(next, via);
  };

  every(1000, () => {
    if (opts.paused || held) return;
    if (state === 'off') return;
    const still = Date.now() - lastTouch;
    if (opts.quiet()) {
      if (still >= QUIET_OFF_MS) set('off', 'quiet');
      return;
    }
    const toIdle = opts.idle.toIdleSec * 1000;
    if (state === 'active' && still >= toIdle) set('idle', 'timer');
    else if (state === 'idle' && still >= toIdle + opts.idle.toOffMin * 60_000) set('off', 'timer');
  });

  return {
    get state() {
      return state;
    },
    // True for 400 ms after a wake: all touches are ignored (spec section 8).
    get justWoke() {
      return Date.now() - wokeAt < 400;
    },
    touch() {
      lastTouch = Date.now();
    },
    hold(on: boolean) {
      held = on;
      lastTouch = Date.now();
    },
    wake(via: string) {
      lastTouch = Date.now();
      set('active', via);
    },
  };
}
