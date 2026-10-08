// Template screen (spec section 4). Copy this folder to start a new screen.
// Everything comes from ctx: timers, event-stream topics, fetch. The shell releases it all on
// unmount; the only cleanup a screen owns is removing what it rendered (see the abort handler).
import { render } from 'preact';
import type { Mount } from '../types';
import './clock.css';

export const mount: Mount = (root, ctx) => {
  const { clock, timezone } = ctx.config;
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: clock === '12h', timeZone: timezone });
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: timezone });
  let serverSeen: Date | null = null;

  const draw = () => {
    const now = new Date();
    render(
      <div class="example-clock">
        <div class="example-clock__time">{time.format(now)}</div>
        <div class="example-clock__date">{date.format(now)}</div>
        <div class="example-clock__status">
          {serverSeen ? `Server seen ${time.format(serverSeen)}` : 'Waiting for server'}
        </div>
      </div>,
      root,
    );
  };

  ctx.every(1000, draw);
  ctx.subscribe('state', () => {
    serverSeen = new Date();
    draw();
  });
  ctx
    .fetch('/api/state')
    .then((r) => {
      if (r.ok) serverSeen = new Date();
      draw();
    })
    .catch(() => {}); // aborted on unmount, or the server is down
  ctx.signal.addEventListener('abort', () => render(null, root));
  draw();
};
