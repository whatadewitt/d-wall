// The doorbell popup (spec section 7), mounted by the shell in the overlay layer. It shows the
// newest doorbell still at once, then live video as soon as WebRTC plays. The shell decides when
// it opens and closes and sends the details on the local `doorbell.popup` topic. Everything else
// comes from ctx, as for a screen (section 4).
import { createRef, render } from 'preact';
import type { Mount } from '../../screens/types';
import { openLive, type Live } from '../../screens/cameras/live';
import type { PopupMessage } from '../../shell/doorbell';
import './doorbell.css';

const LIVE_TIMEOUT_MS = 5000;
const known: { names: Map<string, string> } = { names: new Map() }; // camera names survive unmount

const Bell = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4" /></svg>
);
const Close = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
);

export const mount: Mount = (root, ctx) => {
  const { config } = ctx;
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: config.clock === '12h', timeZone: config.timezone });
  const videoRef = createRef<HTMLVideoElement>();
  const imgRefs = [createRef<HTMLImageElement>(), createRef<HTMLImageElement>()] as const;
  const slots: [string | null, string | null] = [null, null];
  let front: 0 | 1 = 0;
  let popup: PopupMessage | null = null;
  let camera = '';
  let live: Live | null = null;
  let status: 'connecting' | 'live' | 'unavailable' = 'connecting';
  let liveStartedAt = 0;
  let loading = false;
  let etag = '';
  // Ring-to-popup timings (section 7 targets), reported once per popup.
  const marks: { popup: number | null; still: number | null; live: number | null } = { popup: null, still: null, live: null };
  let reported = false;

  // Server-clock ms after the ring, for a time on this page's clock.
  const sinceRing = (t: number | null) => (t === null || !popup ? null : Math.round(t + popup.timing.skew - Date.parse(popup.at)));

  function reportTimings(): void {
    if (reported || !popup) return;
    reported = true;
    const { timing } = popup;
    void ctx.fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        doorbell: {
          at: popup.at,
          via: timing.via,
          from: timing.from,
          receivedMs: sinceRing(timing.receivedAt),
          popupMs: sinceRing(marks.popup),
          stillMs: sinceRing(marks.still),
          liveMs: sinceRing(marks.live),
          sound: timing.sound,
        },
      }),
    }).catch(() => {});
  }

  // The newest still, fetched as a blob and decoded into the hidden image before it is swapped in.
  async function pollStill(): Promise<void> {
    if (loading || !camera) return;
    loading = true;
    try {
      const res = await ctx.fetch(`/api/cameras/${encodeURIComponent(camera)}/still.jpg?fast=1`, {
        cache: 'no-store',
        headers: etag ? { 'if-none-match': etag } : {},
      });
      if (!res.ok) return; // includes 304: nothing newer
      const url = URL.createObjectURL(await res.blob());
      etag = res.headers.get('etag') ?? '';
      const back: 0 | 1 = front === 0 ? 1 : 0;
      const old = slots[back];
      slots[back] = url;
      draw();
      if (old) URL.revokeObjectURL(old);
      try {
        await imgRefs[back].current?.decode();
      } catch {
        // replaced or unmounted before it decoded
      }
      if (slots[back] !== url) return;
      front = back;
      marks.still ??= Date.now();
      draw();
    } catch {
      // aborted on close, or the server is unreachable: keep the last image
    } finally {
      loading = false;
    }
  }

  function startLive(): void {
    const video = videoRef.current;
    if (!video || !camera || live) return;
    status = 'connecting';
    liveStartedAt = Date.now();
    const session = openLive(ctx, camera, video);
    live = session;
    video.onplaying = () => {
      if (live !== session) return;
      status = 'live';
      marks.live ??= Date.now();
      draw();
      reportTimings();
    };
    session.ready.catch(() => {
      if (live === session) fallBack();
    });
  }

  function stopLive(): void {
    if (videoRef.current) videoRef.current.onplaying = null;
    live?.close();
    live = null;
  }

  // No live video after 5 s, or the offer failed: stay on stills, refreshed every second.
  function fallBack(): void {
    stopLive();
    status = 'unavailable';
    draw();
    reportTimings();
  }

  function draw(): void {
    if (!popup) {
      render(<div class="bell-scrim" />, root);
      return;
    }
    const now = Date.now();
    const p = popup;
    const left = Math.max(0, Math.ceil((p.until - now) / 1000));
    const share = Math.max(0, Math.min(1, (p.until - now) / Math.max(1, p.until - p.resetAt)));
    const name = known.names.get(p.cameraId) ?? 'Doorbell';
    const close = () => ctx.go(p.beneath ?? config.screens[0]);
    render(
      <div class="bell-scrim">
        <section class="bell" role="dialog" aria-label="Doorbell" onPointerDown={() => ctx.touch()}>
          <header class="bell-head">
            <div class="bell-head__title">
              <span class="bell-badge"><Bell /></span>
              <div>
                <h1 class="bell-title">Someone's at the {name.charAt(0).toLowerCase() + name.slice(1)}</h1>
                <div class="bell-sub">Rang at {time.format(Date.parse(p.at))}</div>
              </div>
            </div>
            <button type="button" class="bell-round" aria-label="Close" onClick={close}><Close /></button>
          </header>
          <div class="bell-view">
            {slots.map((src, i) => (
              <img ref={imgRefs[i]} class="bell-img" data-front={(status !== 'live' && front === i) || undefined} src={src ?? undefined} alt="" hidden={!src} />
            ))}
            <video ref={videoRef} class="bell-img" data-front={status === 'live' || undefined} muted autoplay playsInline />
            {status === 'live' && <span class="bell-pill"><span class="bell-dot" />LIVE</span>}
            {status === 'unavailable' && <span class="bell-pill">Live view unavailable</span>}
            <span class="bell-name">{name}</span>
          </div>
          <footer class="bell-foot">
            <button type="button" class="bell-btn bell-btn--accent" onClick={() => ctx.go('cameras')}>Open cameras</button>
            <button type="button" class="bell-btn" onClick={close}>Dismiss</button>
            <div class="bell-timer">
              <div class="bell-timer__text">Closes in {left} s</div>
              <div class="bell-bar"><div class="bell-bar__fill" style={{ width: `${share * 100}%` }} /></div>
            </div>
          </footer>
        </section>
      </div>,
      root,
    );
  }

  function tick(): void {
    if (!popup) return;
    if (status === 'connecting' && live && Date.now() - liveStartedAt >= LIVE_TIMEOUT_MS) fallBack();
    if (status !== 'live') void pollStill();
    draw();
  }

  ctx.subscribe('doorbell.popup', (msg) => {
    const next = msg as PopupMessage | null;
    if (!next) return;
    const first = !popup;
    const cameraChanged = popup?.cameraId !== next.cameraId;
    popup = next;
    if (cameraChanged) {
      camera = next.cameraId;
      stopLive();
      etag = '';
      if (!camera) status = 'unavailable'; // no camera marked doorbell: true
    }
    draw();
    if (first) requestAnimationFrame(() => requestAnimationFrame(() => (marks.popup ??= Date.now())));
    if (cameraChanged) {
      void pollStill();
      startLive();
    }
  });
  ctx.every(1000, tick);
  ctx.signal.addEventListener('abort', () => {
    stopLive();
    reportTimings(); // closed before live video or the fallback: report what there is
    render(null, root);
    for (const url of slots) if (url) URL.revokeObjectURL(url);
  });

  draw();
  if (!known.names.size) {
    ctx
      .fetch('/api/cameras')
      .then((r) => (r.ok ? r.json() : null))
      .then((list: { id: string; name: string }[] | null) => {
        if (!list) return;
        known.names = new Map(list.map((c) => [c.id, c.name]));
        draw();
      })
      .catch(() => {});
  }
};
