// The home screen (spec section 14): room chips, a grid of device tiles, one tap to control.
// Lights and plugs change at once and revert with an error mark if the real state hasn't
// confirmed within 2 s. Locks, garage doors and the alarm need press-and-hold, then Confirm.
import { render } from 'preact';
import type { Mount } from '../types';
import { HomeView, RISKY, type Device, type DeviceState, type Room, type Sheet } from './view';
import './home.css';

const CONFIRM_MS = 2000;       // section 14: tile reverts if not confirmed in 2 s
const SLOW_CONFIRM_MS = 15_000; // locks and doors move slowly; any change from Home Assistant confirms
const ERROR_SHOW_MS = 4000;
const HOLD_LIGHT_MS = 500;     // brightness slider
const HOLD_RISKY_MS = 1000;    // then Confirm
const RETURN_MS = 60_000;      // back to home after a minute without touch
const SWIPE_PX = 80;

const known: { rooms: Room[]; connected: boolean } = { rooms: [], connected: false }; // paints at once on return

interface Pending { optimistic: Partial<DeviceState>; confirmed(s: DeviceState): boolean; until: number }

export const mount: Mount = (root, ctx) => {
  const { config } = ctx;
  const homeScreen = config.screens[0];
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: config.clock === '12h', timeZone: config.timezone });
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: config.timezone });

  const states = new Map<string, DeviceState>();
  const pending = new Map<string, Pending>();
  const errors = new Map<string, number>();
  let room = 0;
  let sheet: Sheet | null = null;
  let hint: { text: string; until: number } | null = null;
  let lastTouch = Date.now();

  const index = () => {
    states.clear();
    for (const r of known.rooms) for (const d of r.devices) states.set(d.id, d.state);
  };
  index();

  const display = (d: Device): DeviceState => ({ ...(states.get(d.id) ?? d.state), ...(pending.get(d.id)?.optimistic ?? {}) });

  function failed(id: string): void {
    pending.delete(id);
    errors.set(id, Date.now() + ERROR_SHOW_MS);
    draw();
  }

  async function send(d: Device, cmd: Record<string, unknown>, p?: Omit<Pending, 'until'>, windowMs = CONFIRM_MS): Promise<void> {
    if (p) pending.set(d.id, { ...p, until: Date.now() + windowMs });
    errors.delete(d.id);
    draw();
    try {
      const res = await ctx.fetch(`/api/home/devices/${encodeURIComponent(d.id)}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cmd),
      });
      if (!res.ok) failed(d.id);
    } catch {
      if (!ctx.signal.aborted) failed(d.id);
    }
  }

  // A plain tap: toggle, run a scene, open or close a blind.
  function tap(d: Device): void {
    const s = display(d);
    switch (d.type) {
      case 'light':
      case 'switch':
      case 'fan':
      case 'media_player': {
        const next = s.state === 'on' || s.state === 'playing' ? 'off' : 'on';
        void send(d, { type: 'toggle' }, { optimistic: { state: next }, confirmed: (n) => (next === 'on' ? n.state !== 'off' : n.state === 'off') });
        return;
      }
      case 'scene':
        void send(d, { type: 'scene' }, { optimistic: {}, confirmed: () => true });
        return;
      case 'cover':
        void send(d, { type: 'toggle' }, { optimistic: {}, confirmed: () => true }, SLOW_CONFIRM_MS);
        return;
    }
  }

  function confirmFor(d: Device): Sheet {
    const s = display(d).state;
    if (d.type === 'lock') return { kind: 'confirm', device: d, label: s === 'locked' ? 'Unlock' : 'Lock', on: s !== 'locked' };
    if (d.type === 'garage') return { kind: 'confirm', device: d, label: s === 'closed' ? 'Open' : 'Close', on: s === 'closed' };
    return { kind: 'confirm', device: d, label: s === 'disarmed' ? 'Arm' : 'Disarm', on: s === 'disarmed' };
  }

  // Press-and-hold timing on a tile; a drag (a room swipe) is never a tap.
  let press: { id: string; t: number; x: number; y: number } | null = null;
  let swipe: { id: number; x: number; y: number } | null = null;

  function draw(): void {
    const now = Date.now();
    render(
      <HomeView
        rooms={known.rooms}
        room={Math.min(room, Math.max(0, known.rooms.length - 1))}
        connected={known.connected}
        time={time.format(now)}
        date={date.format(now)}
        display={display}
        pending={new Set(pending.keys())}
        errors={new Set(errors.keys())}
        hint={hint && hint.until > now ? hint.text : null}
        sheet={sheet}
        on={{
          room: (i) => {
            room = i;
            draw();
          },
          tileDown: (d, e) => {
            press = { id: d.id, t: e.timeStamp, x: e.clientX, y: e.clientY };
          },
          tileUp: (d, e) => {
            const p = press;
            press = null;
            if (!p || p.id !== d.id || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 12) return;
            const held = e.timeStamp - p.t;
            if (RISKY.includes(d.type)) {
              if (held >= HOLD_RISKY_MS) sheet = confirmFor(d);
              else hint = { text: 'Press and hold to unlock, open or disarm', until: Date.now() + 3000 };
              return draw();
            }
            // Only dimmable lights (the light domain) get the slider; a Kasa on/off switch shown as a light just toggles.
            if (d.type === 'light' && d.id.startsWith('light.') && held >= HOLD_LIGHT_MS) {
              sheet = { kind: 'brightness', device: d, value: display(d).brightness ?? 100 };
              return draw();
            }
            tap(d);
          },
          step: (d, delta) => {
            const target = Math.round(((display(d).target ?? 20) + delta) * 2) / 2;
            void send(d, { type: 'temperature', value: target }, { optimistic: { target }, confirmed: (n) => n.target === target });
          },
          sheetBrightness: (value, commit) => {
            if (!sheet || sheet.kind !== 'brightness') return;
            sheet = { ...sheet, value };
            if (commit) {
              const d = sheet.device;
              void send(d, { type: 'brightness', pct: value }, { optimistic: { state: 'on', brightness: value }, confirmed: (n) => Math.abs((n.brightness ?? -99) - value) <= 2 });
            } else draw();
          },
          confirm: () => {
            if (!sheet || sheet.kind !== 'confirm') return;
            const { device, on } = sheet;
            sheet = null;
            void send(device, { type: on ? 'on' : 'off' }, { optimistic: {}, confirmed: () => true }, SLOW_CONFIRM_MS);
          },
          closeSheet: () => {
            sheet = null;
            draw();
          },
          // Horizontal swipe moves to the next or previous room.
          grid: {
            onPointerDown: (e: PointerEvent) => {
              if (e.isPrimary) swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
            },
            onPointerUp: (e: PointerEvent) => {
              const s = swipe;
              swipe = null;
              if (!s || s.id !== e.pointerId || !known.rooms.length) return;
              const dx = e.clientX - s.x;
              if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(e.clientY - s.y)) return;
              room = (room + (dx < 0 ? 1 : -1) + known.rooms.length) % known.rooms.length;
              draw();
            },
            onPointerCancel: () => {
              swipe = null;
            },
          },
        }}
      />,
      root,
    );
  }

  function tick(): void {
    const now = Date.now();
    if (now - lastTouch >= RETURN_MS && homeScreen !== 'home' && !sheet) return ctx.go(homeScreen);
    for (const [id, p] of pending) if (p.until <= now) failed(id); // not confirmed in time: revert, mark
    for (const [id, until] of errors) if (until <= now) errors.delete(id);
    draw();
  }

  root.addEventListener('pointerdown', () => {
    lastTouch = Date.now();
  }, { capture: true, passive: true });

  ctx.subscribe('home.changed', (msg) => {
    for (const s of (msg as { devices?: DeviceState[] }).devices ?? []) {
      states.set(s.id, s);
      const p = pending.get(s.id);
      if (p && p.confirmed(s)) pending.delete(s.id);
      if (!s.available) pending.delete(s.id);
    }
    known.connected = [...states.values()].some((st) => st.available);
    draw();
  });
  ctx.every(500, tick);
  ctx.signal.addEventListener('abort', () => render(null, root));

  draw();
  ctx
    .fetch('/api/home/devices')
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { rooms: Room[]; connected: boolean } | null) => {
      if (!data) return;
      known.rooms = data.rooms;
      known.connected = data.connected;
      index();
      draw();
    })
    .catch(() => {});
};
