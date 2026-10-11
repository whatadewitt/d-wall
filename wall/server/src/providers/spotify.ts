import { IMAGE_BASE, imageId, Spotify, SpotifyError } from '../spotify.js';
import type { Provider, ProviderDeps } from './types.js';

// The spotify provider (docs/backlog.md): a remote control for Spotify, playing on the Google
// Nest Hub (or any Spotify Connect device). The tablet never plays audio. Spotify has no push for
// playback, so the screen polls GET /api/spotify/player while it is mounted; the server shares one
// answer per second between callers. Track names and tokens never reach the log.

const PLAYER_CACHE_MS = 1000;
const AUTH_RETRY_MS = 60_000;
const ART_KEEP = 4;
const ART_MAX_BYTES = 2 * 1024 * 1024;

type Problem = 'not-configured' | 'auth' | 'premium' | 'rate' | 'unavailable';

export interface PlayerView {
  ok: boolean;
  problem?: Problem;
  playing: boolean;
  item: { title: string; artist: string; album: string; art: string | null; durationMs: number } | null;
  progressMs: number;
  device: { id: string; name: string; type: string; volume: number | null } | null;
  target: string | null; // spotify.device in config.yaml: the speaker "Play on" sends music to
  at: number;            // server time the state was read, for the screen's progress bar
}

export interface DeviceView { id: string; name: string; type: string; active: boolean }

interface SpotifyImage { url: string; width?: number | null }
interface SpotifyDevice { id: string | null; name: string; type: string; is_active: boolean; is_restricted?: boolean; volume_percent: number | null; supports_volume?: boolean }
interface SpotifyPlayer {
  is_playing: boolean;
  progress_ms: number | null;
  device?: SpotifyDevice;
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

// The image closest to 640 px wide, which is the largest Spotify serves and about right for the art panel.
const pickImage = (images: SpotifyImage[] = []) =>
  [...images].sort((a, b) => Math.abs((a.width ?? 640) - 640) - Math.abs((b.width ?? 640) - 640))[0]?.url;

function toView(p: SpotifyPlayer | null, target: string | null): PlayerView {
  const view: PlayerView = { ok: true, playing: false, item: null, progressMs: 0, device: null, target, at: Date.now() };
  if (!p) return view; // 204: nothing playing anywhere
  view.playing = p.is_playing;
  view.progressMs = p.progress_ms ?? 0;
  if (p.device) {
    view.device = {
      id: p.device.id ?? '',
      name: p.device.name,
      type: p.device.type,
      volume: p.device.supports_volume === false ? null : p.device.volume_percent,
    };
  }
  const it = p.item;
  if (it) {
    const id = imageId(pickImage(it.album?.images ?? it.images ?? it.show?.images));
    view.item = {
      title: it.name,
      artist: it.type === 'episode' ? (it.show?.name ?? '') : (it.artists ?? []).map((a) => a.name).join(', '),
      album: it.type === 'episode' ? '' : (it.album?.name ?? ''),
      art: id ? `/api/spotify/art/${id}` : null,
      durationMs: it.duration_ms,
    };
  }
  return view;
}

const empty = (target: string | null, problem: Problem): PlayerView =>
  ({ ok: false, problem, playing: false, item: null, progressMs: 0, device: null, target, at: Date.now() });

export function spotifyProvider({ config, log }: ProviderDeps): Provider {
  const target = config.spotify?.device ?? null;
  const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret, SPOTIFY_REFRESH_TOKEN: refresh } = process.env;
  const api = id && secret && refresh
    ? new Spotify(id, secret, refresh, () => log.warn({ provider: 'spotify' }, 'Spotify issued a new refresh token; the one in .env may stop working, and the sign-in may need redoing'))
    : null;

  let cached: { view: PlayerView; at: number } | null = null;
  let inflight: Promise<PlayerView> | null = null;
  let blockedUntil = 0; // Spotify's Retry-After after a 429, or a pause after a refused sign-in
  let lastProblem: Problem | null = null;
  const art = new Map<string, Buffer>();

  // What a Spotify failure means for the screen, logged once per change so polling can't flood the log.
  function problemOf(err: unknown): Problem {
    const e = err instanceof SpotifyError ? err : new SpotifyError(0, 'network', String(err));
    let p: Problem = 'unavailable';
    if (e.reason === 'auth' || e.reason === 'token' || e.status === 401) {
      p = 'auth';
      blockedUntil = Date.now() + AUTH_RETRY_MS; // don't ask Spotify for a token every poll
    }
    else if (e.reason === 'PREMIUM_REQUIRED' || (e.status === 403 && /premium/i.test(e.message))) p = 'premium';
    else if (e.status === 429) {
      p = 'rate';
      blockedUntil = Date.now() + (e.retryAfterSec || 30) * 1000;
    }
    if (p !== lastProblem) log.warn({ provider: 'spotify', problem: p, status: e.status, reason: e.reason, err: e.message }, 'Spotify call failed');
    lastProblem = p;
    return p;
  }

  async function readPlayer(): Promise<PlayerView> {
    if (!api) return empty(target, 'not-configured');
    if (Date.now() < blockedUntil) return empty(target, lastProblem ?? 'rate');
    if (cached && Date.now() - cached.at < PLAYER_CACHE_MS) return cached.view;
    inflight ??= (async () => {
      try {
        const view = toView((await api.call('GET', '/me/player?additional_types=episode')) as SpotifyPlayer | null, target);
        if (lastProblem) log.info({ provider: 'spotify' }, 'Spotify reachable again');
        lastProblem = null;
        cached = { view, at: Date.now() };
        return view;
      } catch (err) {
        return empty(target, problemOf(err));
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  // Map a failed command to an HTTP answer the screen can explain.
  function commandError(err: unknown): { code: number; body: { error: string } } {
    if (err instanceof SpotifyError && (err.reason === 'NO_ACTIVE_DEVICE' || (err.status === 404 && /device/i.test(err.message)))) {
      return { code: 409, body: { error: 'no-device' } };
    }
    const p = problemOf(err);
    return { code: p === 'premium' ? 403 : p === 'unavailable' ? 502 : 503, body: { error: p } };
  }

  return {
    id: 'spotify',
    topics: [],
    routes(app) {
      app.get('/api/spotify/player', async () => readPlayer());

      // Every Spotify Connect device Spotify can see right now. Also the spike check: does the Hub appear
      // while it's idle? (docs/reports/milestone-7.md)
      app.get('/api/spotify/devices', async (_req, reply) => {
        if (!api) return reply.code(503).send({ error: 'not-configured' });
        try {
          const body = (await api.call('GET', '/me/player/devices')) as { devices?: SpotifyDevice[] } | null;
          const devices: DeviceView[] = (body?.devices ?? [])
            .filter((d) => d.id && !d.is_restricted)
            .map((d) => ({ id: d.id as string, name: d.name, type: d.type, active: d.is_active }));
          log.info({ provider: 'spotify', devices: devices.length, targetFound: target ? devices.some((d) => d.name === target) : null }, 'devices listed');
          return { devices, target, targetFound: target ? devices.some((d) => d.name === target) : false };
        } catch (err) {
          const e = commandError(err);
          return reply.code(e.code).send(e.body);
        }
      });

      app.post<{ Body: { type: 'play' | 'pause' | 'next' | 'previous' | 'volume'; value?: number } }>('/api/spotify/command', {
        schema: {
          body: {
            type: 'object',
            required: ['type'],
            additionalProperties: false,
            properties: {
              type: { enum: ['play', 'pause', 'next', 'previous', 'volume'] },
              value: { type: 'integer', minimum: 0, maximum: 100 },
            },
          },
        },
      }, async (req, reply) => {
        if (!api) return reply.code(503).send({ error: 'not-configured' });
        const { type, value } = req.body;
        if (type === 'volume' && value === undefined) return reply.code(400).send({ error: 'volume needs a value' });
        try {
          if (type === 'play') await api.call('PUT', '/me/player/play');
          else if (type === 'pause') await api.call('PUT', '/me/player/pause');
          else if (type === 'next') await api.call('POST', '/me/player/next');
          else if (type === 'previous') await api.call('POST', '/me/player/previous');
          else await api.call('PUT', `/me/player/volume?volume_percent=${value}`);
          cached = null;
          return { ok: true };
        } catch (err) {
          const e = commandError(err);
          return reply.code(e.code).send(e.body);
        }
      });

      // Move playback to a device and keep playing. With no deviceId, to spotify.device from config.yaml.
      app.post<{ Body: { deviceId?: string } }>('/api/spotify/transfer', {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: { deviceId: { type: 'string', minLength: 1, maxLength: 100 } },
          },
        },
      }, async (req, reply) => {
        if (!api) return reply.code(503).send({ error: 'not-configured' });
        try {
          let deviceId = req.body?.deviceId;
          if (!deviceId) {
            const body = (await api.call('GET', '/me/player/devices')) as { devices?: SpotifyDevice[] } | null;
            deviceId = body?.devices?.find((d) => d.name === target && d.id)?.id ?? undefined;
            if (!deviceId) {
              log.info({ provider: 'spotify', devices: body?.devices?.length ?? 0 }, 'target speaker not listed by Spotify');
              return reply.code(409).send({ error: 'target-missing' });
            }
          }
          await api.call('PUT', '/me/player', { device_ids: [deviceId], play: true });
          cached = null;
          return { ok: true };
        } catch (err) {
          const e = commandError(err);
          return reply.code(e.code).send(e.body);
        }
      });

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
      if (!config.screens.includes('spotify')) return;
      if (!api) log.warn({ provider: 'spotify' }, 'Spotify not set up: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and SPOTIFY_REFRESH_TOKEN go in .env');
      else if (!target) log.warn({ provider: 'spotify' }, 'spotify.device is not set in config.yaml, so there is no "Play on" speaker');
    },
    stop() {
      art.clear();
    },
  };
}
