// The cameras screen (spec section 6): a 2x2 grid of refreshing stills; tap for full-screen live view.
// Every timer, fetch and subscription comes from ctx; blob URLs and the peer connection are
// released on unmount.
import { createRef, render } from 'preact';
import type { Mount } from '../types';
import { openLive, type Live } from './live';
import { Full, Grid, type CamInfo, type TileState } from './view';
import './cameras.css';

const GRID_POLL_MS = 2000;
const LIVE_TIMEOUT_MS = 5000;
const STALE_AFTER_OPEN_MS = 3000;
const GRID_RETURN_MS = 90_000;  // grid -> home (section 9)
const FULL_RETURN_MS = 120_000; // full view -> grid (section 6)
const STATS_EVERY_MS = 30_000;
const SWIPE_PX = 80;

const known: { cams: CamInfo[] } = { cams: [] }; // camera list survives unmount so the grid paints at once

export const mount: Mount = (root, ctx) => {
  const { config } = ctx;
  const home = config.screens[0];
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: config.clock === '12h', timeZone: config.timezone });
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: config.timezone });

  const mountedAt = Date.now();
  const tiles = new Map<string, TileState>();
  const etags = new Map<string, string>();
  const loading = new Set<string>();
  const videoRef = createRef<HTMLVideoElement>();
  let lastTouch = Date.now();
  let lastPoll = 0;

  type FullView = {
    index: number;
    controls: boolean;
    status: 'connecting' | 'live' | 'unavailable';
    openedAt: number;
    connectMs: number | null;
    stream: string;
    lastStats: number;
  };
  let full: FullView | null = null;
  let live: Live | null = null;

  const tile = (id: string): TileState => {
    let t = tiles.get(id);
    if (!t) tiles.set(id, (t = { slots: [null, null], front: 0, refs: [createRef(), createRef()], frameAt: 0 }));
    return t;
  };

  // Fetch a still as a blob, decode it into the hidden image, swap it in, then revoke the old URL.
  async function pollStill(id: string, fast: boolean): Promise<void> {
    if (loading.has(id)) return;
    loading.add(id);
    try {
      const etag = etags.get(id);
      const res = await ctx.fetch(`/api/cameras/${encodeURIComponent(id)}/still.jpg${fast ? '?fast=1' : ''}`, {
        cache: 'no-store',
        headers: etag ? { 'if-none-match': etag } : {},
      });
      const t = tile(id);
      const at = Number(res.headers.get('x-frame-at')) || 0;
      if (res.status === 304) {
        t.frameAt = at || t.frameAt;
        return;
      }
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      etags.set(id, res.headers.get('etag') ?? '');
      const back: 0 | 1 = t.front === 0 ? 1 : 0;
      const old = t.slots[back];
      t.slots[back] = url;
      draw();
      if (old) URL.revokeObjectURL(old);
      try {
        await t.refs[back].current?.decode();
      } catch {
        // replaced or unmounted before it decoded
      }
      if (t.slots[back] !== url) return;
      t.front = back;
      t.frameAt = at;
      draw();
    } catch {
      // aborted on unmount, or the server is unreachable: keep the last image
    } finally {
      loading.delete(id);
    }
  }

  function pollGrid(): void {
    lastPoll = Date.now();
    for (const c of known.cams) void pollStill(c.id, false);
  }

  function report(): void {
    if (!full || !live) return;
    const view = full;
    const cam = known.cams[view.index];
    void live.stats().then((s) => {
      void ctx.fetch('/api/telemetry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          video: {
            camera: cam.id,
            stream: view.stream,
            connectMs: view.connectMs,
            ...s,
            seconds: Math.round((Date.now() - view.openedAt) / 1000),
            fallback: view.status === 'unavailable',
          },
        }),
      }).catch(() => {});
    }).catch(() => {});
  }

  function stopLive(): void {
    if (live && full?.status === 'live') report();
    live?.close();
    live = null;
  }

  function openFull(index: number): void {
    stopLive();
    const n = known.cams.length;
    full = { index: ((index % n) + n) % n, controls: true, status: 'connecting', openedAt: Date.now(), connectMs: null, stream: '', lastStats: Date.now() };
    draw();
    const video = videoRef.current;
    if (!video) return;
    const view = full;
    const session = openLive(ctx, known.cams[view.index].id, video);
    live = session;
    video.onplaying = () => {
      if (full !== view || live !== session) return;
      view.status = 'live';
      view.connectMs = Date.now() - view.openedAt;
      view.lastStats = Date.now();
      draw();
    };
    session.ready.then(
      (stream) => {
        view.stream = stream;
      },
      () => {
        if (full === view && live === session) fallBack(view);
      },
    );
  }

  // No live video after 5 s, or the offer failed: show a still refreshed every second (section 6).
  function fallBack(view: FullView): void {
    view.status = 'unavailable';
    live?.close();
    live = null;
    draw();
  }

  function closeFull(): void {
    stopLive();
    if (videoRef.current) videoRef.current.onplaying = null;
    full = null;
    lastTouch = Date.now();
    pollGrid();
    draw();
  }

  // Horizontal swipe in full view moves to the previous or next camera.
  let drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  let suppressTapUntil = 0;
  const pointer = {
    onPointerDown(e: PointerEvent) {
      lastTouch = Date.now();
      if (e.isPrimary) drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    },
    onPointerMove(e: PointerEvent) {
      if (drag && e.pointerId === drag.id && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 10) drag.moved = true;
    },
    onPointerUp(e: PointerEvent) {
      if (!drag || e.pointerId !== drag.id || !full) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      const moved = drag.moved;
      drag = null;
      if (!moved) return;
      suppressTapUntil = e.timeStamp + 300;
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) openFull(full.index + (dx < 0 ? 1 : -1));
    },
    onPointerCancel() {
      drag = null;
    },
  };

  function draw(): void {
    const now = Date.now();
    if (full) {
      const view = full;
      const cam = known.cams[view.index];
      render(
        <Full
          cam={cam}
          tile={tiles.get(cam.id)}
          videoRef={videoRef}
          controls={view.controls}
          status={view.status}
          pointer={pointer as unknown as Record<string, (e: PointerEvent) => void>}
          toggle={() => {
            if (performance.now() < suppressTapUntil) return;
            view.controls = !view.controls;
            draw();
          }}
          close={closeFull}
          prev={() => openFull(view.index - 1)}
          next={() => openFull(view.index + 1)}
        />,
        root,
      );
      return;
    }
    render(
      <Grid
        cams={known.cams}
        tiles={tiles}
        now={now}
        showStale={now - mountedAt >= STALE_AFTER_OPEN_MS}
        time={time.format(now)}
        date={date.format(now)}
        open={(i) => {
          lastTouch = Date.now();
          openFull(i);
        }}
      />,
      root,
    );
  }

  function tick(): void {
    const now = Date.now();
    if (!full) {
      if (now - lastTouch >= GRID_RETURN_MS && home !== 'cameras') return ctx.go(home);
      if (now - lastPoll >= GRID_POLL_MS) pollGrid();
    } else {
      const view = full;
      if (now - lastTouch >= FULL_RETURN_MS) return closeFull();
      if (view.status === 'connecting' && now - view.openedAt >= LIVE_TIMEOUT_MS) fallBack(view);
      if (view.status === 'unavailable') void pollStill(known.cams[view.index].id, true);
      if (view.status === 'live' && now - view.lastStats >= STATS_EVERY_MS) {
        view.lastStats = now;
        report();
      }
    }
    draw();
  }

  root.addEventListener('pointerdown', () => {
    lastTouch = Date.now();
  }, { capture: true, passive: true });

  ctx.every(1000, tick);
  ctx.signal.addEventListener('abort', () => {
    live?.close();
    live = null;
    render(null, root);
    for (const t of tiles.values()) for (const url of t.slots) if (url) URL.revokeObjectURL(url);
    tiles.clear();
  });

  draw();
  ctx
    .fetch('/api/cameras')
    .then((r) => (r.ok ? r.json() : null))
    .then((list: CamInfo[] | null) => {
      if (!list) return;
      known.cams = list;
      if (full && full.index >= list.length) closeFull();
      pollGrid();
      draw();
    })
    .catch(() => {});
  if (known.cams.length) pollGrid();
};
