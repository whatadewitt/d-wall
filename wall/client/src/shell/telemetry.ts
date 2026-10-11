import { post } from './api';
import { subscriptionCount } from './events';
import { leakCount } from './host';
import { takeSignals } from './signals';
import { every, timerCount } from './timers';

const MB = 1024 * 1024;
const round = (n: number) => Math.round(n * 10) / 10;

// The 60 second heartbeat to POST /api/telemetry (spec section 11).
// Each sample's heap also goes to onHeap, for the heap watchdog.
export function startHeartbeat(
  read: () => { screen: string | null; state: string; soakCycles: number | null; lastSwitch: { screen: string; ms: number } | null },
  onHeap: (heapMB: number | null) => void,
): void {
  const send = () => {
    // performance.memory is non-standard; Chromium WebViews provide it.
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    const heapMB = mem ? round(mem.usedJSHeapSize / MB) : null;
    post('/api/telemetry', {
      ...read(),
      uptimeSec: Math.round(performance.now() / 1000),
      heapMB,
      heapLimitMB: mem ? round(mem.jsHeapSizeLimit / MB) : null,
      domNodes: document.getElementsByTagName('*').length,
      subs: subscriptionCount(),
      timers: timerCount(),
      leaks: leakCount(),
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, screenW: screen.width, screenH: screen.height },
      signals: takeSignals(),
    });
    onHeap(heapMB);
  };
  send();
  every(60_000, send);
}
