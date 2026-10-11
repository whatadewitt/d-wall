import type { Config } from '../config.js';
import { serverState } from '../state.js';
import { dayOfWeek, hhmm, inQuietHours, localTime } from '../time.js';
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

const TICK_MS = 30_000;

// Nightly reload (spec section 11): loadStartURL at 03:30, restartApp at 03:45 on Sundays instead.
// It waits up to an hour while the tablet is in use, then runs anyway; never during a doorbell popup.
const RELOAD_AT = '03:30';
const SUNDAY_RESTART_AT = '03:45';
const RELOAD_WAIT_MIN = 60;
const RELOAD_TRIES = 3; // failed calls before giving up until tomorrow

// Heartbeat watchdog (spec section 11): no sign of life for 5 minutes while the screen should be on
// means loadStartURL, then restartApp 2 and 4 minutes later. After those 3 attempts it stops and logs.
const SILENT_MS = 5 * 60_000;
const STEP_MS = 2 * 60_000;
const WATCHDOG_TRIES = 3;

// Quiet hours (spec section 8): Fully's motion detection goes off at the start and back on at the
// end, so someone walking past at night does not light up the room. A ring and a touch still wake it.
// Also the nightly reload and the heartbeat watchdog (section 11), which use the same 30 s tick.
// During a soak, log whatever RAM figures Fully Kiosk reports, every 5 minutes (section 11).
export function kioskProvider({ config, kiosk, log, bus, publishState }: ProviderDeps): Provider {
  let timer: NodeJS.Timeout | undefined;
  let tickTimer: NodeJS.Timeout | undefined;
  let motionOn: boolean | null = null; // what Fully was last told; null until a call succeeds
  const tz = config.timezone;

  const doorbellActive = () => {
    const until = serverState.doorbell.activeUntil;
    return until !== null && Date.parse(until) > Date.now();
  };

  // Sets motion detection to match the clock. A failed call is retried on the next check.
  async function applyQuietHours(): Promise<void> {
    const want = !inQuietHours(config.idle.quietHours, tz);
    if (want === motionOn) return;
    const res = await kiosk.setBooleanSetting(MOTION_DETECTION_KEY, want);
    if (!res.ok) return;
    motionOn = want;
    log.info({ kiosk: 'quiet hours', motionDetection: want }, want ? 'kiosk: quiet hours over, motion detection on' : 'kiosk: quiet hours, motion detection off');
  }

  // In use means Active: touched within idle.toIdleSec. The soak pauses the idle clock, so there
  // Active means nothing and the reload does not wait.
  const nightly = { day: '', tries: 0, waitLogged: '' };
  async function nightlyReload(): Promise<void> {
    const { ymd, minutes } = localTime(tz);
    if (nightly.day === ymd) return; // done, or given up, today
    const sunday = dayOfWeek(ymd) === 0;
    const late = minutes - hhmm(sunday ? SUNDAY_RESTART_AT : RELOAD_AT);
    if (late < 0 || late > RELOAD_WAIT_MIN + 5) return; // outside the window: a missed night is skipped
    if (doorbellActive()) return;
    const inUse = serverState.tablet.state === 'active' && !config.debug.soak;
    if (inUse && late < RELOAD_WAIT_MIN) {
      if (nightly.waitLogged !== ymd) log.info({ kiosk: 'nightly', waiting: true }, 'kiosk: tablet in use, nightly reload waits');
      nightly.waitLogged = ymd;
      return;
    }
    const cmd = sunday ? 'restartApp' : 'loadStartURL';
    const res = sunday ? await kiosk.restartApp() : await kiosk.loadStartURL();
    nightly.tries++;
    if (res.ok) log.info({ kiosk: 'nightly', cmd, waitedMin: Math.max(0, late), forced: inUse }, 'kiosk: nightly reload');
    else if (nightly.tries >= RELOAD_TRIES) log.error({ kiosk: 'nightly', cmd, tries: nightly.tries }, 'kiosk: nightly reload failed, giving up until tomorrow');
    if (res.ok || nightly.tries >= RELOAD_TRIES) Object.assign(nightly, { day: ymd, tries: 0 });
  }

  // Any heartbeat or state report from the page is a sign of life.
  let lastSign = Date.now();
  let tries = 0;
  let gaveUp = false;
  const alive = () => {
    if (tries) log.info({ watchdog: 'recovered', tries }, 'watchdog: tablet is back');
    lastSign = Date.now();
    tries = 0;
    gaveUp = false;
  };

  // The screen should be on while Active or Idle, and during a doorbell popup. With no state yet
  // (the server restarted) a live page re-reports within a minute, so expect one outside quiet hours.
  function shouldBeOn(): boolean {
    if (doorbellActive()) return true;
    const s = serverState.tablet.state;
    if (s === null) return !gaveUp && !inQuietHours(config.idle.quietHours, tz);
    return s === 'active' || s === 'idle';
  }

  // Escalates on silence: loadStartURL at 5 minutes, restartApp at 7 and 9, give up at 11.
  async function heartbeatWatchdog(): Promise<void> {
    const now = Date.now();
    if (!shouldBeOn()) {
      lastSign = now; // silence while the screen is meant to be off does not count
      return;
    }
    const silent = now - lastSign;
    if (tries < WATCHDOG_TRIES && silent >= SILENT_MS + tries * STEP_MS) {
      const cmd = tries === 0 ? 'loadStartURL' : 'restartApp';
      tries++;
      log.warn({ watchdog: cmd, attempt: tries, silentSec: Math.round(silent / 1000), state: serverState.tablet.state }, 'watchdog: no heartbeat from the tablet');
      void (cmd === 'loadStartURL' ? kiosk.loadStartURL() : kiosk.restartApp());
    } else if (tries === WATCHDOG_TRIES && !gaveUp && silent >= SILENT_MS + tries * STEP_MS) {
      gaveUp = true;
      log.error({ watchdog: 'gave up', attempts: tries, silentSec: Math.round(silent / 1000) }, 'watchdog: tablet still silent, giving up until it reports again');
      // The tablet is gone as far as the server knows: warm stills stop (section 6).
      serverState.tablet = { state: null, since: new Date().toISOString() };
      publishState();
    }
  }

  async function logRam(): Promise<void> {
    const res = await kiosk.deviceInfo();
    if (!res.ok || typeof res.data !== 'object' || res.data === null) return;
    const ram = Object.fromEntries(
      Object.entries(res.data).filter(([k, v]) => /ram|mem/i.test(k) && typeof v === 'number'),
    );
    log.info({ deviceRam: ram }, 'kiosk device ram');
  }

  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await applyQuietHours();
      await nightlyReload();
      await heartbeatWatchdog();
    } finally {
      ticking = false;
    }
  };

  return {
    id: 'kiosk',
    topics: [],
    routes() {},
    start() {
      if (!kiosk.enabled) return;
      bus.on('heartbeat', alive);
      bus.on('tablet-state', alive);
      void tick(); // at start-up too: the server may have been down at a boundary
      tickTimer = setInterval(() => void tick(), TICK_MS);
      if (!config.debug.soak) return;
      void logRam();
      timer = setInterval(() => void logRam(), 5 * 60_000);
    },
    stop() {
      clearInterval(timer);
      clearInterval(tickTimer);
    },
  };
}
