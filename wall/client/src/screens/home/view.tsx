import { TileIcon } from './icons';

export type HomeType = 'light' | 'switch' | 'fan' | 'scene' | 'climate' | 'cover' | 'garage' | 'media_player' | 'lock' | 'alarm' | 'sensor';
export interface DeviceState { id: string; state: string; available: boolean; brightness?: number; current?: number; target?: number; unit?: string; action?: string }
export interface Device { id: string; name: string; type: HomeType; state: DeviceState }
export interface Room { name: string; devices: Device[] }

export type Sheet =
  | { kind: 'brightness'; device: Device; value: number }
  | { kind: 'confirm'; device: Device; label: string; on: boolean };

export const RISKY: HomeType[] = ['lock', 'garage', 'alarm'];
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : s);
const deg = (n?: number) => (n === undefined ? '–' : `${Number.isInteger(n) ? n : n.toFixed(1)}°`);

// Whether a tile reads as "on" (accent tint).
export function isOn(d: Device, s: DeviceState): boolean {
  switch (d.type) {
    case 'light': case 'switch': case 'fan': return s.state === 'on';
    case 'media_player': return s.state === 'playing' || s.state === 'on';
    case 'cover': case 'garage': return s.state === 'open' || s.state === 'opening';
    case 'lock': return s.state === 'unlocked' || s.state === 'unlocking' || s.state === 'open';
    case 'alarm': return s.state.startsWith('armed') || s.state === 'triggered' || s.state === 'arming';
    default: return false;
  }
}

function stateText(d: Device, s: DeviceState, pending: boolean): string {
  if (!s.available) return 'Unavailable';
  if (d.type === 'scene') return pending ? 'Running…' : 'Tap to run';
  if (d.type === 'sensor') return s.current !== undefined ? `${s.current}${s.unit ? ` ${s.unit}` : ''}` : cap(s.state);
  if (d.type === 'light' && s.state === 'on' && s.brightness !== undefined) return `On · ${s.brightness}%`;
  if (d.type === 'climate') return s.action ? cap(s.action) : cap(s.state);
  return cap(s.state);
}

export interface ViewProps {
  rooms: Room[];
  room: number;
  connected: boolean;
  time: string;
  date: string;
  display(d: Device): DeviceState;
  pending: Set<string>;
  errors: Set<string>;
  hint: string | null;
  sheet: Sheet | null;
  on: {
    room(i: number): void;
    tileDown(d: Device, e: PointerEvent): void;
    tileUp(d: Device, e: PointerEvent): void;
    step(d: Device, delta: number): void;
    sheetBrightness(value: number, commit: boolean): void;
    confirm(): void;
    closeSheet(): void;
    grid: Record<string, (e: PointerEvent) => void>;
  };
}

function Tile({ d, p }: { d: Device; p: ViewProps }) {
  const s = p.display(d);
  const pending = p.pending.has(d.id);
  const body = (
    <>
      <span class="home-tile__top">
        <TileIcon type={d.type} />
        {p.errors.has(d.id) && <span class="home-tile__error">Didn't respond</span>}
      </span>
      <span class="home-tile__name">{d.name}</span>
      {d.type === 'climate' ? (
        <span class="home-climate">
          <span class="home-climate__now">{deg(s.current)}</span>
          <span class="home-climate__set">
            <button type="button" class="home-step" aria-label={`Lower ${d.name}`} disabled={!s.available} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); p.on.step(d, -0.5); }}>−</button>
            <span>Set {deg(s.target)}</span>
            <button type="button" class="home-step" aria-label={`Raise ${d.name}`} disabled={!s.available} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); p.on.step(d, 0.5); }}>+</button>
          </span>
        </span>
      ) : (
        <span class="home-tile__state">{pending && d.type !== 'scene' && RISKY.includes(d.type) ? 'Sending…' : stateText(d, s, pending)}</span>
      )}
      {RISKY.includes(d.type) && <span class="home-hold" aria-hidden="true" />}
    </>
  );
  const attrs = {
    class: 'home-tile',
    'data-type': d.type,
    'data-on': isOn(d, s) || undefined,
    'data-off': !s.available || undefined,
    'data-pending': pending || undefined,
  };
  if (d.type === 'sensor' || d.type === 'climate') return <div {...attrs}>{body}</div>;
  return (
    <button type="button" {...attrs} disabled={!s.available} onPointerDown={(e) => p.on.tileDown(d, e)} onPointerUp={(e) => p.on.tileUp(d, e)}>
      {body}
    </button>
  );
}

function SheetView({ sheet, p }: { sheet: Sheet; p: ViewProps }) {
  return (
    <div class="home-scrim" onClick={p.on.closeSheet}>
      <div class="home-sheet" role="dialog" aria-label={sheet.device.name} onClick={(e) => e.stopPropagation()}>
        <div class="home-sheet__title">{sheet.device.name}</div>
        {sheet.kind === 'brightness' ? (
          <>
            <div class="home-sheet__value">{sheet.value}%</div>
            <input
              class="home-slider"
              type="range"
              min="1"
              max="100"
              value={sheet.value}
              aria-label="Brightness"
              onInput={(e) => p.on.sheetBrightness(Number((e.target as HTMLInputElement).value), false)}
              onChange={(e) => p.on.sheetBrightness(Number((e.target as HTMLInputElement).value), true)}
            />
          </>
        ) : (
          <>
            <div class="home-sheet__text">{sheet.label} {sheet.device.name}?</div>
            <div class="home-sheet__actions">
              <button type="button" class="home-pill" onClick={p.on.closeSheet}>Cancel</button>
              <button type="button" class="home-pill home-pill--go" onClick={p.on.confirm}>{sheet.label}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function HomeView(p: ViewProps) {
  const room = p.rooms[p.room];
  return (
    <div class="home">
      <header class="home-head">
        <div class="home-head__title">
          <h1 class="home-title">Home</h1>
          {!p.connected && <span class="home-note">Home Assistant unavailable</span>}
          {p.hint && <span class="home-note">{p.hint}</span>}
        </div>
        <div class="home-clock">
          <div class="home-clock__time">{p.time}</div>
          <div class="home-clock__date">{p.date}</div>
        </div>
      </header>
      <nav class="home-rooms" aria-label="Rooms">
        {p.rooms.map((r, i) => (
          <button type="button" class="home-pill" aria-current={i === p.room ? 'true' : undefined} onClick={() => p.on.room(i)}>{r.name}</button>
        ))}
      </nav>
      <section class="home-grid" aria-label={room?.name ?? 'Devices'} {...p.on.grid}>
        {room?.devices.map((d) => <Tile key={d.id} d={d} p={p} />)}
        {!p.rooms.length && <div class="home-empty">No devices yet. Add rooms under home: in config.yaml.</div>}
      </section>
      {p.sheet && <SheetView sheet={p.sheet} p={p} />}
    </div>
  );
}
