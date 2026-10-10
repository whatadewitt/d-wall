import { render } from 'preact';
import { registry } from '../screens/registry';
import type { Screen } from '../screens/types';
import { getState, post } from './api';
import type { ServerSnapshot } from './config';
import { connect, emit } from './events';
import { bindFully } from './fully';
import { ScreenHost } from './host';
import { createIdleClock, type IdleState } from './idle';
import { Rail } from './rail';
import { signal } from './signals';
import { startSoak } from './soak';
import { startHeartbeat } from './telemetry';

const RETRY_SEC = [1, 2, 5, 10, 30];

async function firstState(app: HTMLElement): Promise<ServerSnapshot> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getState();
    } catch {
      app.textContent = 'Connecting to the wall server…';
      await new Promise((r) => window.setTimeout(r, RETRY_SEC[Math.min(attempt, RETRY_SEC.length - 1)] * 1000));
    }
  }
}

export async function boot(app: HTMLElement): Promise<void> {
  signal('boot');
  const { config } = await firstState(app);

  app.textContent = '';
  const rail = el('nav', 'rail');
  rail.setAttribute('aria-label', 'Screens');
  const stage = el('main', 'stage');
  const overlayLayer = el('div', 'overlay-layer');
  app.append(rail, stage, overlayLayer);
  if (config.soak) app.append(Object.assign(el('div', 'soak-badge'), { textContent: 'SOAK' }));

  const byId = new Map(registry.map((s) => [s.id, s]));
  const railScreens = config.screens.flatMap((id) => {
    const s = byId.get(id);
    if (!s) console.warn(`config.yaml lists screen "${id}" but it is not in the registry`);
    return s ? [s] : [];
  });
  const home: Screen = railScreens[0] ?? registry[0];

  const deps = { config, go, touch: () => idle.touch() };
  const main = new ScreenHost('main', stage, deps);
  const overlay = new ScreenHost('overlay', overlayLayer, deps);

  const drawRail = () => render(<Rail screens={railScreens} active={main.currentId} onSelect={go} />, rail);

  // Time from a switch to the first frame after mount, sent with the heartbeat (section 11 switch targets).
  let lastSwitch: { screen: string; ms: number } | null = null;

  function go(id: string): void {
    const s = byId.get(id);
    if (!s) return console.warn(`go(): no screen "${id}"`);
    const started = performance.now();
    overlay.unmount();
    void main.show(s).then(() => {
      drawRail();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (main.currentId === id) lastSwitch = { screen: id, ms: Math.round(performance.now() - started) };
      }));
    });
    drawRail();
  }

  // Idle clock. In soak mode it is paused so the loop runs all night with the screen on.
  const idle = createIdleClock({
    idle: config.idle,
    paused: config.soak,
    onChange(state: IdleState, via: string) {
      document.body.dataset.state = state;
      post('/api/state', { state, via });
      if (state === 'off') {
        overlay.unmount();
        main.unmount(); // free memory before the server turns the screen off
        drawRail();
      } else if (state === 'active' && !main.currentId) {
        go(home.id); // wake from Off lands on home
      }
    },
  });
  document.body.dataset.state = idle.state;

  // One passive capture listener resets the idle clock on any touch. The first touch after
  // Idle or Off only wakes, and every touch in the 400 ms after a wake is dropped (section 8).
  let eatClick = false;
  const swallow = (e: Event) => {
    e.stopPropagation();
    eatClick = true;
  };
  document.addEventListener('pointerdown', (e) => {
    if (idle.state !== 'active') {
      signal('touch');
      idle.wake('touch');
      return swallow(e);
    }
    if (idle.justWoke) return swallow(e);
    eatClick = false;
    idle.touch();
  }, { capture: true, passive: true });
  for (const type of ['pointerup', 'touchstart', 'touchend'] as const) {
    document.addEventListener(type, (e) => {
      if (idle.justWoke) e.stopPropagation();
    }, { capture: true, passive: true });
  }
  document.addEventListener('click', (e) => {
    if (eatClick || idle.justWoke) {
      e.stopPropagation();
      e.preventDefault();
      eatClick = false;
    }
  }, { capture: true });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // Wake signals. The page becoming visible is the primary one; Fully Kiosk's JavaScript
  // interface events are recorded alongside it for the milestone 0 spike.
  document.addEventListener('visibilitychange', () => {
    signal(document.visibilityState);
    if (document.visibilityState === 'visible' && idle.state === 'off') idle.wake('visibility');
  });
  const hasFully = bindFully((ev) => {
    signal(`fully:${ev}`);
    if ((ev === 'screenOn' || ev === 'onMotion') && idle.state === 'off') idle.wake(`fully:${ev}`);
  });
  if (!hasFully) signal('fully:unavailable');

  // The event stream. Every (re)connect refetches /api/state and hands it to `state` subscribers.
  connect(() => {
    getState().then((s) => emit('state', s), () => {});
  });

  const soakCycles = config.soak ? startSoak(main, registry) : null;
  startHeartbeat(() => ({ screen: main.currentId, state: idle.state, soakCycles: soakCycles?.() ?? null, lastSwitch }));

  post('/api/state', { state: 'active', via: 'boot' });
  go(home.id);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
