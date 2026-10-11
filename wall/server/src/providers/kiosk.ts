import type { Config } from '../config.js';
import { inQuietHours } from '../time.js';
import type { Provider, ProviderDeps } from './types.js';

// Kiosk controller (spec section 10): a thin wrapper over Fully Kiosk's Remote Admin REST API.
// Every call has a 3 second timeout. Failures are logged and returned, never thrown.
// Command names and setting keys are not yet confirmed against the installed Fully Kiosk
// version; see docs/reports/milestone-0.md.

const TIMEOUT_MS = 3000;

// Unconfirmed setting key for motion detection (spec section 8, quiet hours).
export const MOTION_DETECTION_KEY = 'motionDetection';

export interface KioskResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface KioskController {
  enabled: boolean;
  call(cmd: string, params?: Record<string, string>): Promise<KioskResult>;
  screenOn(): Promise<KioskResult>;
  screenOff(): Promise<KioskResult>;
  toForeground(): Promise<KioskResult>;
  loadStartURL(): Promise<KioskResult>;
  restartApp(): Promise<KioskResult>;
  setBooleanSetting(key: string, value: boolean): Promise<KioskResult>;
  setStringSetting(key: string, value: string): Promise<KioskResult>;
  deviceInfo(): Promise<KioskResult>;
}

export function createKioskController(
  kiosk: Config['kiosk'],
  password: string | undefined,
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void },
): KioskController {
  const enabled = Boolean(kiosk.host) && !kiosk.host.includes('<') && Boolean(password);
  if (!enabled) log.warn({ kiosk: 'disabled' }, 'kiosk: set kiosk.host in config.yaml and FULLY_KIOSK_PASSWORD in .env');

  async function call(cmd: string, params: Record<string, string> = {}): Promise<KioskResult> {
    if (!enabled) return { ok: false, error: 'kiosk not configured' };
    const url = new URL(`http://${kiosk.host}:${kiosk.port}/`);
    url.search = new URLSearchParams({ cmd, ...params, type: 'json', password: password ?? '' }).toString();
    const started = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text();
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        // Some commands answer with HTML; keep the text.
      }
      const status = (data as { status?: string } | null)?.status;
      const ok = res.ok && status !== 'Error';
      // Never log the URL: it carries the password.
      if (!ok) log.warn({ kiosk: cmd, http: res.status, statusText: (data as { statusText?: string })?.statusText }, 'kiosk call failed');
      else log.info({ kiosk: cmd, ms: Date.now() - started }, 'kiosk call');
      return ok ? { ok, data } : { ok, data, error: `HTTP ${res.status} ${status ?? ''}`.trim() };
    } catch (err) {
      const error = err instanceof Error ? err.name === 'TimeoutError' ? 'timeout after 3 s' : err.message : String(err);
      log.warn({ kiosk: cmd, error }, 'kiosk call failed');
      return { ok: false, error };
    }
  }

  return {
    enabled,
    call,
    screenOn: () => call('screenOn'),
    screenOff: () => call('screenOff'),
    toForeground: () => call('toForeground'),
    loadStartURL: () => call('loadStartURL'),
    restartApp: () => call('restartApp'),
    setBooleanSetting: (key, value) => call('setBooleanSetting', { key, value: String(value) }),
    setStringSetting: (key, value) => call('setStringSetting', { key, value }),
    deviceInfo: () => call('deviceInfo'),
  };
}

const QUIET_CHECK_MS = 30_000;

// Quiet hours (spec section 8): Fully's motion detection goes off at the start and back on at the
// end, so someone walking past at night does not light up the room. A ring and a touch still wake it.
// During a soak, log whatever RAM figures Fully Kiosk reports, every 5 minutes (spec section 11).
export function kioskProvider({ config, kiosk, log }: ProviderDeps): Provider {
  let timer: NodeJS.Timeout | undefined;
  let quietTimer: NodeJS.Timeout | undefined;
  let motionOn: boolean | null = null; // what Fully was last told; null until a call succeeds

  // Sets motion detection to match the clock. A failed call is retried on the next check.
  async function applyQuietHours(): Promise<void> {
    const want = !inQuietHours(config.idle.quietHours, config.timezone);
    if (want === motionOn) return;
    const res = await kiosk.setBooleanSetting(MOTION_DETECTION_KEY, want);
    if (!res.ok) return;
    motionOn = want;
    log.info({ kiosk: 'quiet hours', motionDetection: want }, want ? 'kiosk: quiet hours over, motion detection on' : 'kiosk: quiet hours, motion detection off');
  }

  async function logRam(): Promise<void> {
    const res = await kiosk.deviceInfo();
    if (!res.ok || typeof res.data !== 'object' || res.data === null) return;
    const ram = Object.fromEntries(
      Object.entries(res.data).filter(([k, v]) => /ram|mem/i.test(k) && typeof v === 'number'),
    );
    log.info({ deviceRam: ram }, 'kiosk device ram');
  }

  return {
    id: 'kiosk',
    topics: [],
    routes() {},
    start() {
      if (!kiosk.enabled) return;
      void applyQuietHours(); // at start-up too: the server may have been down at a boundary
      quietTimer = setInterval(() => void applyQuietHours(), QUIET_CHECK_MS);
      if (!config.debug.soak) return;
      void logRam();
      timer = setInterval(() => void logRam(), 5 * 60_000);
    },
    stop() {
      clearInterval(timer);
      clearInterval(quietTimer);
    },
  };
}
