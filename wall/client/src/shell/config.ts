// Mirrors ClientConfig in server/src/config.ts. Arrives with GET /api/state.
export interface ClientConfig {
  timezone: string;
  weekStart: number;
  clock: '12h' | '24h';
  screens: string[];
  idle: { toIdleSec: number; toOffMin: number; quietHours: { from: string; to: string } };
  calendars: { id: string; color: string }[];
  soak: boolean;
}

export interface ServerSnapshot {
  serverTime: string;
  tablet: { state: string | null; since: string | null };
  doorbell: { activeUntil: string | null };
  calendar: { lastSuccess: string | null; stale: boolean };
  config: ClientConfig;
}
