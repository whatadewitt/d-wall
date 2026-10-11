import { post } from './api';
import { every } from './timers';

const LIMIT = 1.5;   // times the budget
const STRIKES = 3;   // heartbeats in a row

// Heap watchdog (spec section 11). If the JS heap stays above 1.5 times the budget for three
// heartbeats in a row, the page reloads itself at the next quiet moment: never during the doorbell
// popup, never within 10 s of a touch. It also waits until the event stream is live, so a reload
// cannot land on an error page while the server is down. Returns the heartbeat's sample hook.
export function createHeapWatchdog(o: {
  budgetMB(): number;
  quiet(): boolean;
  online(): boolean;
}): (heapMB: number | null) => void {
  let strikes = 0;
  let armed = false;
  return (heapMB) => {
    if (heapMB === null || armed) return; // performance.memory missing: nothing to watch
    const budgetMB = o.budgetMB();
    if (heapMB <= budgetMB * LIMIT) {
      strikes = 0;
      return;
    }
    if (++strikes < STRIKES) return;
    armed = true;
    const stop = every(1000, () => {
      if (!o.quiet() || !o.online()) return;
      stop();
      post('/api/telemetry', { watchdog: { reason: 'heap', heapMB, budgetMB } });
      window.setTimeout(() => location.reload(), 500); // the report goes first; it is sent with keepalive
    });
  };
}
