# Milestone 0 report: Shell and soak

Oct 8, 2026

Status: code complete and tested headless in this environment. **Not yet run on the tablet.** Every spike and the 24 hour soak gate still need the real Tab A11+. Their sections below give the procedure and blank result tables, not numbers.

## 1. What shipped

Everything is under `wall/` (see judgment call J1).

| Item | Where | Notes |
| --- | --- | --- |
| Workspace | `wall/package.json` | npm workspaces `server` and `client`. Node 22, TypeScript. |
| Config | `wall/config.yaml`, `wall/.env.example` | The section 10 sketch, with placeholders, plus `debug.soak`. Secrets are only in `.env`, which is git-ignored. |
| Server | `wall/server/src/index.ts` | Fastify on port 9600. Has `GET /healthz`, `GET /api/state`, `GET /api/events` (SSE), `POST /api/state` and `POST /api/telemetry`. It also serves the built client: hashed bundles are cached for a year (`immutable`) and `index.html` is `no-cache`. |
| SSE hub | `server/src/hub.ts` | Named events (`event: <topic>`). Sends a keep-alive comment every 25 s. `state` is published when the tablet state changes. |
| Providers | `server/src/providers/` | The `Provider` interface (`routes`, `topics`, `start()`, `stop()`), with one line per provider in `index.ts`. Only `kiosk` exists. |
| Kiosk controller | `server/src/providers/kiosk.ts` | `screenOn`, `screenOff`, `toForeground`, `loadStartURL`, `restartApp`, `setBooleanSetting`, `setStringSetting`, `deviceInfo`, and a generic `call()`. Every call has a 3 s timeout (measured: a call that never answers returns at 3004 ms). Failures are logged and returned, never thrown. The URL is never logged because it carries the password. |
| Kiosk CLI | `server/src/kiosk-cli.ts` | Runs any Fully command through the same controller, for the spikes. |
| Soak RAM log | `kiosk` provider | When `debug.soak` is on, the server calls `deviceInfo` every 5 minutes and logs only the numeric fields whose names contain `ram` or `mem`. |
| Screen contract | `client/src/screens/types.ts` | Section 4, verbatim. `ClientConfig` is defined in `client/src/shell/config.ts` (J6). |
| Registry | `client/src/screens/registry.ts` | One line per screen. |
| ScreenContext | `client/src/shell/context.ts` | `signal`, `subscribe`, `every`, `fetch` (bound to the signal), `config`, `go`, `touch`. `dispose()` aborts first, so the screen's abort handlers run, then releases every subscription and timer. Calls made after unmount are ignored. |
| Screen host | `client/src/shell/host.ts` | Keeps one screen mounted per layer. After unmount it checks the root is empty and that the screen's subscription and timer counts are 0. A failure counts as a leak and logs a warning in dev builds. |
| Rail | `client/src/shell/rail.tsx` | Styled from the mockups: 88 px wide, 64 × 76 targets, accent tint on the active item. Order follows `screens:` in `config.yaml`. |
| Idle clock | `client/src/shell/idle.ts`, `shell/index.tsx` | Active → Idle → Off using the config timings. Off unmounts the screen, then `POST /api/state off`, and the server calls `screenOff`. One passive capture listener resets the clock. The first touch after Idle or Off is swallowed, and all touches are ignored for 400 ms after a wake. |
| Wake signals | `shell/index.tsx`, `shell/fully.ts` | `visibilitychange`, plus Fully's JS interface `screenOn`, `screenOff` and `onMotion`. All are timestamped and sent with the next heartbeat. The wake itself is reported as `POST /api/state {state:'active', via}`. |
| Event-stream client | `client/src/shell/events.ts` | One `EventSource`. Reconnect backoff is 1, 2, 5, 10, 30 s with ±20% jitter. Every (re)connect refetches `/api/state` and passes it to `state` subscribers. |
| Overlay layer | `.overlay-layer` + a second `ScreenHost` | Uses the same mount contract above the stage. No overlay exists yet (doorbell is milestone 3). |
| Theme | `client/src/theme.css` | The section 9 variables verbatim, plus type, layout and mockup tokens (J9). Contains the page hardening. The root font size is set from viewport height. |
| Fonts | `client/src/fonts/` | Bricolage Grotesque (wght + opsz) and Figtree (wght) variable woff2, latin and latin-ext subsets, 160 KB in total, under SIL OFL 1.1. Nothing loads from Google Fonts. |
| Template | `client/src/screens/example-clock/` | Uses every context resource: `every`, `subscribe('state')`, `fetch`, and `signal` for `render(null, root)`. Built as its own bundle. |
| Lint rule | `wall/eslint.config.js` | Applies to `client/src/screens/**`. Bans `setInterval`, `fetch`, `EventSource` and `addEventListener` used bare or through `window`, `globalThis` or `self`, and bans `document.addEventListener`. Checked against a throwaway file: all 9 banned patterns were flagged. The Docker build runs lint before building. |
| Soak harness | `client/src/shell/soak.ts` | When `debug.soak` is on, it mounts and unmounts every registered screen every 60 s, with 2 s between screens. It starts 30 s after boot. A `SOAK` badge shows in the corner. |
| Heartbeat | `client/src/shell/telemetry.ts` | Sent at boot, then every 60 s. Fields: `screen`, `state`, `uptimeSec`, `heapMB`, `heapLimitMB`, `domNodes`, `subs`, `timers`, `leaks`, `viewport`, `soakCycles`, `signals`. |
| Docker | `wall/Dockerfile`, `wall/docker-compose.yml` | Multi-stage build on `node:22-bookworm-slim` that runs as user `node`. Settings: `restart: unless-stopped`, a `/healthz` healthcheck, `mem_limit: 512m`, json-file logs rotated at 10 × 10 MB, the port published on `WALL_BIND_ADDR` only, and `config.yaml` mounted read-only. |

### Verified here, headless Chromium at 1280 × 800 (not the tablet)

- Idle test with 3 s timings: the page went Active → Idle → Off, the screen unmounted, and the server called `screenOff` on a fake Fully endpoint. Fully `screenOn` woke it and remounted home. A tap on a rail button while Off woke the page, and the button saw 0 clicks.
- Soak test: two cycles, `leaks: 0`. Subscription and timer counts were steady, at 1 subscription and 4 timers with the clock mounted. Heap was 2.1–2.3 MB and the DOM had 25 nodes. A 2 minute run says nothing about heap trend; that is what the tablet soak is for.
- Docker: the image builds, including lint, and the container comes up healthy at about 28 MB. Note that in this sandbox the build needed the sandbox's HTTPS proxy injected through a throwaway Dockerfile. On the media server a plain `docker compose up -d --build` should need nothing extra.

## 2. Deviations and judgment calls to ratify

None of these changes a section 4, 7 or 10 contract silently. The items marked **contract** add to a section 10 surface and need your yes.

| # | Call | Why | Alternative |
| --- | --- | --- | --- |
| J1 | The section 10 tree lives in a `wall/` subfolder. `docs/` and `CLAUDE.md` stay at the repo root, and paths in the spec and `CLAUDE.md` such as `client/src/theme.css` are relative to `wall/`. | It reads section 10 literally, as you asked. | Move `wall/*` to the repo root. That is a one-commit move. |
| J2 | go2rtc is not in `docker-compose.yml` yet. | Nothing uses it until milestone 2, and its config is generated from `config.yaml` then. | Add an idle go2rtc service now. |
| J3 | There are no stub files for the calendar, cameras, doorbell and photos providers, only `kiosk`. | Empty files add nothing. Each provider is one file and one line when its milestone arrives. | Add empty stubs. |
| J4 | **contract** `POST /api/state` accepts an optional `via` field (what woke the page). | The wake spike needs it, and it is useful later. | Drop the field after the spike. |
| J5 | **contract** The heartbeat carries more than the section 11 list: `heapLimitMB`, `leaks`, `viewport`, `soakCycles`, `signals`. | `viewport` and `signals` answer the spikes. `leaks` makes the section 4 leak check visible in production builds during the soak. | Keep only the section 11 fields after milestone 0. |
| J6 | `ClientConfig` (which the spec names but doesn't define) is `{timezone, weekStart, clock, screens, idle, calendars:[{id,color}], soak}`. The same type is written out in both server and client. | There is no shared package in the section 10 layout. | Add a shared types file. |
| J7 | **contract** `config.yaml` gains `debug: { soak: false }`. | One switch turns on the client loop and the server's RAM logging, without editing the Fully start URL. | Use a `?soak=1` URL parameter on the client plus a server env var. |
| J8 | `config.yaml` calendar colours are the theme and mockup colours (`#7DB3FF`, …), not the older sketch values (`#4f8cff`, …). | Section 9 says the mockups win. | |
| J9 | Theme additions: `--rail-line: #212831` (the mockup rail border, which isn't `--line`), `--accent-soft` (active rail tint), `--radius-rail-item`, the type sizes `--fs-*` and the layout constants `--rail-w`, `--gutter`, `--hour`, `--pad`, `--gap`, all in rem. The spec's radius variables stay in px, verbatim. | `CLAUDE.md` says all type and spacing live in `theme.css`. | |
| J10 | `html { font-size: calc(100vh / 50) }`, so 1 rem = 16 px at 800 px tall, and the px values from the mockups divide by 16. | Implements "root size from viewport height". Recheck once the real viewport is known (S1). | |
| J11 | The idle clock already steps Active → Idle → Off with the config timings. Idle shows no photos yet and leaves the screen as it is. Quiet hours aren't implemented. Off hides everything and shows black. | The screenOff and wake spikes need a real Off. Photos and quiet hours are milestone 4. | |
| J12 | "Home" is the first registered id in `screens:`. Wake from Off and boot land there. | Calendar doesn't exist yet. Once `screens: [calendar, cameras]` is set, home is calendar, which matches section 8. | Hard-code `calendar` as home. |
| J13 | Wake acts on the first of `visibilitychange`, Fully `screenOn` or Fully `onMotion`. Each is recorded on its own, so the spike can still tell which fired. | Waking twice does nothing extra, so this is safe. The spec makes the JS events a fallback only if visibility proves unreliable. | After S3, keep only the reliable signal. |
| J14 | Soak mode pauses the idle clock, so the loop runs all night with the screen on. It starts 30 s after boot so the heartbeat never samples mid-switch. | Otherwise the tablet goes Off after 23 minutes, the screen unmounts and the soak stops testing anything. | Run the soak with idle on, which tests sleep and wake instead. That is a separate run. |
| J15 | The leak check runs in every build and is counted in the heartbeat's `leaks`. The console warning appears only in dev builds, as specified. | The soak runs the production build. | |
| J16 | `ctx.go()` closes any open overlay before switching. | Section 7's "Open cameras" closes the popup and goes. This makes it the general rule. | Leave closing to the overlay. |
| J17 | **Gap in the section 4 contract, not changed:** `setTimeout` isn't banned, and the context has no one-shot timer. A screen's `setTimeout` can fire after unmount. | The spec lists only `setInterval`. | Add `ctx.after(ms, fn)` and ban `setTimeout` in screens. This changes section 4, so it needs your call. |
| J18 | The reconnect backoff (a section 11 safeguard, otherwise milestone 5) is already in place. | It belongs to the event-stream client, which is milestone 0, and it was cheap. | |
| J19 | The cameras code preload 30 s after page load isn't implemented. | There's no cameras screen yet. Milestone 2. | |
| J20 | The LAN bind address is `WALL_BIND_ADDR` in `.env`, and compose refuses to start without it. Port 9600 appears in both `config.yaml` and `docker-compose.yml`. | Compose can't read `config.yaml`. Binding to `0.0.0.0` would break the LAN-only rule. | |
| J21 | Request logging is off. Errors are logged by route pattern, method and message, never the URL or body. | This keeps heartbeat noise and query strings out of the logs. | |
| J22 | The clock uses `en-US` formatting ("3:42 PM", as in the mockups). `en-CA` renders "3:42 p.m.". | It matches the mockups. | |
| J23 | Fonts are committed woff2 files copied from Fontsource 5.3.0, latin and latin-ext only. | No runtime dependency. Text outside those ranges falls back to the system sans-serif. | |

## 3. Spikes (on the tablet, not yet run)

I could not reach the tablet or Fully Kiosk's official documentation from here: `fully-kiosk.com` is blocked by this environment's network policy. Every result below needs you or a session on your network.

Before any spike, set Fully Kiosk up on the tablet:

- Start URL `http://<server>:9600/`.
- Remote Admin on, with a password; put that password in `.env`.
- **Enable JavaScript Interface** on.
- Motion detection on, with "turn screen on when motion is seen".
- Fully's own screensaver and screen-off timer off.
- Keep Screen On on.
- Kiosk mode with a PIN.
- Fully excluded from battery optimization, and landscape locked.

All commands below run on the media server from `wall/`:

```sh
K="docker compose exec wall-server node dist/kiosk-cli.js"
LOGS="docker compose logs --no-log-prefix wall-server"
```

### S1. Real CSS viewport

Load the page. The first heartbeat carries `viewport`.

```sh
$LOGS | grep '"heartbeat"' | tail -1 | jq .telemetry.viewport
```

| innerWidth | innerHeight | devicePixelRatio | screen.width × height | Expected |
| --- | --- | --- | --- | --- |
| 1280 | 799 | 2 | not recorded | about 1280 × 800 |

**Result (Oct 11):** measured on the real tablet, which is a **Google Pixel Tablet** (2560 × 1600), not the Tab A11+. The viewport matches the mockups' 1280 × 800 to within one pixel, so the rem base and the spacing stand as designed. No redesign is needed.

If the height isn't about 800, the rem base (J10) still scales, but the mockups' px sizes would need rechecking.

### S2. Does screenOff stay off, and does motion wake it?

1. `$K screenOff`, then leave the room for 10 minutes. Note whether the screen comes back on by itself.
2. Walk in front of the tablet. Note whether the screen comes on, and the delay from entering the room.
3. Repeat through the client path: set `idle.toIdleSec: 30` and `toOffMin: 1` in `config.yaml`, then `docker compose restart wall-server` and `$K loadStartURL`.

| Test | Stays off? (minutes watched) | Motion wakes? | Motion to screen-on (s) |
| --- | --- | --- | --- |
| `screenOff` from the CLI | | | |
| Client Off → server `screenOff` | | | |

### S3. Does the page see the wake?

After each wake in S2:

```sh
$LOGS | grep -E '"tablet state"|"heartbeat"' | tail -5
```

`via` shows what woke the page. The next heartbeat's `signals` lists every `visible`/`hidden` and `fully:screenOn`/`fully:screenOff`/`fully:onMotion` event with its time. `fully:unavailable` means the JS interface is off.

| Wake (10 tries each) | `visible` seen | `fully:screenOn` seen | `fully:onMotion` seen | First signal after screen-on (ms) |
| --- | --- | --- | --- | --- |
| Motion | /10 | /10 | /10 | |
| Touch | /10 | /10 | n/a | |
| `$K screenOn` | /10 | /10 | n/a | |

Decision for J13: keep whichever signal fires 10 out of 10.

### S4. Does the motion-detection settings command work?

```sh
$K setBooleanSetting key=motionDetection value=false   # walk past: the screen must stay off
$K setBooleanSetting key=motionDetection value=true    # walk past: the screen must wake
```

Check that the toggle shows in Fully's settings, and that it survives an app restart (`$K restartApp`).

| Command | Fully replied | Took effect | Survives restartApp |
| --- | --- | --- | --- |
| motionDetection false | | | |
| motionDetection true | | | |

### S5. Fully Kiosk command names and setting keys

Installed Fully version: ______ (Fully menu → About)

The official REST and JS documentation was unreachable from here. Status is from third-party integrations: Home Assistant, Hubitat and SmartThings drivers, and ioBroker forum posts. **Please confirm each on the tablet.** `$K <cmd>` prints Fully's reply. An unknown command returns an error status.

| Spec name | Used for | Status from secondary sources | Confirmed on tablet |
| --- | --- | --- | --- |
| URL form `http://<ip>:2323/?cmd=X&password=P&type=json` | every call | consistent across sources | |
| `screenOn` | ring wake (milestone 3) | widely used | |
| `screenOff` | client Off | widely used | |
| `toForeground` | ring wake | from memory, not confirmed | |
| `loadStartURL` | nightly reload, watchdog | from memory, not confirmed | |
| `restartApp` | Sunday restart, watchdog | from memory, not confirmed | |
| `setBooleanSetting` (`key`, `value`) | quiet hours | used by Hubitat and SmartThings drivers (e.g. `keepScreenOn`) | |
| `setStringSetting` | spare | used by the same drivers | |
| `deviceInfo` (spec says "device info") | soak RAM log | widely used | |
| Setting key `motionDetection` | quiet hours | **unconfirmed**; no source named the key | |
| JS `fully.bind(event, code)` | wake fallback | confirmed by several posts | |
| JS event `onMotion` | wake fallback | confirmed by several posts | |
| JS events `screenOn`, `screenOff` | wake fallback | unconfirmed | |

To find the real motion key: Fully can export its settings as JSON, and the keys in that file are the names `setBooleanSetting` expects. Search the file for "motion". If the key differs, change `MOTION_DETECTION_KEY` in `server/src/providers/kiosk.ts`; nothing else uses it yet. One forum user also reported that toggling motion settings over REST was not always reliable. S4's "survives restartApp" column is there to catch that.

## 4. Budget (section 11)

| Measure | Target | Measured |
| --- | --- | --- |
| JS heap growth over the soak, after the nightly reload | 10% or less above the first-hour value | **Pending: 24 h tablet soak.** (Headless desktop Chromium, 2 min: 1.2 → 2.3 MB; not meaningful.) |
| Screens mounted at once | 1 + 1 overlay | 1, enforced by `ScreenHost`. |
| wall-server container memory | 512 MB limit | about 28 MB idle (headless test). |

## 5. Deploy

On the media server:

```sh
git clone https://github.com/whatadewitt/d-wall && cd d-wall/wall
cp .env.example .env    # set WALL_BIND_ADDR (server LAN IP) and FULLY_KIOSK_PASSWORD
nano config.yaml        # set kiosk.host to the tablet's IP; leave the other placeholders for now
docker compose up -d --build
curl http://<WALL_BIND_ADDR>:9600/healthz     # {"ok":true}
$K deviceInfo           # proves server → Fully works
```

Then point Fully's start URL at `http://<WALL_BIND_ADDR>:9600/`, with the Fully settings listed under section 3. Run spikes S1–S5.

## 6. Start the soak (the 24 h gate)

1. Put `idle` back to `{ toIdleSec: 180, toOffMin: 20 }` if you changed it for S2, and set `debug: { soak: true }` in `config.yaml`.
2. `docker compose restart wall-server && $K loadStartURL`. A `SOAK` badge appears bottom right.
3. Leave the tablet alone for 24 hours. The screen stays on, because soak mode pauses the idle clock. Fully's own screen timeout must be off.
4. Read the result:

```sh
# time, heap MB, DOM nodes, subscriptions, timers, leaks, soak cycles
$LOGS | grep '"heartbeat"' | jq -r '[(.time/1000|todate), .telemetry.heapMB, .telemetry.domNodes, .telemetry.subs, .telemetry.timers, .telemetry.leaks, .telemetry.soakCycles] | @tsv'
# Fully's own RAM figures, every 5 minutes
$LOGS | grep '"kiosk device ram"' | jq -c '[(.time/1000|todate), .deviceRam]'
```

The gate passes if the last hour's heap is within 10% of the first hour's, `leaks` stays 0, `domNodes`, `subs` and `timers` are flat, and `soakCycles` reaches about 1,440. The logs keep about 100 MB, far more than 24 h of heartbeats. Don't run `docker compose down` before reading them, because that deletes the container's logs; `restart` keeps them.

5. Afterwards, set `debug.soak` back to `false` and restart.
