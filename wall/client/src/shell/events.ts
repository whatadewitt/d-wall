// The one event-stream client (GET /api/events). Screens reach it only through ctx.subscribe.
// Reconnects with backoff of 1, 2, 5, 10 and 30 s with jitter (spec section 11). The server sends
// `ping` every 25 s, so a stream with nothing for 60 s has died without an error and is reopened.
import { every } from './timers';

type Handler = (msg: unknown) => void;
interface Entry { fn: Handler; owner: string }

const topics = new Map<string, Set<Entry>>();
const BACKOFF_SEC = [1, 2, 5, 10, 30];
const SILENT_MS = 60_000;

let source: EventSource | null = null;
let bound = new Set<string>();
let attempt = 0;
let retry = 0; // the pending backoff timeout
let lastMessage = 0;
let onOpen: () => void = () => {};

const heard = () => {
  lastMessage = Date.now();
};

function dispatch(ev: Event): void {
  heard();
  const { type, data } = ev as MessageEvent<string>;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  emit(type, msg);
}

// Deliver a message as if it came from the stream (used for the /api/state refetch on reconnect).
export function emit(topic: string, msg: unknown): void {
  for (const { fn } of [...(topics.get(topic) ?? [])]) {
    try {
      fn(msg);
    } catch (err) {
      console.error(`subscriber for ${topic} threw`, err);
    }
  }
}

function bind(topic: string): void {
  if (!source || bound.has(topic)) return;
  source.addEventListener(topic, dispatch);
  bound.add(topic);
}

function open(): void {
  window.clearTimeout(retry);
  source?.close();
  source = new EventSource('/api/events');
  heard(); // the silence clock also covers a connect that never completes
  bound = new Set();
  source.addEventListener('ping', heard);
  for (const topic of topics.keys()) bind(topic);
  source.onopen = () => {
    attempt = 0;
    heard();
    onOpen();
  };
  source.onerror = () => {
    source?.close();
    source = null;
    const base = BACKOFF_SEC[Math.min(attempt++, BACKOFF_SEC.length - 1)];
    retry = window.setTimeout(open, base * 1000 * (0.8 + Math.random() * 0.4));
  };
}

// True while the stream is open and has heard from the server recently.
export function streamLive(): boolean {
  return source?.readyState === EventSource.OPEN && Date.now() - lastMessage < SILENT_MS;
}

// Reopens the stream if it has been silent for longer than maxAgeMs. On a wake the shell calls it
// with a shorter age, and it also skips any backoff wait, so a ring is not missed after sleep.
export function checkStream(maxAgeMs = SILENT_MS, skipBackoff = false): void {
  if (!source) {
    if (skipBackoff) open();
    return;
  }
  if (Date.now() - lastMessage > maxAgeMs) open();
}

export function connect(opened: () => void): void {
  onOpen = opened;
  open();
  every(15_000, () => checkStream());
}

export function subscribe(topic: string, fn: Handler, owner = 'shell'): () => void {
  let set = topics.get(topic);
  if (!set) topics.set(topic, (set = new Set()));
  const entry = { fn, owner };
  set.add(entry);
  bind(topic);
  return () => {
    set.delete(entry);
    // The EventSource listener stays bound to the topic name; it costs nothing without handlers.
  };
}

export function subscriptionCount(owner?: string): number {
  let n = 0;
  for (const set of topics.values()) for (const e of set) if (owner === undefined || e.owner === owner) n++;
  return n;
}
