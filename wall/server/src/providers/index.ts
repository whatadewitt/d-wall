import type { Provider, ProviderDeps } from './types.js';
import { kioskProvider } from './kiosk.js';

// One line per provider. calendar, cameras, doorbell and photos arrive in milestones 1 to 4.
export const providers = (deps: ProviderDeps): Provider[] => [
  kioskProvider(deps),
];
