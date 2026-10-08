import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

// Shape of config.yaml (spec section 10). Later milestones read the sections they own.
export interface Config {
  server: { port: number };
  timezone: string;
  weekStart: number;
  clock: '12h' | '24h';
  screens: string[];
  idle: { toIdleSec: number; toOffMin: number; quietHours: { from: string; to: string } };
  calendars: { id: string; googleId: string; color: string }[];
  cameras: { id: string; name: string; rtsps: string; doorbell?: boolean }[];
  kiosk: { host: string; port: number };
  photos: { source: string; path: string; intervalSec: number };
  debug: { soak: boolean };
}

// What the client receives in GET /api/state. Never includes addresses, ids or secrets.
// Mirrored in client/src/shell/config.ts.
export interface ClientConfig {
  timezone: string;
  weekStart: number;
  clock: '12h' | '24h';
  screens: string[];
  idle: Config['idle'];
  calendars: { id: string; color: string }[];
  soak: boolean;
}

export const configPath = process.env.CONFIG_PATH ?? resolve(process.cwd(), '../config.yaml');

export function loadConfig(path = configPath): Config {
  const raw = parse(readFileSync(path, 'utf8')) as Partial<Config>;
  const fail = (what: string): never => {
    throw new Error(`config.yaml: ${what}`);
  };
  if (!Number.isInteger(raw.server?.port)) fail('server.port must be an integer');
  if (!Array.isArray(raw.screens)) fail('screens must be a list');
  if (!(Number(raw.idle?.toIdleSec) > 0) || !(Number(raw.idle?.toOffMin) > 0)) fail('idle.toIdleSec and idle.toOffMin must be positive');
  if (raw.clock !== '12h' && raw.clock !== '24h') fail('clock must be 12h or 24h');
  if (typeof raw.timezone !== 'string') fail('timezone is required');
  return {
    ...(raw as Config),
    calendars: raw.calendars ?? [],
    cameras: raw.cameras ?? [],
    kiosk: { host: raw.kiosk?.host ?? '', port: raw.kiosk?.port ?? 2323 },
    debug: { soak: raw.debug?.soak === true },
  };
}

export function clientConfig(c: Config): ClientConfig {
  return {
    timezone: c.timezone,
    weekStart: c.weekStart,
    clock: c.clock,
    screens: c.screens,
    idle: c.idle,
    calendars: c.calendars.map(({ id, color }) => ({ id, color })),
    soak: c.debug.soak,
  };
}
