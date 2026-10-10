import type { Provider, ProviderDeps } from './types.js';
import { calendarProvider } from './calendar.js';
import { kioskProvider } from './kiosk.js';

// One line per provider. cameras, doorbell and photos arrive in milestones 2 to 4.
export const providers = (deps: ProviderDeps): Provider[] => [
  kioskProvider(deps),
  calendarProvider(deps),
];
