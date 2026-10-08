// Every interval in the client goes through here so the heartbeat can count them
// and the shell can check that an unmounted screen left none behind.
const live = new Map<number, string>(); // interval id -> owner

export function every(ms: number, fn: () => void, owner = 'shell'): () => void {
  const id = window.setInterval(fn, ms);
  live.set(id, owner);
  return () => {
    window.clearInterval(id);
    live.delete(id);
  };
}

export function timerCount(owner?: string): number {
  if (owner === undefined) return live.size;
  let n = 0;
  for (const o of live.values()) if (o === owner) n++;
  return n;
}
