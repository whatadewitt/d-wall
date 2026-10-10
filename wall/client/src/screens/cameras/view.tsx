import type { RefObject } from 'preact';

export interface CamInfo { id: string; name: string; doorbell: boolean }
export interface TileState {
  slots: [string | null, string | null]; // two stacked images per tile avoid flicker (section 6)
  front: 0 | 1;
  refs: [RefObject<HTMLImageElement>, RefObject<HTMLImageElement>];
  frameAt: number;
}

const Bell = () => (
  <svg class="cam-bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4" /></svg>
);
const Close = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
);
const ChevronLeft = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6l-6 6 6 6" /></svg>
);
const ChevronRight = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 6l6 6-6 6" /></svg>
);

function Images({ t }: { t: TileState }) {
  return (
    <>
      {t.slots.map((src, i) => (
        <img ref={t.refs[i]} class="cam-img" data-front={t.front === i || undefined} src={src ?? undefined} alt="" hidden={!src} />
      ))}
    </>
  );
}

function ageLabel(t: TileState | undefined, now: number, showStale: boolean): { text: string; stale: boolean } | null {
  if (!t?.frameAt) return null;
  const age = Math.max(0, Math.round((now - t.frameAt) / 1000));
  const stale = showStale && age > 10;
  return { text: stale ? `Stale · ${age} s` : `${age} s`, stale };
}

export function Grid(p: {
  cams: CamInfo[];
  tiles: Map<string, TileState>;
  now: number;
  showStale: boolean;
  time: string;
  date: string;
  open(i: number): void;
}) {
  return (
    <div class="cams">
      <header class="cams-head">
        <div class="cams-head__title">
          <h1 class="cams-title">Cameras</h1>
          <span class="cams-subtitle">Tap a camera for live view</span>
        </div>
        <div class="cams-clock">
          <div class="cams-clock__time">{p.time}</div>
          <div class="cams-clock__date">{p.date}</div>
        </div>
      </header>
      <section class="cams-grid" aria-label="Camera grid">
        {p.cams.map((c, i) => {
          const t = p.tiles.get(c.id);
          const age = ageLabel(t, p.now, p.showStale);
          return (
            <button type="button" class="cam-tile" aria-label={`Open ${c.name} camera${age?.stale ? ', image is stale' : ''}`} onClick={() => p.open(i)}>
              {t && <Images t={t} />}
              {age && <span class="cam-age" data-stale={age.stale || undefined}>{age.text}</span>}
              <span class="cam-name">{c.doorbell && <Bell />}{c.name}</span>
            </button>
          );
        })}
      </section>
    </div>
  );
}

export function Full(p: {
  cam: CamInfo;
  tile: TileState | undefined;
  videoRef: RefObject<HTMLVideoElement>;
  controls: boolean;
  status: 'connecting' | 'live' | 'unavailable';
  pointer: Record<string, (e: PointerEvent) => void>;
  toggle(): void;
  close(): void;
  prev(): void;
  next(): void;
}) {
  const stop = (fn: () => void) => (e: Event) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div class="cam-full" data-controls={p.controls || undefined} {...p.pointer} onClick={p.toggle}>
      <video ref={p.videoRef} class="cam-video" muted autoplay playsInline hidden={p.status === 'unavailable'} />
      {p.status === 'unavailable' && p.tile && <div class="cam-fallback"><Images t={p.tile} /></div>}
      {p.status !== 'live' && (
        <span class="cam-status">{p.status === 'connecting' ? 'Connecting…' : 'Live view unavailable'}</span>
      )}
      <div class="cam-full__controls">
        <span class="cam-name cam-name--full">{p.cam.doorbell && <Bell />}{p.cam.name}</span>
        <button type="button" class="cam-round cam-close" aria-label="Close live view" onClick={stop(p.close)}><Close /></button>
        <button type="button" class="cam-round cam-prev" aria-label="Previous camera" onClick={stop(p.prev)}><ChevronLeft /></button>
        <button type="button" class="cam-round cam-next" aria-label="Next camera" onClick={stop(p.next)}><ChevronRight /></button>
      </div>
    </div>
  );
}
