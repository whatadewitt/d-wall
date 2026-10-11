import type { FastifyInstance } from 'fastify';
import { DEFAULT_ALLOWED_DOMAINS, type HomeType } from '../config.js';
import { HomeAssistant, serviceFor, type Command, type DeviceHub } from '../homeassistant.js';
import type { Provider, ProviderDeps } from './types.js';

// The home provider (spec section 14): pinned devices from config.yaml, room by room, through a DeviceHub.
// Commands are accepted only for pinned devices in an allowed domain, whatever the client asks.

const RISKY: HomeType[] = ['lock', 'garage', 'alarm']; // hold-then-confirm on the tablet; every command logged
const READ_ONLY: HomeType[] = ['sensor'];

export function homeProvider({ config, hub, log }: ProviderDeps): Provider {
  const home = config.home;
  const allowed = new Set(home?.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS);
  const pinned = new Map((home?.rooms ?? []).flatMap((r) => r.devices.map((d) => [d.id, d] as const)));
  let deviceHub: (DeviceHub & { start(): void; stop(): void }) | null = null;

  return {
    id: 'home',
    topics: ['home.changed'],

    routes(app: FastifyInstance) {
      app.get('/api/home/devices', async () => {
        const states = new Map((deviceHub?.list() ?? []).map((s) => [s.id, s]));
        return {
          connected: deviceHub?.connected ?? false,
          rooms: (home?.rooms ?? []).map((r) => ({
            name: r.name,
            devices: r.devices.map((d) => ({ ...d, state: states.get(d.id) ?? { id: d.id, state: 'unavailable', available: false } })),
          })),
        };
      });

      app.post<{ Params: { id: string }; Body: Command }>('/api/home/devices/:id/command', {
        schema: {
          body: {
            type: 'object',
            required: ['type'],
            additionalProperties: false,
            properties: {
              type: { enum: ['on', 'off', 'toggle', 'brightness', 'scene', 'temperature'] },
              pct: { type: 'number', minimum: 0, maximum: 100 },
              value: { type: 'number', minimum: 5, maximum: 35 },
            },
          },
        },
      }, async (req, reply) => {
        const device = pinned.get(req.params.id);
        if (!device) return reply.code(404).send({ error: 'not a pinned device' });
        const domain = device.id.split('.')[0];
        const cmd = req.body;
        if (READ_ONLY.includes(device.type) || !allowed.has(domain)) return reply.code(403).send({ error: 'this device is read-only here' });
        if ((cmd.type === 'brightness' && typeof cmd.pct !== 'number') || (cmd.type === 'temperature' && typeof cmd.value !== 'number') || !serviceFor(domain, cmd)) {
          return reply.code(400).send({ error: 'command not valid for this device' });
        }
        if (!deviceHub?.connected) return reply.code(503).send({ error: 'Home Assistant unavailable' });
        if (RISKY.includes(device.type)) log.info({ home: 'risky command', device: device.id, command: cmd.type, at: new Date().toISOString() }, 'home: lock, garage or alarm command');
        try {
          await deviceHub.command(device.id, cmd);
          return { ok: true };
        } catch (err) {
          log.warn({ device: device.id, command: cmd.type, error: err instanceof Error ? err.message : String(err) }, 'home: command failed');
          return reply.code(502).send({ error: 'command failed' });
        }
      });
    },

    start() {
      if (!home || !pinned.size) return;
      const token = process.env.HA_TOKEN;
      if (!token || !home.url || home.url.includes('<')) {
        log.warn({ home: 'disabled' }, 'home: set home.url in config.yaml and HA_TOKEN in .env');
        return;
      }
      deviceHub = new HomeAssistant(home.url, token, new Set(pinned.keys()), log);
      // Only the devices that changed (section 14).
      deviceHub.subscribe((change) => hub.publish('home.changed', { devices: [change] }));
      deviceHub.start();
    },

    stop() {
      deviceHub?.stop();
    },
  };
}
