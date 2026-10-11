import type { Provider, ProviderDeps } from './types.js';
import { calendarProvider } from './calendar.js';
import { camerasProvider } from './cameras.js';
import { doorbellProvider } from './doorbell.js';
import { kioskProvider } from './kiosk.js';
import { photosProvider } from './photos.js';
import { spotifyProvider } from './spotify.js';

// One line per provider.
export const providers = (deps: ProviderDeps): Provider[] => [
  kioskProvider(deps),
  calendarProvider(deps),
  camerasProvider(deps),
  doorbellProvider(deps),
  photosProvider(deps),
  spotifyProvider(deps),
];
