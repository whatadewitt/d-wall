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
  calendars: { id: string; name?: string; googleId: string; color: string }[];
  cameras: { id: string; name: string; rtsps: string; doorbell?: boolean }[];
  cameraOptions?: { stills?: 'protect' | 'go2rtc'; live?: 'main' | 'medium'; grid?: 'stills' | 'live' }; // milestone 2 spikes
  doorbell?: { sound?: boolean }; // milestone 3: a ding on the tablet for a live ring
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
  calendars: { id: string; name: string; color: string }[];
  cameraGrid: 'stills' | 'live'; // experiment: live low-res video in the grid tiles
  doorbellSound: boolean;
  soak: boolean;
}

// The real file lives in wall/config/ (git-ignored); the repo has only config.example.yaml.
export const configPath = process.env.CONFIG_PATH ?? resolve(process.cwd(), '../config/config.yaml');

export function loadConfig(path = configPath): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`no config at ${path}: copy wall/config.example.yaml to wall/config/config.yaml and fill it in`);
  }
  const raw = parse(text) as Partial<Config>;
  const fail = (what: string): never => {
    throw new Error(`config.yaml: ${what}`);
  };
  if (!Number.isInteger(raw.server?.port)) fail('server.port must be an integer');
  if (!Array.isArray(raw.screens)) fail('screens must be a list');
  if (!(Number(raw.idle?.toIdleSec) > 0) || !(Number(raw.idle?.toOffMin) > 0)) fail('idle.toIdleSec and idle.toOffMin must be positive');
  if (raw.clock !== '12h' && raw.clock !== '24h') fail('clock must be 12h or 24h');
  if (typeof raw.timezone !== 'string') fail('timezone is required');
  const stills = raw.cameraOptions?.stills;
  const live = raw.cameraOptions?.live;
  if (stills !== undefined && stills !== 'protect' && stills !== 'go2rtc') fail('cameraOptions.stills must be protect or go2rtc');
  if (live !== undefined && live !== 'main' && live !== 'medium') fail('cameraOptions.live must be main or medium');
  const grid = raw.cameraOptions?.grid;
  if (grid !== undefined && grid !== 'stills' && grid !== 'live') fail('cameraOptions.grid must be stills or live');
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
    calendars: c.calendars.map(({ id, name, color }) => ({ id, name: name ?? id, color })),
    cameraGrid: c.cameraOptions?.grid ?? 'stills',
    doorbellSound: c.doorbell?.sound === true,
    soak: c.debug.soak,
  };
}
