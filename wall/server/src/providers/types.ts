import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Hub } from '../hub.js';
import type { KioskController } from './kiosk.js';

export interface ProviderDeps {
  config: Config;
  hub: Hub;
  log: FastifyBaseLogger;
  kiosk: KioskController;
}

// Spec section 4, step 3: each data source is a provider with routes, topics, start() and stop().
export interface Provider {
  id: string;
  topics: readonly string[];
  routes(app: FastifyInstance): void;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}
