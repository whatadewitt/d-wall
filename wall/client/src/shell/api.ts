import type { ServerSnapshot } from './config';

// Shell-only HTTP helpers. Screens use ctx.fetch instead.
export async function getState(): Promise<ServerSnapshot> {
  const res = await fetch('/api/state', { cache: 'no-store' });
  if (!res.ok) throw new Error(`GET /api/state ${res.status}`);
  return res.json() as Promise<ServerSnapshot>;
}

export function post(path: string, body: unknown): void {
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {
    // The server may be down; the heartbeat watchdog (milestone 5) handles silence.
  });
}
