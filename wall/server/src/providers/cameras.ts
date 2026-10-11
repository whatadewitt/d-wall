import type { FastifyInstance } from 'fastify';
import { Go2rtc } from '../go2rtc.js';
import { ProtectClient, type ProtectCamera } from '../protect.js';
import { serverState } from '../state.js';
import type { Provider, ProviderDeps } from './types.js';

// The cameras provider (spec section 6): go2rtc relays each camera; grid stills come from a
// StillSource; live view is a WebRTC offer/answer passed through to go2rtc.

const STILL_WIDTH = 640;
const GRID_MS = 2000;   // refresh while the grid is open
const FAST_MS = 1000;   // refresh while full view has fallen back to stills
const WARM_MS = 30_000; // refresh while the tablet is Active or Idle and the grid is closed
const LEASE_MS = 5000;  // a still request keeps its camera "on the grid" this long
const COLD_WAIT_MS = 4000;
const LOOKUP_RETRY_MS = 60_000;
const LOOKUP_REFRESH_MS = 30 * 60_000;
const STATS_MS = 5 * 60_000;

type Quality = 'main' | 'medium' | 'low';

interface Frame { jpeg: Buffer; at: number }

interface Cam {
  id: string;
  name: string;
  doorbell: boolean;
  main: string;                     // go2rtc source for the configured RTSPS address
  sources: Partial<Record<Quality, string>>; // go2rtc source URL per quality
  ready: Set<Quality>;              // qualities registered in go2rtc
  protectId?: string;
  frame?: Frame;
  fetching?: Promise<void>;
  lastFetch: number;
  gridUntil: number;
  fastUntil: number;
}

// A grid still, at most 640 px wide. Two implementations; the milestone 2 spike picks one.
export interface StillSource {
  name: 'protect' | 'go2rtc';
  grab(cam: Cam): Promise<Buffer>;
}

// Protect hands out rtsps://host:7441/<alias>?enableSrtp. go2rtc's rtspx:// is RTSPS without
// certificate checks (the UDM's certificate is self-signed), and it does not want the query.
function toGo2rtc(url: string): string {
  const u = new URL(url);
  if (u.protocol !== 'rtsps:') return url;
  return `rtspx://${u.host}${u.pathname}`;
}

const aliasOf = (url: string) => new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
const withAlias = (url: string, alias: string) => {
  const u = new URL(url);
  u.pathname = `/${alias}`;
  return u.toString();
};

// JPEG width from the first SOF marker, for the spike log (does the source honour 640 px?).
function jpegWidth(b: Buffer): number | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return b.readUInt16BE(i + 7);
    i += 2 + len;
  }
  return null;
}

const usable = (url: string) => /^rtsps?:\/\//.test(url) && !url.includes('<');

export function camerasProvider({ bus, config, log }: ProviderDeps): Provider {
  const options = { stills: config.cameraOptions?.stills ?? 'protect', live: config.cameraOptions?.live ?? 'main' };
  const go2rtc = new Go2rtc(process.env.GO2RTC_URL ?? 'http://go2rtc:1984');
  const cams: Cam[] = config.cameras.filter((c) => usable(c.rtsps)).map((c) => ({
    id: c.id,
    name: c.name,
    doorbell: c.doorbell === true,
    main: toGo2rtc(c.rtsps),
    sources: { main: toGo2rtc(c.rtsps) },
    ready: new Set(),
    lastFetch: 0,
    gridUntil: 0,
    fastUntil: 0,
  }));
  const byId = new Map(cams.map((c) => [c.id, c]));
  const protectHost = config.cameras.find((c) => usable(c.rtsps)) ? new URL(config.cameras.find((c) => usable(c.rtsps))!.rtsps).hostname : '';
  const protect = protectHost && process.env.PROTECT_USERNAME && process.env.PROTECT_PASSWORD
    ? new ProtectClient(protectHost, process.env.PROTECT_USERNAME, process.env.PROTECT_PASSWORD)
    : null;

  const stillSource: StillSource =
    options.stills === 'go2rtc'
      ? { name: 'go2rtc', grab: (cam) => go2rtc.frame(streamName(cam, 'low'), STILL_WIDTH) }
      : {
          name: 'protect',
          grab: (cam) => {
            if (!protect || !cam.protectId) throw new Error('camera not found in Protect');
            return protect.snapshot(cam.protectId, STILL_WIDTH);
          },
        };

  // go2rtc stream names: <id>, <id>_medium, <id>_low. A quality that is not registered falls back to main.
  function streamName(cam: Cam, q: Quality): string {
    if (q !== 'main' && cam.ready.has(q)) return `${cam.id}_${q}`;
    return cam.id;
  }

  // Find each camera in Protect by its RTSPS alias, to learn its medium and low streams and its id.
  async function lookup(): Promise<boolean> {
    if (!protect) return false;
    let list: ProtectCamera[];
    try {
      list = await protect.cameras();
    } catch (err) {
      log.warn({ protect: 'lookup failed', error: err instanceof Error ? err.message : String(err) }, 'cameras: Protect lookup failed');
      return false;
    }
    for (const cam of cams) {
      const conf = config.cameras.find((c) => c.id === cam.id)!;
      const alias = aliasOf(conf.rtsps);
      const p = list.find((pc) => pc.channels?.some((ch) => ch.rtspAlias === alias));
      if (!p) {
        log.warn({ camera: cam.id }, 'cameras: not found in Protect by its RTSPS address');
        continue;
      }
      cam.protectId = p.id;
      const channel = (id: number, name: string) => p.channels.find((ch) => (ch.id === id || ch.name === name) && ch.isRtspEnabled && ch.rtspAlias);
      const medium = channel(1, 'Medium');
      const low = channel(2, 'Low');
      if (medium?.rtspAlias) cam.sources.medium = toGo2rtc(withAlias(conf.rtsps, medium.rtspAlias));
      if (low?.rtspAlias) cam.sources.low = toGo2rtc(withAlias(conf.rtsps, low.rtspAlias));
      // Addresses carry Protect's stream tokens: log only which qualities exist.
      log.info({ camera: cam.id, medium: Boolean(medium), low: Boolean(low) }, 'cameras: found in Protect');
      if (!medium || !low) {
        // What Protect reports for this camera's channels, to see why a quality is missing. No aliases.
        const channels = p.channels.map((ch) => ({ id: ch.id, name: ch.name, rtsps: ch.isRtspEnabled ?? null, alias: Boolean(ch.rtspAlias) }));
        log.info({ camera: cam.id, channels }, 'cameras: Protect channels');
      }
    }
    return true;
  }

  async function sync(): Promise<void> {
    const wanted = new Map<string, string>();
    for (const cam of cams) {
      for (const q of ['main', 'medium', 'low'] as Quality[]) {
        const src = cam.sources[q];
        if (src) wanted.set(q === 'main' ? cam.id : `${cam.id}_${q}`, src);
      }
    }
    try {
      const ok = new Set(await go2rtc.syncStreams(wanted));
      for (const cam of cams) {
        cam.ready = new Set((['main', 'medium', 'low'] as Quality[]).filter((q) => ok.has(q === 'main' ? cam.id : `${cam.id}_${q}`)));
      }
    } catch (err) {
      log.warn({ error: err instanceof Error ? err.message : String(err) }, 'cameras: go2rtc unreachable');
    }
  }

  // Still refresh: 1 s, 2 s or 30 s per camera depending on who is looking (section 6).
  const stats = { grabs: 0, failures: 0, ms: 0, bytes: 0, widths: new Set<number>() };

  function refresh(cam: Cam): Promise<void> {
    if (cam.fetching) return cam.fetching;
    cam.lastFetch = Date.now();
    const started = Date.now();
    cam.fetching = stillSource
      .grab(cam)
      .then((jpeg) => {
        // Either source can answer 200 with an error page or nothing at all.
        if (jpeg.length < 100 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
        cam.frame = { jpeg, at: Date.now() };
        stats.grabs++;
        stats.ms += Date.now() - started;
        stats.bytes += jpeg.length;
        const w = jpegWidth(jpeg);
        if (w) stats.widths.add(w);
      })
      .catch((err) => {
        stats.failures++;
        log.debug({ camera: cam.id, error: err instanceof Error ? err.message : String(err) }, 'still failed');
      })
      .finally(() => {
        cam.fetching = undefined;
      });
    return cam.fetching;
  }

  function tick(): void {
    const now = Date.now();
    const warm = serverState.tablet.state === 'active' || serverState.tablet.state === 'idle';
    for (const cam of cams) {
      const interval = cam.fastUntil > now ? FAST_MS : cam.gridUntil > now ? GRID_MS : warm ? WARM_MS : 0;
      if (interval && now - cam.lastFetch >= interval) void refresh(cam);
    }
  }

  let timers: NodeJS.Timeout[] = [];

  return {
    id: 'cameras',
    topics: [],

    routes(app: FastifyInstance) {
      app.get('/api/cameras', async () => cams.map((c) => ({ id: c.id, name: c.name, doorbell: c.doorbell })));

      app.get<{ Params: { id: string }; Querystring: { fast?: string } }>('/api/cameras/:id/still.jpg', async (req, reply) => {
        const cam = byId.get(req.params.id);
        if (!cam) return reply.code(404).send({ error: 'unknown camera' });
        const now = Date.now();
        if (req.query.fast === '1') cam.fastUntil = now + LEASE_MS;
        else cam.gridUntil = now + LEASE_MS;
        if (!cam.frame) {
          // Cold: grab one now and wait for it briefly.
          await Promise.race([refresh(cam), new Promise((r) => setTimeout(r, COLD_WAIT_MS))]);
        } else if (now - cam.lastFetch >= GRID_MS) {
          void refresh(cam);
        }
        const frame = cam.frame;
        if (!frame) return reply.code(503).send({ error: 'no still yet' });
        const etag = `"${frame.at}"`;
        reply.header('cache-control', 'no-store').header('etag', etag).header('x-frame-at', String(frame.at));
        if (req.headers['if-none-match'] === etag) return reply.code(304).send();
        return reply.type('image/jpeg').send(frame.jpeg);
      });

      app.post<{ Params: { id: string }; Querystring: { quality?: 'low' }; Body: { type: string; sdp: string } }>('/api/cameras/:id/webrtc', {
        schema: {
          querystring: { type: 'object', properties: { quality: { const: 'low' } } }, // grid tiles (cameraOptions.grid: live)
          body: {
            type: 'object',
            required: ['type', 'sdp'],
            properties: { type: { const: 'offer' }, sdp: { type: 'string', maxLength: 15_000 } },
          },
        },
      }, async (req, reply) => {
        const cam = byId.get(req.params.id);
        if (!cam) return reply.code(404).send({ error: 'unknown camera' });
        // Grid tiles ask for low; without it, medium is still far lighter than main for four tiles.
        const tileQuality: Quality | null = req.query.quality === 'low' ? (cam.ready.has('low') ? 'low' : cam.ready.has('medium') ? 'medium' : 'main') : null;
        const quality: Quality = tileQuality ?? (options.live === 'medium' && cam.ready.has('medium') ? 'medium' : 'main');
        try {
          const sdp = await go2rtc.webrtc(streamName(cam, quality), req.body.sdp);
          return { type: 'answer', sdp, stream: quality };
        } catch (err) {
          log.warn({ camera: cam.id, error: err instanceof Error ? err.message : String(err) }, 'webrtc failed');
          return reply.code(502).send({ error: 'live view unavailable' });
        }
      });
    },

    async start() {
      for (const c of config.cameras) if (!usable(c.rtsps)) log.warn({ camera: c.id }, 'cameras: no usable rtsps address in config.yaml; camera skipped');
      if (!cams.length) {
        log.warn({ cameras: 'disabled' }, 'cameras: set each camera\'s rtsps address in config.yaml');
        return;
      }
      if (!protect) log.warn({ protect: 'disabled' }, 'cameras: set PROTECT_USERNAME and PROTECT_PASSWORD in .env for medium and low streams and Protect stills');
      log.info({ stills: stillSource.name, live: options.live }, 'cameras: options');

      const lookupLoop = async () => {
        const ok = await lookup();
        await sync();
        timers.push(setTimeout(lookupLoop, ok ? LOOKUP_REFRESH_MS : LOOKUP_RETRY_MS));
      };
      // A ring: grab a fresh doorbell still at once (the tablet may have been Off, with no warm
      // stills), and keep it on the 1 s refresh until the popup's own requests take over.
      bus.on('doorbell-ring', (id: string) => {
        const cam = byId.get(id);
        if (!cam) return;
        cam.fastUntil = Date.now() + LEASE_MS;
        void refresh(cam);
      });
      await lookupLoop();
      timers.push(setInterval(() => void sync(), 60_000)); // re-adds streams if go2rtc restarts
      timers.push(setInterval(tick, 250));
      // Spike numbers: how fast and how big the stills are from the configured source.
      timers.push(setInterval(() => {
        if (!stats.grabs && !stats.failures) return;
        log.info({
          stills: stillSource.name,
          grabs: stats.grabs,
          failures: stats.failures,
          avgMs: stats.grabs ? Math.round(stats.ms / stats.grabs) : null,
          avgKB: stats.grabs ? Math.round(stats.bytes / stats.grabs / 1024) : null,
          widths: [...stats.widths],
        }, 'still stats');
        Object.assign(stats, { grabs: 0, failures: 0, ms: 0, bytes: 0, widths: new Set() });
      }, STATS_MS));
    },

    stop() {
      for (const t of timers) clearTimeout(t);
      timers = [];
    },
  };
}

