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
  home?: HomeConfig; // milestone 6 (spec section 14)
  debug: { soak: boolean };
}

// Spec section 14. Tile types decide how a tile behaves; lock, garage and alarm need hold-then-confirm.
export const HOME_TYPES = ['light', 'switch', 'fan', 'scene', 'climate', 'cover', 'garage', 'media_player', 'lock', 'alarm', 'sensor'] as const;
export type HomeType = (typeof HOME_TYPES)[number];
export const DEFAULT_ALLOWED_DOMAINS = ['light', 'switch', 'scene', 'climate', 'fan', 'cover', 'media_player', 'lock', 'alarm_control_panel'];
export const MAX_TILES = 60;
export interface HomeConfig {
  hub: 'homeassistant';
  url: string;
  allowedDomains?: string[];
  rooms: { name: string; devices: { id: string; name: string; type: HomeType }[] }[];
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
  photosIntervalSec: number;
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
  if (raw.photos?.intervalSec !== undefined && !(Number(raw.photos.intervalSec) >= 5)) fail('photos.intervalSec must be 5 or more');
  if (raw.home) {
    const h = raw.home;
    if (h.hub !== 'homeassistant') fail('home.hub must be homeassistant');
    if (!Array.isArray(h.rooms)) fail('home.rooms must be a list');
    let tiles = 0;
    for (const room of h.rooms) {
      if (!room?.name || !Array.isArray(room.devices)) fail('each home room needs a name and a devices list');
      for (const d of room.devices) {
        tiles++;
        if (!/^[a-z_]+\.[a-z0-9_]+$/.test(d?.id ?? '')) fail(`home device id "${d?.id}" must be a Home Assistant entity id like light.kitchen`);
        if (!HOME_TYPES.includes(d.type)) fail(`home device ${d.id}: type must be one of ${HOME_TYPES.join(', ')}`);
      }
    }
    if (tiles > MAX_TILES) fail(`home has ${tiles} tiles; the limit is ${MAX_TILES}`);
  }
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
    photosIntervalSec: c.photos?.intervalSec ?? 30,
    soak: c.debug.soak,
  };
}
