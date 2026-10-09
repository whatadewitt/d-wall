import { resolve } from 'node:path';
import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import { clientConfig, configPath, loadConfig } from './config.js';
import { Hub } from './hub.js';
import { serverState, type TabletState } from './state.js';
import { createKioskController } from './providers/kiosk.js';
import { providers as createProviders } from './providers/index.js';

const config = loadConfig();
const app = Fastify({
  // Structured JSON logs. No request logging: URLs and bodies stay out of the log.
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  logController: new LogController({ disableRequestLogging: true }),
  bodyLimit: 16 * 1024,
});
const log = app.log;
log.info({ configPath, port: config.server.port, soak: config.debug.soak }, 'config loaded');

// Request logging is off, which also silences Fastify's error logs, so log errors here by route pattern.
app.addHook('onError', async (req, _reply, err) => {
  log.error({ route: req.routeOptions.url, method: req.method, err: { message: err.message, code: err.code } }, 'request error');
});

const hub = new Hub();
const kiosk = createKioskController(config.kiosk, process.env.FULLY_KIOSK_PASSWORD, log);
const providers = createProviders({ config, hub, log, kiosk });

const snapshot = () => ({ ...serverState, serverTime: new Date().toISOString(), config: clientConfig(config) });

app.get('/healthz', async () => ({ ok: true }));

app.get('/api/state', async () => snapshot());

app.get('/api/events', (req, reply) => hub.attach(req, reply));

app.post<{ Body: { state: TabletState; via?: string } }>('/api/state', {
  schema: {
    body: {
      type: 'object',
      required: ['state'],
      additionalProperties: false,
      properties: {
        state: { enum: ['active', 'idle', 'off'] },
        via: { type: 'string', maxLength: 40 }, // what woke the page, for the milestone 0 wake spike
      },
    },
  },
}, async (req) => {
  const { state, via } = req.body;
  serverState.tablet = { state, since: new Date().toISOString() };
  log.info({ tablet: state, via }, 'tablet state');
  if (state === 'off') void kiosk.screenOff();
  hub.publish('state', snapshot());
  return { ok: true };
});

// Client heartbeat (spec section 11), once a minute.
app.post('/api/telemetry', {
  schema: {
    body: {
      type: 'object',
      additionalProperties: false,
      properties: {
        screen: { type: ['string', 'null'], maxLength: 40 },
        state: { type: 'string', maxLength: 10 },
        uptimeSec: { type: 'number' },
        heapMB: { type: ['number', 'null'] },
        heapLimitMB: { type: ['number', 'null'] },
        domNodes: { type: 'integer' },
        subs: { type: 'integer' },
        timers: { type: 'integer' },
        leaks: { type: 'integer' },
        viewport: {
          type: 'object',
          additionalProperties: false,
          properties: { w: { type: 'number' }, h: { type: 'number' }, dpr: { type: 'number' }, screenW: { type: 'number' }, screenH: { type: 'number' } },
        },
        soakCycles: { type: ['integer', 'null'] },
        signals: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { kind: { type: 'string', maxLength: 30 }, at: { type: 'string', maxLength: 30 } },
          },
        },
      },
    },
  },
}, async (req) => {
  log.info({ telemetry: req.body }, 'heartbeat');
  return { ok: true };
});

for (const p of providers) p.routes(app);

// The built client. Hashed bundles are cached for a year, so each screen's code loads over
// the network only once (spec section 4). index.html is never cached.
await app.register(fastifyStatic, {
  root: process.env.CLIENT_DIST ?? resolve(process.cwd(), '../client/dist'),
  cacheControl: false,
  setHeaders(res, path) {
    res.setHeader('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
});

for (const p of providers) await p.start();

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  for (const p of providers) await p.stop();
  hub.close();
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.server.port, host: process.env.HOST ?? '0.0.0.0' });
