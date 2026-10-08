// The screen contract (spec section 4). Do not change without updating the spec.
import type { ClientConfig } from '../shell/config';

export interface Screen {
  id: string;                 // 'calendar'
  title: string;
  icon: string;               // icon name shown in the rail
  load: () => Promise<{ mount: Mount }>;   // dynamic import, one bundle per screen
}

export type Mount = (root: HTMLElement, ctx: ScreenContext) => void | Promise<void>;

export interface ScreenContext {
  signal: AbortSignal;                                   // aborts on unmount
  subscribe(topic: string, fn: (msg: unknown) => void): void;  // released on unmount
  every(ms: number, fn: () => void): void;               // timer cleared on unmount
  fetch: typeof fetch;                                   // bound to signal
  config: Readonly<ClientConfig>;
  go(screenId: string): void;                            // switch screen
  touch(): void;                                         // reset the idle clock
}
