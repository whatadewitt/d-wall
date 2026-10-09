export type TabletState = 'active' | 'idle' | 'off';

// Server-side state that every client receives on connect (GET /api/state) and on change (`state` event).
export const serverState = {
  tablet: { state: null as TabletState | null, since: null as string | null },
  doorbell: { activeUntil: null as string | null }, // milestone 3
  calendar: { lastSuccess: null as string | null, stale: false }, // milestone 1
};
