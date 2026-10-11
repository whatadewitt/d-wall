// Home Assistant, the first DeviceHub (spec section 14). State comes over HA's WebSocket API,
// filtered to the pinned entities; commands go over its REST API. Signs in as a dedicated
// non-admin user with a long-lived token. Uses Node's built-in WebSocket, so no dependency.

export interface DeviceState {
  id: string;
  state: string; // Home Assistant's state: on, off, locked, open, heat, armed_away … or unavailable
  available: boolean;
  brightness?: number; // 0-100, lights
  current?: number;    // climate: room temperature; sensor: numeric value
  target?: number;     // climate: set point
  unit?: string;
  action?: string;     // climate: heating, cooling, idle
}

// Section 14's command set, plus a set point for thermostats.
export type Command =
  | { type: 'on' } | { type: 'off' } | { type: 'toggle' }
  | { type: 'brightness'; pct: number } | { type: 'scene' }
  | { type: 'temperature'; value: number };

export interface DeviceHub {
  list(): DeviceState[];
  subscribe(fn: (change: DeviceState) => void): () => void;
  command(id: string, cmd: Command): Promise<void>;
  readonly connected: boolean;
}

interface HaState { entity_id: string; state: string; attributes?: Record<string, unknown> }
type Log = { info(o: object, m: string): void; warn(o: object, m: string): void };

const BACKOFF_SEC = [1, 2, 5, 10, 30]; // section 11, as the event stream
const TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 10_000;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function toDeviceState(s: HaState): DeviceState {
  const a = s.attributes ?? {};
  const domain = s.entity_id.split('.')[0];
  const out: DeviceState = { id: s.entity_id, state: s.state, available: s.state !== 'unavailable' && s.state !== 'unknown' };
  const b = num(a.brightness);
  if (domain === 'light' && b !== undefined) out.brightness = Math.round((b / 255) * 100);
  if (domain === 'climate') {
    out.current = num(a.current_temperature);
    out.target = num(a.temperature);
    if (typeof a.hvac_action === 'string') out.action = a.hvac_action;
  } else {
    const n = Number(s.state);
    if (s.state !== '' && Number.isFinite(n)) out.current = n;
  }
  if (typeof a.unit_of_measurement === 'string') out.unit = a.unit_of_measurement;
  return out;
}

// Which Home Assistant service carries a command for a domain. null: not allowed for that domain.
export function serviceFor(domain: string, cmd: Command): { service: string; data: Record<string, unknown> } | null {
  const onOff = (on: string, off: string, toggle?: string) =>
    cmd.type === 'on' ? { service: on, data: {} } : cmd.type === 'off' ? { service: off, data: {} } : cmd.type === 'toggle' && toggle ? { service: toggle, data: {} } : null;
  switch (domain) {
    case 'light':
      if (cmd.type === 'brightness') return { service: 'turn_on', data: { brightness_pct: Math.max(1, Math.min(100, Math.round(cmd.pct))) } };
      return onOff('turn_on', 'turn_off', 'toggle');
    case 'switch':
    case 'fan':
    case 'media_player':
      return onOff('turn_on', 'turn_off', 'toggle');
    case 'scene':
      return cmd.type === 'scene' ? { service: 'turn_on', data: {} } : null;
    case 'climate':
      if (cmd.type === 'temperature') return { service: 'set_temperature', data: { temperature: cmd.value } };
      return onOff('turn_on', 'turn_off');
    case 'cover':
      return onOff('open_cover', 'close_cover', 'toggle');
    case 'lock':
      return onOff('lock', 'unlock');
    case 'alarm_control_panel':
      return onOff('alarm_arm_away', 'alarm_disarm');
    default:
      return null;
  }
}

export class HomeAssistant implements DeviceHub {
  private states = new Map<string, DeviceState>();
  private listeners = new Set<(change: DeviceState) => void>();
  private ws: WebSocket | null = null;
  private retry: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopped = false;
  private live = false;

  constructor(
    private url: string,
    private token: string,
    private entities: Set<string>,
    private log: Log,
  ) {
    for (const id of entities) this.states.set(id, { id, state: 'unavailable', available: false });
  }

  get connected(): boolean {
    return this.live;
  }

  list(): DeviceState[] {
    return [...this.states.values()];
  }

  subscribe(fn: (change: DeviceState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(next: DeviceState): void {
    const prev = this.states.get(next.id);
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
    this.states.set(next.id, next);
    for (const fn of this.listeners) fn(next);
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    try {
      this.ws?.close();
    } catch {
      // not open
    }
  }

  private open(): void {
    const ws = new WebSocket(`${this.url.replace(/^http/, 'ws').replace(/\/$/, '')}/api/websocket`);
    this.ws = ws;
    let id = 0;
    const send = (msg: object) => ws.send(JSON.stringify(msg));
    ws.onmessage = (ev) => {
      let msg: { type: string; id?: number; success?: boolean; result?: unknown; event?: { data?: { new_state?: HaState | null; entity_id?: string } }; message?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'auth_required') return send({ type: 'auth', access_token: this.token });
      if (msg.type === 'auth_invalid') {
        // Never log the token; the message says why (expired, revoked).
        this.log.warn({ home: 'auth rejected', reason: msg.message }, 'home: Home Assistant rejected the token');
        return end();
      }
      if (msg.type === 'auth_ok') {
        this.attempt = 0;
        this.live = true;
        send({ id: ++id, type: 'get_states' });
        send({ id: ++id, type: 'subscribe_events', event_type: 'state_changed' });
        this.log.info({ home: 'connected', entities: this.entities.size }, 'home: connected to Home Assistant');
        return;
      }
      if (msg.type === 'result' && Array.isArray(msg.result)) {
        const seen = new Set<string>();
        for (const s of msg.result as HaState[]) {
          if (!this.entities.has(s.entity_id)) continue;
          seen.add(s.entity_id);
          this.set(toDeviceState(s));
        }
        const missing = [...this.entities].filter((e) => !seen.has(e));
        if (missing.length) this.log.warn({ home: 'missing entities', missing }, 'home: pinned devices not found in Home Assistant (or not visible to its user)');
        return;
      }
      if (msg.type === 'event') {
        const s = msg.event?.data?.new_state;
        const eid = msg.event?.data?.entity_id;
        if (eid && this.entities.has(eid)) this.set(s ? toDeviceState(s) : { id: eid, state: 'unavailable', available: false });
      }
    };
    // Node's WebSocket fires only `error` when the connection is refused (no `close`), so both end
    // the attempt, once. A connection that never finishes signing in is given up on after 10 s.
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(connecting);
      ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed or never opened
      }
      if (this.ws === ws) this.ws = null;
      const was = this.live;
      this.live = false;
      // While Home Assistant restarts, tiles show as unavailable and recover on their own (section 14).
      for (const st of this.states.values()) if (st.available) this.set({ id: st.id, state: 'unavailable', available: false });
      if (this.stopped) return;
      const base = BACKOFF_SEC[Math.min(this.attempt++, BACKOFF_SEC.length - 1)];
      if (was) this.log.warn({ home: 'disconnected' }, 'home: lost Home Assistant, reconnecting');
      this.retry = setTimeout(() => this.open(), base * 1000 * (0.8 + Math.random() * 0.4));
    };
    const connecting = setTimeout(() => {
      if (!this.live) end();
    }, CONNECT_TIMEOUT_MS);
    ws.onclose = end;
    ws.onerror = end;
  }

  async command(id: string, cmd: Command): Promise<void> {
    const domain = id.split('.')[0];
    const call = serviceFor(domain, cmd);
    if (!call) throw new Error('command not valid for this device');
    const res = await fetch(`${this.url.replace(/\/$/, '')}/api/services/${domain}/${call.service}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ entity_id: id, ...call.data }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Home Assistant ${res.status}`);
  }
}
