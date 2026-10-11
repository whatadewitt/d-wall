// The Spotify screen (docs/backlog.md): a remote control for Spotify playing on a speaker such as
// the Nest Hub. The tablet plays no audio. Spotify has no push, so the screen polls the server
// every 3 s while mounted and moves the progress bar locally in between. Everything goes through ctx.
import { render } from 'preact';
import type { Mount } from '../types';
import { SpotifyView, type DeviceView, type PlayerView, type Sheet } from './view';
import './spotify.css';

const POLL_MS = 3000;
const AFTER_COMMAND_MS = 700;  // Spotify takes a moment to report a change
const OPTIMISTIC_MS = 2500;    // how long a tapped play/pause or volume wins over polled state
const MESSAGE_MS = 6000;
const SHEET_CLOSE_MS = 60_000;
const RETURN_MS = 90_000;      // back to the first rail screen, as the cameras grid does

const known: { view: PlayerView | null; at: number } = { view: null, at: 0 }; // paints at once on return

const ERRORS: Record<string, string> = {
  'no-device': 'Nothing is playing. Start something in the Spotify app, or use Play on.',
  premium: 'Controlling playback needs Spotify Premium.',
  auth: 'The Spotify sign-in has expired. Run the sign-in step again.',
  rate: 'Spotify asked us to slow down. Try again in a moment.',
  'not-configured': "Spotify isn't set up yet.",
};

export const mount: Mount = (root, ctx) => {
  const { config } = ctx;
  const home = config.screens[0];
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: config.clock === '12h', timeZone: config.timezone });
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: config.timezone });

  let lastFetch = 0;
  let fetching = false;
  let lastTouch = Date.now();
  let optimistic: { playing?: boolean; volume?: number; until: number } | null = null;
  let dragVolume: number | null = null;
  let message: { text: string; until: number } | null = null;
  let sheet: Sheet | null = null;

  const say = (text: string) => {
    message = { text, until: Date.now() + MESSAGE_MS };
    draw();
  };
  const errorText = async (res: Response) => {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const target = known.view?.target ?? 'The speaker';
    if (body.error === 'target-missing') return `${target} isn't showing up in Spotify. Cast to it once from the Spotify app, then try again.`;
    return ERRORS[body.error ?? ''] ?? "Spotify didn't respond. Try again.";
  };
  const soon = () => {
    lastFetch = Date.now() - POLL_MS + AFTER_COMMAND_MS;
  };

  async function poll(): Promise<void> {
    if (fetching) return;
    fetching = true;
    lastFetch = Date.now();
    try {
      const res = await ctx.fetch('/api/spotify/player', { cache: 'no-store' });
      if (res.ok) {
        known.view = (await res.json()) as PlayerView;
        known.at = Date.now();
        draw();
      }
    } catch {
      // aborted on unmount, or the server is down: keep showing the last state
    } finally {
      fetching = false;
    }
  }

  async function post(path: string, body: object): Promise<boolean> {
    try {
      const res = await ctx.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        optimistic = null;
        say(await errorText(res));
        return false;
      }
      return true;
    } catch {
      if (!ctx.signal.aborted) say("Couldn't reach the wall server.");
      return false;
    } finally {
      soon();
    }
  }

  const playing = () => (optimistic?.playing !== undefined && Date.now() < optimistic.until ? optimistic.playing : !!known.view?.playing);
  const volume = () => {
    if (dragVolume !== null) return dragVolume;
    if (optimistic?.volume !== undefined && Date.now() < optimistic.until) return optimistic.volume;
    return known.view?.device?.volume ?? null;
  };
  const progress = () => {
    const v = known.view;
    if (!v?.item) return 0;
    const ms = v.progressMs + (v.playing ? Date.now() - known.at : 0);
    return Math.min(ms, v.item.durationMs);
  };

  async function openSheet(): Promise<void> {
    sheet = { devices: null, targetFound: true, error: null };
    draw();
    try {
      const res = await ctx.fetch('/api/spotify/devices', { cache: 'no-store' });
      if (!sheet) return;
      if (!res.ok) sheet = { devices: [], targetFound: true, error: await errorText(res) };
      else {
        const body = (await res.json()) as { devices: DeviceView[]; targetFound: boolean };
        sheet = { devices: body.devices, targetFound: body.targetFound, error: null };
      }
      draw();
    } catch {
      // aborted on unmount
    }
  }

  function draw(): void {
    render(
      <SpotifyView
        view={known.view}
        progressMs={progress()}
        playing={playing()}
        volume={volume()}
        message={message && Date.now() < message.until ? message.text : null}
        sheet={sheet}
        time={time.format(new Date())}
        date={date.format(new Date())}
        toggle={() => {
          const next = !playing();
          optimistic = { playing: next, until: Date.now() + OPTIMISTIC_MS };
          draw();
          void post('/api/spotify/command', { type: next ? 'play' : 'pause' });
        }}
        skip={(dir) => void post('/api/spotify/command', { type: dir })}
        volumeInput={(v) => {
          dragVolume = v;
          draw();
        }}
        volumeCommit={(v) => {
          dragVolume = null;
          optimistic = { volume: v, until: Date.now() + OPTIMISTIC_MS };
          draw();
          void post('/api/spotify/command', { type: 'volume', value: v });
        }}
        playOnTarget={() => void post('/api/spotify/transfer', {})}
        openSheet={() => void openSheet()}
        closeSheet={() => {
          sheet = null;
          draw();
        }}
        transfer={(id) => {
          sheet = null;
          draw();
          void post('/api/spotify/transfer', { deviceId: id });
        }}
      />,
      root,
    );
  }

  root.addEventListener('pointerdown', () => {
    lastTouch = Date.now();
  }, { capture: true, passive: true });

  ctx.every(1000, () => {
    const now = Date.now();
    if (now - lastTouch >= RETURN_MS && home !== 'spotify') return ctx.go(home);
    if (sheet && now - lastTouch >= SHEET_CLOSE_MS) sheet = null;
    if (now - lastFetch >= POLL_MS) void poll();
    draw();
  });
  ctx.signal.addEventListener('abort', () => render(null, root));

  draw();
  void poll();
};
