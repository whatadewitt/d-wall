import type { Screen } from '../screens/types';
import type { ScreenHost } from './host';
import { every } from './timers';

const DWELL_MS = 2000;
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

// Soak harness (spec section 11): every 60 s, mount and unmount every registered screen in turn.
// A leak in any screen shows up as heap growth in the heartbeat log. The loop starts 30 s after
// boot so it never lines up with the heartbeat, which then always samples a settled screen.
export function startSoak(host: ScreenHost, screens: readonly Screen[]): () => number {
  let cycles = 0;
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      for (const [i, s] of screens.entries()) {
        if (i > 0) await sleep(DWELL_MS);
        await host.show(s);
      }
      cycles++;
    } finally {
      running = false;
    }
  };
  window.setTimeout(() => {
    void cycle();
    every(60_000, cycle);
  }, 30_000);
  return () => cycles;
}
