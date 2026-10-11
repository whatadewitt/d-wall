import type { Provider, ProviderDeps } from './types.js';
import { calendarProvider } from './calendar.js';
import { camerasProvider } from './cameras.js';
import { doorbellProvider } from './doorbell.js';
import { kioskProvider } from './kiosk.js';

// One line per provider.
export const providers = (deps: ProviderDeps): Provider[] => [
  kioskProvider(deps),
  calendarProvider(deps),
  camerasProvider(deps),
  doorbellProvider(deps),
];
