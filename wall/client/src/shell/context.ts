import type { ScreenContext } from '../screens/types';
import type { ClientConfig } from './config';
import { subscribe } from './events';
import { every } from './timers';

export interface ContextDeps {
  config: Readonly<ClientConfig>;
  go(screenId: string): void;
  touch(): void;
}

// Builds the context a screen receives, and the dispose() that releases everything it handed out.
export function createScreenContext(owner: string, deps: ContextDeps): { ctx: ScreenContext; dispose(): void } {
  const controller = new AbortController();
  const { signal } = controller;
  const releases: (() => void)[] = [];

  const ctx: ScreenContext = {
    signal,
    subscribe(topic, fn) {
      if (!signal.aborted) releases.push(subscribe(topic, fn, owner));
    },
    every(ms, fn) {
      if (!signal.aborted) releases.push(every(ms, fn, owner));
    },
    fetch(input, init) {
      const own = init?.signal;
      const bound = own && 'any' in AbortSignal ? AbortSignal.any([signal, own]) : signal;
      return fetch(input, { ...init, signal: bound });
    },
    config: deps.config,
    go(screenId) {
      if (!signal.aborted) deps.go(screenId);
    },
    touch() {
      if (!signal.aborted) deps.touch();
    },
  };

  return {
    ctx,
    dispose() {
      // Abort first so the screen's own abort handlers (e.g. render(null, root)) run, then release.
      controller.abort();
      for (const release of releases.splice(0)) release();
    },
  };
}
