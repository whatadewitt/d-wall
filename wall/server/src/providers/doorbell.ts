import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { serverState } from '../state.js';
import type { Provider, ProviderDeps } from './types.js';

// The doorbell provider (spec section 7). A DoorbellSource emits rings; the provider debounces
// them, keeps doorbell.activeUntil in the state every client receives, wakes the tablet through
// Fully Kiosk and publishes `doorbell.ring`.

const DEBOUNCE_MS = 10_000;
const ACTIVE_MS = 45_000;
const WAKE_ATTEMPTS = 3; // the first try and two retries, 1 s apart
const WAKE_RETRY_MS = 1000;
const HOOK_BODY_LIMIT = 2 * 1024 * 1024; // Protect can attach a base64 thumbnail; it is ignored

export interface Ring { cameraId: string; at: string }

export interface DoorbellSource {
  name: string;
  routes?(app: FastifyInstance): void;
  start(emit: (ring: Ring) => void): void | Promise<void>;
  stop(): void | Promise<void>;
}

// The alarm's trigger keys (for example "ring"), if the body is Protect's JSON. Anything else is fine too.
function triggerKeys(body: unknown): string[] | null {
  if (!Buffer.isBuffer(body) || !body.length) return null;
  try {
    const triggers = (JSON.parse(body.toString('utf8')) as { alarm?: { triggers?: { key?: unknown }[] } }).alarm?.triggers;
    return Array.isArray(triggers) ? triggers.slice(0, 5).map((t) => String(t?.key ?? '')) : null;
  } catch {
    return null;
  }
}

// Protect Alarm Manager webhook: a rule on the doorbell with the ring trigger and a webhook action
// that POSTs to /api/hooks/doorbell with the shared secret in a header.
function webhookSource({ log }: ProviderDeps, cameraId: string): DoorbellSource {
  const secret = process.env.DOORBELL_WEBHOOK_SECRET ?? '';
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const expected = digest(secret);
  let emit: ((ring: Ring) => void) | null = null;

  function presented(headers: Record<string, string | string[] | undefined>): string {
    const h = headers['x-doorbell-secret'];
    if (typeof h === 'string') return h;
    const auth = headers.authorization;
    return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
  }

  return {
    name: 'webhook',
    routes(app) {
      // Its own scope, so the body is taken as raw bytes whatever content type Protect sends.
      void app.register(async (scope) => {
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: HOOK_BODY_LIMIT }, (_req, body, done) => done(null, body));
        scope.post('/api/hooks/doorbell', async (req, reply) => {
          if (!secret) return reply.code(503).send({ error: 'webhook secret not set' });
          // Compare digests so the check takes the same time whatever was sent.
          if (!timingSafeEqual(digest(presented(req.headers)), expected)) {
            log.warn({ doorbell: 'webhook', reason: 'bad secret' }, 'doorbell: webhook refused');
            return reply.code(401).send({ error: 'unauthorized' });
          }
          // Only the trigger keys are logged: Protect's payload also carries a thumbnail and device ids.
          const triggers = triggerKeys(req.body);
          log.info({ doorbell: 'webhook', triggers }, 'doorbell: webhook received');
          emit?.({ cameraId, at: new Date().toISOString() });
          return { ok: true };
        });
      });
    },
    start(fn) {
      emit = fn;
      if (!secret) log.warn({ doorbell: 'webhook' }, 'doorbell: set DOORBELL_WEBHOOK_SECRET in .env; the webhook refuses every call until then');
    },
    stop() {
      emit = null;
    },
  };
}

export function doorbellProvider(deps: ProviderDeps): Provider {
  const { bus, config, hub, kiosk, log, publishState } = deps;
  const cameraId = config.cameras.find((c) => c.doorbell)?.id ?? '';
  const source = webhookSource(deps, cameraId);
  let lastRing = 0;

  // Turn the screen on and bring Fully to the front; retry twice, 1 s apart. Never blocks the ring.
  async function wake(): Promise<void> {
    if (!kiosk.enabled) return;
    const started = Date.now();
    for (let attempt = 1; attempt <= WAKE_ATTEMPTS; attempt++) {
      const on = await kiosk.screenOn();
      const front = await kiosk.toForeground();
      if (on.ok && front.ok) {
        log.info({ doorbell: 'wake', attempt, ms: Date.now() - started }, 'doorbell: tablet woken');
        return;
      }
      if (attempt < WAKE_ATTEMPTS) await new Promise((r) => setTimeout(r, WAKE_RETRY_MS));
      else log.warn({ doorbell: 'wake', attempts: attempt, screenOn: on.error ?? 'ok', toForeground: front.error ?? 'ok' }, 'doorbell: could not wake the tablet');
    }
  }

  function ring(r: Ring): void {
    const now = Date.now();
    if (now - lastRing < DEBOUNCE_MS) {
      log.info({ doorbell: 'debounced', sinceMs: now - lastRing }, 'doorbell: ring ignored');
      return;
    }
    lastRing = now;
    serverState.doorbell = { activeUntil: new Date(now + ACTIVE_MS).toISOString(), at: r.at, cameraId: r.cameraId };
    log.info({ doorbell: 'ring', source: source.name, clients: hub.size }, 'doorbell: ring');
    // The Fully calls can take seconds; the event goes out at once so a page that is awake
    // (or asleep with its event stream still open) can show the popup in parallel.
    void wake();
    bus.emit('doorbell-ring', r.cameraId); // the cameras provider grabs a fresh still for the popup
    hub.publish('doorbell.ring', r);
    publishState();
  }

  return {
    id: 'doorbell',
    topics: ['doorbell.ring'],
    routes(app) {
      source.routes?.(app);
    },
    async start() {
      if (!cameraId) log.warn({ doorbell: 'disabled' }, 'doorbell: mark one camera with doorbell: true in config.yaml');
      await source.start(ring);
      log.info({ doorbell: source.name, cameraId: cameraId || null }, 'doorbell: source started');
    },
    async stop() {
      await source.stop();
    },
  };
}
