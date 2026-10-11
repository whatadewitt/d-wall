export type TabletState = 'active' | 'idle' | 'off';

// Server-side state that every client receives on connect (GET /api/state) and on change (`state` event).
export const serverState = {
  tablet: { state: null as TabletState | null, since: null as string | null },
  // activeUntil is the spec's field; at and cameraId identify the ring, so a client knows a ring it
  // already showed or dismissed from a new one, and can say when it rang (milestone 3).
  doorbell: { activeUntil: null as string | null, at: null as string | null, cameraId: null as string | null },
  calendar: { lastSuccess: null as string | null, stale: false }, // milestone 1
};
