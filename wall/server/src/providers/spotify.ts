import { IMAGE_BASE, imageId, Spotify, SpotifyError } from '../spotify.js';
import { serverState } from '../state.js';
import type { Provider, ProviderDeps } from './types.js';

// The spotify provider (milestone 7): what's playing on Spotify and on which speaker. Display only;
// the wall never controls playback. Spotify has no push for playback, so the server polls each
// signed-in account while the tablet is on (Active or Idle) and publishes `spotify.now` when
// something changes. Track names and tokens never reach the log.

const POLL_PLAYING_MS = 5000;
const POLL_QUIET_MS = 10_000;
const PAUSED_SHOW_MS = 10 * 60_000; // a paused track stays on the wall this long, then goes
const SEEK_SLACK_MS = 3000;         // progress further than this from the expected value is republished
const AUTH_RETRY_MS = 60_000;
const ART_KEEP = 8;
const ART_MAX_BYTES = 2 * 1024 * 1024;

type Problem = 'not-configured' | 'auth' | 'rate' | 'unavailable';

export interface NowPlaying {
  playing: boolean;
  title: string;
  artist: string;
  album: string;
  art: string | null;   // about 640 px, for the Spotify screen
  thumb: string | null; // about 300 px, for the island and the lock screen
  durationMs: number;
  progressMs: number;
  at: number;           // server time progressMs was read
  device: { name: string; type: string };
}

export interface SpotifyMessage { now: NowPlaying | null; problem: Problem | null }

interface SpotifyImage { url: string; width?: number | null }
interface SpotifyPlayer {
  is_playing: boolean;
  progress_ms: number | null;
  device?: { name: string; type: string };
  item?: {
    type: 'track' | 'episode';
    name: string;
    duration_ms: number;
    artists?: { name: string }[];
    album?: { name: string; images?: SpotifyImage[] };
    show?: { name: string; images?: SpotifyImage[] };
    images?: SpotifyImage[];
  } | null;
}

const closest = (images: SpotifyImage[] = [], px: number) =>
  [...images].sort((a, b) => Math.abs((a.width ?? px) - px) - Math.abs((b.width ?? px) - px))[0]?.url;
const artPath = (url: string | undefined) => {
  const id = imageId(url);
  return id ? `/api/spotify/art/${id}` : null;
};

function toNow(p: SpotifyPlayer | null): NowPlaying | null {
  const it = p?.item;
  if (!p || !it || !p.device) return null;
  const images = it.album?.images ?? it.images ?? it.show?.images;
  return {
    playing: p.is_playing,
    title: it.name,
    artist: it.type === 'episode' ? (it.show?.name ?? '') : (it.artists ?? []).map((a) => a.name).join(', '),
    album: it.type === 'episode' ? '' : (it.album?.name ?? ''),
    art: artPath(closest(images, 640)),
    thumb: artPath(closest(images, 300)),
    durationMs: it.duration_ms,
    progressMs: p.progress_ms ?? 0,
    at: Date.now(),
    device: { name: p.device.name, type: p.device.type },
  };
}

interface Account {
  n: number;               // 1-based, for the log
  api: Spotify;
  now: NowPlaying | null;
  pausedSince: number | null;
  problem: Problem | null;
  blockedUntil: number;
}

export function spotifyProvider({ config, hub, log, bus }: ProviderDeps): Provider {
  const kitchen = config.spotify?.device ?? null;
  const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret } = process.env;
  // One refresh token per Spotify account in the house, comma-separated.
  const tokens = (process.env.SPOTIFY_REFRESH_TOKENS ?? process.env.SPOTIFY_REFRESH_TOKEN ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const accounts: Account[] = id && secret
    ? tokens.map((t, i) => ({
        n: i + 1,
        api: new Spotify(id, secret, t, () => log.warn({ provider: 'spotify', account: i + 1 }, 'Spotify issued a new refresh token; the one in .env may stop working, and the sign-in may need redoing')),
        now: null,
        pausedSince: null,
        problem: null,
        blockedUntil: 0,
      }))
    : [];

  let current: SpotifyMessage = { now: null, problem: accounts.length ? null : 'not-configured' };
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const art = new Map<string, Buffer>();

  function problemOf(acc: Account, err: unknown): Problem {
    const e = err instanceof SpotifyError ? err : new SpotifyError(0, 'network', String(err));
    let p: Problem = 'unavailable';
    if (e.reason === 'auth' || e.reason === 'token' || e.status === 401) {
      p = 'auth';
      acc.blockedUntil = Date.now() + AUTH_RETRY_MS; // don't ask Spotify for a token every poll
    } else if (e.status === 429) {
      p = 'rate';
      acc.blockedUntil = Date.now() + (e.retryAfterSec || 30) * 1000;
    }
    // Logged once per change, so polling can't flood the log.
    if (p !== acc.problem) log.warn({ provider: 'spotify', account: acc.n, problem: p, status: e.status, reason: e.reason, err: e.message }, 'Spotify call failed');
    return p;
  }

  async function read(acc: Account): Promise<void> {
    if (Date.now() < acc.blockedUntil) return;
    try {
      const now = toNow((await acc.api.call('GET', '/me/player?additional_types=episode')) as SpotifyPlayer | null);
      if (acc.problem) log.info({ provider: 'spotify', account: acc.n }, 'Spotify reachable again');
      acc.problem = null;
      acc.now = now;
      acc.pausedSince = now && !now.playing ? (acc.pausedSince ?? Date.now()) : null;
    } catch (err) {
      acc.problem = problemOf(acc, err);
    }
  }

  // Which account the wall shows: one playing on the kitchen speaker, then any account playing,
  // then one paused in the last 10 minutes. Ties go to the order in .env.
  function pick(): NowPlaying | null {
    const live = accounts.filter((a) => a.now?.playing);
    const onKitchen = live.find((a) => a.now?.device.name === kitchen);
    if (onKitchen || live[0]) return (onKitchen ?? live[0]).now;
    const paused = accounts.find((a) => a.now && a.pausedSince !== null && Date.now() - a.pausedSince < PAUSED_SHOW_MS);
    return paused?.now ?? null;
  }

  // Worth telling the tablet: a different track, speaker, art or play state, or a jump in progress.
  function changed(a: NowPlaying | null, b: NowPlaying | null): boolean {
    if (!a || !b) return a !== b;
    if (a.playing !== b.playing || a.title !== b.title || a.artist !== b.artist || a.art !== b.art || a.device.name !== b.device.name) return true;
    const expected = a.progressMs + (a.playing ? b.at - a.at : 0);
    return Math.abs(b.progressMs - expected) > SEEK_SLACK_MS;
  }

  async function poll(): Promise<void> {
    timer = null;
    if (!running) return;
    await Promise.all(accounts.map(read));
    const now = pick();
    const problem = now || accounts.some((a) => !a.problem) ? null : (accounts[0]?.problem ?? null);
    if (changed(current.now, now) || problem !== current.problem) {
      current = { now, problem };
      hub.publish('spotify.now', current);
    } else if (now) {
      current = { now, problem }; // fresh progress for GET, without a message
    }
    if (running && !timer) timer = setTimeout(() => void poll(), now?.playing ? POLL_PLAYING_MS : POLL_QUIET_MS);
  }

  // Polls only while the screen is lit: no Spotify calls while the tablet is Off.
  function setActive(on: boolean): void {
    if (!accounts.length || on === running) return;
    running = on;
    if (on) void poll();
    else if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
  const onTabletState = (state: string) => setActive(state !== 'off');
  const onClient = () => hub.publish('spotify.now', current);

  return {
    id: 'spotify',
    topics: ['spotify.now'],
    routes(app) {
      // The current state, for a screen that mounts between messages.
      app.get('/api/spotify/now', async () => current);

      // Album art through the server, so the tablet only ever talks to the server. The last few are kept.
      app.get<{ Params: { id: string } }>('/api/spotify/art/:id', async (req, reply) => {
        const { id } = req.params;
        if (!/^[0-9a-f]{16,64}$/.test(id)) return reply.code(404).send();
        let buf = art.get(id);
        if (!buf) {
          try {
            const res = await fetch(`${IMAGE_BASE}${id}`, { signal: AbortSignal.timeout(8000) });
            const type = res.headers.get('content-type') ?? '';
            if (!res.ok || !type.startsWith('image/jpeg')) return reply.code(502).send();
            buf = Buffer.from(await res.arrayBuffer());
          } catch {
            return reply.code(502).send();
          }
          if (buf.length > ART_MAX_BYTES) return reply.code(502).send();
          art.set(id, buf);
          if (art.size > ART_KEEP) art.delete(art.keys().next().value as string);
        }
        return reply.type('image/jpeg').header('cache-control', 'public, max-age=31536000, immutable').send(buf);
      });
    },
    start() {
      if (!accounts.length) {
        if (config.screens.includes('spotify')) log.warn({ provider: 'spotify' }, 'Spotify not set up: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and SPOTIFY_REFRESH_TOKENS go in .env');
        return;
      }
      log.info({ provider: 'spotify', accounts: accounts.length, kitchen: kitchen !== null }, 'Spotify started');
      bus.on('tablet-state', onTabletState);
      bus.on('client-connected', onClient);
      setActive(serverState.tablet.state !== 'off');
    },
    stop() {
      bus.off('tablet-state', onTabletState);
      bus.off('client-connected', onClient);
      setActive(false);
      art.clear();
    },
  };
}
