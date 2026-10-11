import type { Screen } from './types';

// One entry per screen. The rail shows the ids listed under `screens:` in config.yaml, in that order.
export const registry: Screen[] = [
  { id: 'calendar', title: 'Calendar', icon: 'calendar', load: () => import('./calendar') },
  { id: 'cameras', title: 'Cameras', icon: 'camera', load: () => import('./cameras') },
  // Not in the rail: the shell mounts it while the tablet is Idle (section 8).
  { id: 'photos', title: 'Photos', icon: 'photo', load: () => import('./photos') },
  { id: 'example-clock', title: 'Clock', icon: 'clock', load: () => import('./example-clock') },
];
