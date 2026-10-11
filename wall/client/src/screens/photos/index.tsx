// The photos screen (spec section 8), mounted only while the tablet is Idle. Two stacked images
// cross-fade every photos.intervalSec. The next image is fetched and decoded before the fade, and
// the old one is dropped after it, so at most two decoded photos exist. A clock and date sit in
// the corner, and the artwork's title and credit in the other when the server has them.
import { createRef, render } from 'preact';
import type { Mount } from '../types';
import './photos.css';

const FADE_MS = 1500; // matches .photo's transition in photos.css

interface Slot { url: string; fill: boolean; caption: { title: string; credit: string } | null }

const header = (res: Response, name: string) => {
  const v = res.headers.get(name);
  try {
    return v ? decodeURIComponent(v) : '';
  } catch {
    return '';
  }
};

export const mount: Mount = (root, ctx) => {
  const { config } = ctx;
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: config.clock === '12h', timeZone: config.timezone });
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: config.timezone });
  const refs = [createRef<HTMLImageElement>(), createRef<HTMLImageElement>()] as const;
  const slots: [Slot | null, Slot | null] = [null, null];
  let front: 0 | 1 = 0;
  let busy = false;
  let lastSwap = 0;
  let fadedAt = 0;
  // The screen in device pixels, so the server sends an image the size of the screen (section 4).
  const size = `w=${Math.round(innerWidth * devicePixelRatio)}&h=${Math.round(innerHeight * devicePixelRatio)}`;

  const clear = (i: 0 | 1) => {
    const s = slots[i];
    slots[i] = null;
    if (s) URL.revokeObjectURL(s.url);
  };

  async function advance(): Promise<void> {
    if (busy) return;
    busy = true;
    lastSwap = Date.now();
    try {
      const res = await ctx.fetch(`/api/photos/next?${size}`, { cache: 'no-store' });
      if (!res.ok) return; // no photos: the clock stays on black
      const url = URL.createObjectURL(await res.blob());
      const back: 0 | 1 = front === 0 ? 1 : 0;
      clear(back);
      const title = header(res, 'x-photo-title');
      slots[back] = { url, fill: true, caption: title ? { title, credit: header(res, 'x-photo-credit') } : null };
      draw();
      const img = refs[back].current;
      try {
        await img?.decode();
      } catch {
        // unmounted, or not an image the WebView can decode
      }
      if (ctx.signal.aborted || slots[back]?.url !== url || !img) return;
      // Landscape fills the screen; portrait sits centred on black (section 8).
      slots[back]!.fill = img.naturalWidth >= img.naturalHeight;
      front = back;
      fadedAt = Date.now();
      draw();
    } catch {
      // aborted on unmount, or the server is unreachable: keep the current image
    } finally {
      busy = false;
    }
  }

  function draw(): void {
    const now = Date.now();
    const shown = slots[front];
    render(
      <div class="photos">
        {slots.map((s, i) => (
          <img ref={refs[i]} class="photo" data-front={(front === i && s) || undefined} data-fill={s?.fill || undefined} src={s?.url} alt="" hidden={!s} />
        ))}
        {shown?.caption && (
          <div class="photos-caption">
            <div class="photos-caption__title">{shown.caption.title}</div>
            {shown.caption.credit && <div class="photos-caption__credit">{shown.caption.credit}</div>}
          </div>
        )}
        <div class="photos-clock">
          <div class="photos-clock__time">{time.format(now)}</div>
          <div class="photos-clock__date">{date.format(now)}</div>
        </div>
      </div>,
      root,
    );
  }

  ctx.every(1000, () => {
    const now = Date.now();
    // After the fade, drop the old image, so only one stays decoded until the next fetch.
    const other: 0 | 1 = front === 0 ? 1 : 0;
    if (!busy && slots[other] && now - fadedAt >= FADE_MS) clear(other);
    if (now - lastSwap >= config.photosIntervalSec * 1000) void advance();
    draw(); // the clock
  });
  ctx.signal.addEventListener('abort', () => {
    render(null, root);
    clear(0);
    clear(1);
  });
  draw();
  void advance();
};
