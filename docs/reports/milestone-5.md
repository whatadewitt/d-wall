# Milestone 5 report: Hardening

Oct 11, 2026

Status: code complete. Tested against the real server in headless Chromium at 1280 × 800, with a fake Fully Kiosk that records every command, time zones chosen so that 03:30 and 03:45 fell inside the test, and a TCP proxy that can freeze a connection without closing it. **Not run on the tablet.** The gate needs the tablet: a 72 hour soak, and the watchdogs checked by killing the server and the app (section 6 below has the steps).

## 1. What shipped

| Item | Where | Notes |
| --- | --- | --- |
| Nightly reload | `server/src/providers/kiosk.ts` | `loadStartURL` at 03:30 local time, and on Sundays `restartApp` at 03:45 instead. If the tablet is in use (Active), it waits, for up to an hour. After that it runs anyway, but never during a doorbell popup. Runs once a day. If a call fails it tries again on the next 30 s tick, and after 3 failures it gives up until tomorrow and logs an error. If the server is down for the whole window, that night is skipped. Logged as `kiosk: nightly reload`, with `waitedMin` and `forced`. |
| Heartbeat watchdog | same | Any heartbeat or state report counts as a sign of life. If there is none for 5 minutes while the screen should be on, it calls `loadStartURL`. Still silent 2 minutes later: `restartApp`. Still silent 2 minutes after that: `restartApp` again. Then it stops, logs `watchdog: ... giving up`, and marks the tablet state unknown, so the warm stills stop (this closes L15 from milestone 2). The next heartbeat resets everything and logs `watchdog: tablet is back`. "Should be on" means Active, Idle, or a doorbell popup is open. While the screen is meant to be off, the silence clock is paused. |
| Heap watchdog | `client/src/shell/watchdog.ts` | Uses the heartbeat's heap reading. The budget is 60 MB, or 120 MB while the cameras screen is mounted (W5). Three heartbeats in a row above 1.5 times the budget arm the watchdog. The page then reloads at the next quiet moment: no doorbell popup, nothing touched for 10 s, and the event stream live, so a reload can't land on an error page while the server is down. Just before reloading it reports `{watchdog: {reason, heapMB, budgetMB}}`, logged as `client watchdog reload`. If the WebView has no `performance.memory`, the heap watchdog does nothing. |
| Silent stream detection | `client/src/shell/events.ts`, `server/src/hub.ts` | The server's 25 s keep-alive is now a `ping` event instead of a comment line, because the browser never sees comment lines. The client reopens the stream after 60 s with nothing heard, including a connect that never completes. On a wake (page visible, Fully `screenOn` or `onMotion`) it reopens straight away if nothing was heard for 35 s, skipping any backoff wait, so a ring right after a long sleep isn't missed. |
| State resync | `client/src/shell/index.tsx` | On every reconnect after the first, if the server's tablet state differs from the page's, the page reports its state again (`via: resync`). A restarted server therefore knows the tablet state within a reconnect, not at the next touch. |
| Boot while hidden | `client/src/shell/idle.ts`, `shell/index.tsx` | A page that loads while hidden starts Off with nothing mounted and reports `off` (`via: boot-hidden`). This is the nightly reload with the screen off, or a watchdog reload. Otherwise it would claim Active with the screen dark, and the heartbeat watchdog would expect heartbeats it may never get. The next wake lands on the calendar. This is never used in soak mode. |
| Never blank on a switch | `client/src/shell/host.ts` | A screen's code now loads before the current screen unmounts. If the server is down and the code isn't cached, the current screen stays instead of the stage going blank. The photos code is now also preloaded 30 s after boot with the rail screens, so Idle can start during an outage. |
| Log hygiene | `server/src/index.ts` | Audited every log call (section 3). Added pino `redact` as a backstop for fields named `password`, `secret`, `token`, `authorization`, `headers` and `url`. Uncaught exceptions and unhandled rejections are now logged as one JSON line, then the process exits for Docker to restart it, as Node does by default. Rotation is unchanged: wall-server 10 × 10 MB, go2rtc 5 × 10 MB. |

Already in place from earlier milestones: reconnect backoff of 1, 2, 5, 10 and 30 s with jitter, with a `/api/state` refetch on each reconnect (milestone 0, J18), the calendar's stale note (milestone 1), the camera tiles' stale marks and the live-view fallback (milestone 2), and `restart: unless-stopped`, the healthcheck and the 512 MB limit (milestone 0).

## 2. Verified here

| Check | Result |
| --- | --- |
| Nightly reload, Monday (zone `Etc/GMT-14`, 03:38) | Server started inside the window with no page: `loadStartURL` on the first tick. Called once only, with no repeat over the next 70 s. |
| Sunday restart while in use (zone `Etc/GMT+10`, page touched every 20 s from 03:42) | At 03:45 it logged `tablet in use, nightly reload waits`. No call during 2 more minutes of touches. Touches stopped, the tablet went Off after 60 s (quiet hours), and `restartApp` followed in the same tick (`waitedMin: 3`, `forced: false`). |
| Forced run after an hour of use | **Not run** (it needs an hour). The code path is the same as above with `forced: true`. |
| Heartbeat watchdog, server restarted, no page | `loadStartURL` at 300 s (`state: null`). Page opened ("the reload worked"): `watchdog: tablet is back`. |
| Heartbeat watchdog, page killed while Active | `loadStartURL`, then `restartApp` 2:00 later and again 2:00 after that. Then `giving up`, 11 min 29 s after the last heartbeat (each step lands on the next 30 s tick), with state set to `null`. No calls in the next 90 s. Page back: state `active`, `watchdog: tablet is back`. |
| Boot while hidden (visibility forced to hidden on the reload) | `off` / `boot-hidden` sent. Nothing mounted, body `data-state=off`. Making it visible woke it to the calendar. |
| Server killed before the code preload, then tap Cameras | Calendar stayed mounted (previously the stage went blank). |
| Server restarted | Stream back within backoff. Server log: `active/boot`, then `active/resync` after the restart. |
| Stream frozen at the proxy (sockets open, no data) | New `EventSource` after 60 s. Stream live again. |
| Heap watchdog (heap faked at 200 MB) | Armed after 3 heartbeats. No reload during 3 minutes of touches every 5 s. Reloaded about 11 s after the last touch. Server logged `client watchdog reload {heapMB: 200, budgetMB: 60}`. |
| Secrets in logs | Four servers ran with known fake values for the Fully password, webhook secret, Protect user and password, and a Google calendar id. The webhook was called with good and bad secrets, telemetry with a `password` field, and a broken JSON body. `grep` found **0** occurrences in any log. Google, Protect and go2rtc weren't reachable here, so their log paths were checked by reading the code (section 3). |
| Short soak (headless, 3 cycles) | `leaks: 0`. Subscriptions 3 and timers 5 with the clock mounted, steady (timers were 4: the stream check adds one shell timer). Heap 1.2–2.0 MB. |
| Lint, typecheck, build | Clean. The lint rule for screens is unchanged and still on. |

## 3. Log audit

Every `log.*` call in `server/src` was read. It logs ids from `config.yaml` (calendar, camera), counts, timings, HTTP statuses, and error codes or messages. None of them logs event titles or descriptions, photo names (photos are logged by hash id), URLs with credentials (the kiosk URL is never logged, and go2rtc errors have addresses cut out), Google calendar ids, or request bodies (request logging is off, and the webhook logs only trigger keys). The one open item:

- **go2rtc's own log** (a separate container) may print camera RTSPS addresses, which carry Protect stream tokens, when a stream fails. I couldn't run go2rtc against real cameras here. Check it on the server: `docker compose logs go2rtc | grep -c rtsps`. If the count isn't 0, the fix is `"log":{"level":"error"}` in its inline config, or `"streams":"error"` for just that module. I'd rather check than guess.

## 4. Budget (section 11)

| Measure | Target | Here | Tablet |
| --- | --- | --- | --- |
| Heap growth over a 72 h soak, after the nightly reload | 10% or less above the first-hour value | not measurable headless | **pending: gate** |
| Leaks across soak cycles | 0 | 0 (3 cycles) | pending |
| Screens mounted at once | 1 + 1 overlay | 1 + 1 | — |

## 5. Deviations and judgment calls to ratify

**contract** marks a change or addition to a section 4, 7 or 10 surface.

| # | Call | Why |
| --- | --- | --- |
| W1 | **contract, needs your yes:** the event stream gains a fourth topic, `ping` (`{}` every 25 s). It replaces the comment-line keep-alive. Screens could subscribe to it, but nothing does. | Without it a stream that dies without an error (Wi-Fi drop, half-open TCP) looks the same as a quiet one, and a ring would be missed until the next reconnect. The alternative is a timer on the client that reopens the stream every few minutes regardless. |
| W2 | **contract:** the heartbeat accepts a `watchdog` object (`reason`, `heapMB`, `budgetMB`), sent once just before a heap reload. | Otherwise a heap reload leaves no trace except an `uptimeSec` reset. |
| W3 | **contract:** `POST /api/state` gets two new `via` values, `resync` and `boot-hidden`. A page loaded while hidden reports `off`, which makes the server call `screenOff` on a screen that is already off. | See "State resync" and "Boot while hidden" above. |
| W4 | Heartbeat watchdog attempts: `loadStartURL` at 5 min, `restartApp` at 7 and 9 min, then stop. "3 attempts" is read as 3 calls in total for one silence. | Section 11 says "after 3 attempts stop" without saying what an attempt is. The other reading (3 rounds of loadStartURL then restartApp) means 6 calls over about 20 minutes. |
| W5 | Heap budget for the watchdog: 60 MB, or 120 MB while the cameras screen is mounted (the live-video budget), so the reload limits are 90 and 180 MB. These are constants in `shell/index.tsx`, not config. | Section 11 has two heap rows and doesn't say which applies. The doorbell popup also has video, but no reload happens while it is open. |
| W6 | "In use" for the nightly reload means the server's last known state is Active. That means touched within `toIdleSec`, or woken and not yet idle again. In soak mode the idle clock is paused, so the reload doesn't wait. | The server knows nothing finer. At 03:30 in quiet hours the tablet goes Off a minute after the last touch, so Active really means someone is there. |
| W7 | The nightly reload runs on the first tick inside its window, even if the server has only just started and doesn't know the tablet state yet. After an hour of waiting it runs anyway; a doorbell popup can hold it up to 5 more minutes. If the whole window is missed, there is no catch-up. | Keeps it simple. One missed night costs nothing; the next one runs. |
| W8 | With no known state (the server just restarted), the heartbeat watchdog expects heartbeats outside quiet hours. A live page reports one within 60 s, so 5 minutes of silence means the page is dead or stuck on Fully's error page. Inside quiet hours it waits, and the nightly reload covers that case. | Without this, a page that died while the server was down would never be recovered. The cost: if the page is alive but suspended behind a dark screen when the server restarts in the daytime, it gets one unneeded reload. |
| W9 | When the heartbeat watchdog gives up, it sets the tablet state to `null` and publishes `state`. Warm stills then stop. | L15 from milestone 2. |
| W10 | The heap watchdog also waits for a live event stream. Section 11 names only the popup and the 10 s after a touch. | If the server is down, a reload ends on Fully's error page, which then needs the server's watchdog to recover it. |
| W11 | Boot while hidden starts Off. This leans on `visibilityState`, which is still pending in the milestone 0 spike S3. If the WebView wrongly reports hidden with the screen on, the page boots to Off and the screen goes dark until the next touch or motion. | The nightly reload at 03:30 normally happens with the screen off. |
| W12 | A crash logs one `fatal` JSON line, with the stack, and exits for Docker to restart it. That is what Node 22 already does for both cases, but before this Node printed plain text that broke the JSON log. | Section 10, "logs are structured JSON". |

**Ratified by you, Oct 11:** W1, W2 and W3 approved. W4 to W12 stand as proposed (you deferred to these calls).

## 6. Gate checks (on the tablet)

Rebuild first: `cd ~/code/d-wall/wall && git pull && docker compose up -d --build`.

Useful filters:

```sh
LOGS="docker compose logs --no-log-prefix wall-server"
$LOGS | grep -E '"watchdog|kiosk: nightly|tablet state"' | jq -c '{msg, watchdog, cmd, tablet, via, time: (.time/1000|todate)}'
```

1. **Nightly reload ran.** The morning after the rebuild: `$LOGS | grep 'nightly reload'` should show one `loadStartURL` between 03:30 and 04:35 (`restartApp` from 03:45 on Sundays). Then check two things:
   - **Did the reload light the screen?** Look for the `tablet state` line straight after it. `off` / `boot-hidden` means the page loaded hidden and the screen stayed dark, which is what we want. `active` / `boot` followed by `off` / `quiet` a minute later means Fully turned the screen on for that minute. If so, tell me and I'll have the server send `screenOff` right after the reload.
   - Look for `motionDetection` set back to `false`. A `restartApp` might reset Fully's settings. It's the same question as S4 "survives restartApp".
2. **Kill the server.** `docker compose stop wall-server` for 7 minutes, then `docker compose start wall-server`.
   - While it's down, the calendar stays up, and "Not updated since HH:MM" appears after 5 minutes. Rail switches to already-loaded screens still work.
   - After the start, without a touch: the stale note clears within about a minute, and the log shows `tablet state` with `via: resync`.
3. **Kill the page (app alive).** Load a blank page into Fully: `docker compose exec wall-server node dist/kiosk-cli.js loadURL url=about:blank`. After 5 minutes the log should show `watchdog: no heartbeat` with `loadStartURL`, then `watchdog: tablet is back`, and the wall display should come back.
4. **Kill the app.** Force-stop Fully Kiosk in Android Settings → Apps. Fully's Remote Admin runs inside the app, so the server's calls will fail. Expect three failed attempts at 5, 7 and 9 minutes, then `giving up`. Whether Android or Fully restarts the app by itself depends on Fully's settings. Tell me what happens; if it stays dead, Fully's "Restart after crash" or a boot-start option is the fix, not the server.
5. **72 hour soak.** Set `debug: { soak: true }` in `config/config.yaml`, then `docker compose restart wall-server` and `$K loadStartURL`. Leave it for 72 hours, then summarise the heap per hour:
   ```sh
   $LOGS --since 73h | grep '"heartbeat"' | jq -r '[(.time/1000|strftime("%d %H")), .telemetry.heapMB] | @tsv' \
     | awk '{k=$1" "$2; s[k]+=$3; n[k]++} END {for (k in s) print k, s[k]/n[k]}' | sort
   ```
   The target is 10% or less above the first hour. Also check `leaks` (should stay 0), any `client watchdog reload` lines (each one is a budget breach worth reading), and the `kiosk device ram` lines every 5 minutes. Turn soak off afterwards.
6. **go2rtc log** (section 3): `docker compose logs go2rtc | grep -c rtsps` should print 0.
