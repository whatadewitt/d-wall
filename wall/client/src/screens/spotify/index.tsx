// The Spotify screen (milestone 7): what's playing and on which speaker. Display only; people
// start and control music on the kitchen Hub or their own devices. The server publishes
// `spotify.now` when it changes, and the progress bar moves locally in between. Everything goes through ctx.
import { render } from 'preact';
import { progressOf, type SpotifyMessage } from '../../shell/nowplaying';
import type { Mount } from '../types';
import { SpotifyView } from './view';
import './spotify.css';

const RETURN_MS = 90_000; // back to the first rail screen, as the cameras grid does

const known: { msg: SpotifyMessage | null; at: number } = { msg: null, at: 0 }; // paints at once on return

export const mount: Mount = (root, ctx) => {
  const { config } = ctx;
  const home = config.screens[0];
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: config.clock === '12h', timeZone: config.timezone });
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: config.timezone });
  let lastTouch = Date.now();

  const hear = (msg: unknown) => {
    known.msg = msg as SpotifyMessage;
    known.at = Date.now();
    draw();
  };

  function draw(): void {
    const now = known.msg?.now ?? null;
    render(
      <SpotifyView
        now={now}
        problem={known.msg?.problem ?? null}
        progressMs={now ? progressOf(now, known.at) : 0}
        time={time.format(new Date())}
        date={date.format(new Date())}
      />,
      root,
    );
  }

  root.addEventListener('pointerdown', () => {
    lastTouch = Date.now();
  }, { capture: true, passive: true });

  ctx.subscribe('spotify.now', hear);
  ctx.every(1000, () => {
    if (Date.now() - lastTouch >= RETURN_MS && home !== 'spotify') return ctx.go(home);
    draw();
  });
  ctx.signal.addEventListener('abort', () => render(null, root));
  ctx.fetch('/api/spotify/now', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((m) => m && hear(m)).catch(() => {});
  draw();
};
