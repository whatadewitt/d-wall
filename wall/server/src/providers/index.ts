import type { Provider, ProviderDeps } from './types.js';
import { calendarProvider } from './calendar.js';
import { camerasProvider } from './cameras.js';
import { kioskProvider } from './kiosk.js';

// One line per provider. doorbell and photos arrive in milestones 3 and 4.
export const providers = (deps: ProviderDeps): Provider[] => [
  kioskProvider(deps),
  calendarProvider(deps),
  camerasProvider(deps),
];
