// Wake-related signals with timestamps, sent with the next heartbeat. They answer the
// milestone 0 spike: which of these does the page actually see when the screen turns on or off?
const pending: { kind: string; at: string }[] = [];

export function signal(kind: string): void {
  pending.push({ kind, at: new Date().toISOString() });
  if (pending.length > 50) pending.shift();
}

export function takeSignals(): { kind: string; at: string }[] {
  return pending.splice(0);
}
