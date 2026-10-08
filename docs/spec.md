# Wall Display Spec

Oct 8, 2026 · @Luke Dewitt

## 1. Goals, non-goals and rulings

A wall-mounted Galaxy Tab A11+ shows a week calendar, the four UniFi Protect cameras and a photo idle screen, and pops up the doorbell camera when someone rings. A small server on the home network does the heavy work; the tablet runs a thin web client inside Fully Kiosk Browser.

**Goals**

- Calendar: week view by default, swipe to change week. Events created in Google Calendar or Google Home show up within about 90 seconds.
- Cameras: a four-up grid, tap a tile for a full-screen live view.
- Doorbell: a ring wakes the screen and shows the doorbell camera over whatever is open.
- Idle: photos when nobody is using it, screen off after a set time, wake when someone walks by.
- Extensible: a new screen is one folder and one registry line, and cannot raise the tablet's memory use while it is not on screen.

**Non-goals for v1**

- Creating or editing events on the tablet (use Google Calendar or Home).
- Two-way audio, door lock control, PTZ, or any access from outside the home network.
- A native Android app, or more than one tablet.

**Rulings.** These are judgment calls made in this draft. Override any of them before building.

| Fork | Ruling | Why |
| --- | --- | --- |
| Client | Web app (TypeScript, Preact, Vite) inside Fully Kiosk | Fully Kiosk already handles screen on/off, kiosk lock and wake. Go native only if the soak test in section 11 fails. |
| Server | Node 22 and TypeScript (Fastify) in Docker on the basement media server | Same stack you already use, and it runs 24/7. |
| Calendar source | Google Calendar API, service account, a 60 s poll of a 10-week window | Secret iCal feeds can lag by hours. OAuth refresh tokens expire after 7 days when the app is left in Testing mode. |
| Server to tablet | Server-sent events (SSE) | Only one-way push is needed, and the browser reconnects on its own. |
| Camera grid | Refreshing still images in the grid, live video only in full view | Four live streams at once is where a mid-range tablet runs out of memory and gets hot. |
| Navigation | Left rail of icons; each screen owns its own swipes | Horizontal swipe belongs to the calendar. |
| Photo source | A folder of images on the server, resized to the screen. Immich comes later | No Immich albums exist yet. The source sits behind a PhotoSource interface, so Immich can drop in later. v1 uses public-domain art (section 8). |

## 2. Hardware and environment

Everything runs on the home network. Nothing here needs to be reachable from the internet.

| Part | What it is | Setup the build depends on |
| --- | --- | --- |
| Tablet | Samsung Galaxy Tab A11+, 11 inch, 1920x1200, Android 16, 6 GB RAM, mounted landscape, charged through a magnetic USB-C cable | Turn on the battery charge limit if the model offers one. Exclude Fully Kiosk from battery optimization. Lock orientation to landscape. |
| Fully Kiosk Browser (Plus licence) | Full-screen shell that loads the client URL | Start URL set to the server. Kiosk mode on, exit behind a PIN. Remote Admin on with a password (default port 2323). Motion detection on, turn screen on when motion is seen. Fully Kiosk's own screensaver off, because the client owns the idle states. |
| Server | Docker host on the basement media server, fixed LAN address | Two containers: the wall server and go2rtc (the stream relay). Photos come from a folder mounted into the wall server. |
| UniFi Protect on the UDM Pro | Source of camera streams and the doorbell ring | A local Protect user with view-only access. RTSPS turned on for each of the four cameras (not done yet). For the ring, an Alarm Manager webhook, with the event stream as the fallback (section 7). This Protect version has the trigger and the action; the rule still has to be created. |
| Google | Google Cloud project with the Calendar API on | One service account. Each calendar to show is shared with the service account's email address, with "See all event details". |

**Network.** The tablet reaches the server on its web port and go2rtc's WebRTC port. The server reaches the tablet on Fully Kiosk's Remote Admin port. Allow only those paths if the tablet sits on its own VLAN. The wall server listens on port 9600. Other port numbers are chosen at build time and kept in one config file.

## 3. Architecture

The client keeps no data of its own. It talks to one server, and the server owns every connection to the outside world.

&#91;embedded content: architecture · tablet, server, outside services\]

The client asks the server for data over HTTP and listens on one event stream. The server polls Google, relays camera streams through go2rtc, hears about rings from Protect, and tells Fully Kiosk when to wake or sleep.

## 4. Screen module model

The shell stays loaded, screens are lazy modules, and exactly one screen is mounted at a time. Unmounting a screen must leave nothing behind: no timers, listeners, streams, or DOM.

Every resource a screen uses comes from a context object the shell hands it. The shell releases all of it on unmount, so a screen author cannot forget to clean up.

```ts
// client/src/screens/types.ts
export interface Screen {
  id: string;                 // 'calendar'
  title: string;
  icon: string;               // icon name shown in the rail
  load: () => Promise<{ mount: Mount }>;   // dynamic import, one bundle per screen
}

export type Mount = (root: HTMLElement, ctx: ScreenContext) => void | Promise<void>;

export interface ScreenContext {
  signal: AbortSignal;                                   // aborts on unmount
  subscribe(topic: string, fn: (msg: unknown) => void): void;  // released on unmount
  every(ms: number, fn: () => void): void;               // timer cleared on unmount
  fetch: typeof fetch;                                   // bound to signal
  config: Readonly<ClientConfig>;
  go(screenId: string): void;                            // switch screen
  touch(): void;                                         // reset the idle clock
}
```

**Adding a screen later**

1. Create `client/src/screens/<id>/index.ts` exporting `mount`.
2. Add one entry to `client/src/screens/registry.ts`.
3. If it needs data, add `server/src/providers/<id>.ts` implementing `Provider` (`routes`, `topics`, `start()`, `stop()`) and one line in `providers/index.ts`.
4. Add the id to `screens:` in `config.yaml` to place it in the rail.

**Memory rules every screen follows**

- Screens never call `setInterval`, `addEventListener` on `window` or `document`, `new EventSource`, or `fetch` directly. They use the context. An ESLint rule enforces this.
- After unmount the shell checks that the root element is empty and the subscription count is back to baseline, and logs a leak warning in dev builds.
- No iframes, and no background work while a screen is unmounted.
- The client holds only what is on screen: at most three weeks of calendar events, two decoded photos, one live video stream.
- The server resizes images to the tablet's resolution. The client never receives an original.
- Server-side camera relays start when the first client subscribes and stop 10 seconds after the last one leaves.

**Switch speed.** Each screen's code is served with long cache headers, so only the first visit loads it over the network, and the shell preloads the cameras code 30 seconds after the page loads. The shell keeps the last calendar events in memory across unmounts (the same three weeks, no more), so the calendar paints at once and refreshes behind it. Targets are in section 11.

**Overlays.** The doorbell popup uses the same mount and unmount contract in a separate layer above the screens. It does not unmount the screen underneath.

**Template.** The repo ships `screens/example-clock` as a working template. It is also the test that the contract holds (section 12).

## 5. Calendar screen

The calendar opens on the current week, scrolls vertically through the hours, and moves a week at a time with a horizontal swipe.

**Server: the `calendar` provider**

- Every 60 seconds, for each configured calendar, call `events.list` for a window from the start of last week to 8 weeks ahead, with `singleEvents=true` so recurring events arrive already expanded.
- Normalize, merge and hash the result. If the hash changed, publish `calendar.changed` on the event stream.
- Poll immediately when a client connects or the tablet wakes, so a freshly woken screen is never a minute behind.
- Keep the last good result in memory. If Google is unreachable, keep serving it and mark it stale.
- Cancelled events are dropped. Declined events are dropped. Everything else is shown.

Normalized event, as served by `GET /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD`:

```json
{
  "id": "abc123",
  "calendarId": "family",
  "title": "Dentist",
  "start": "2026-10-08T15:00:00-03:00",
  "end": "2026-10-08T16:00:00-03:00",
  "allDay": false,
  "location": "",
  "description": ""
}
```

For all-day events `start` and `end` are plain dates (`2026-10-08`), with `end` exclusive, as Google sends them.

**Client: the `calendar` screen**

- Header: week range, previous and next arrows, a Today button. Below it an all-day row, then seven day columns over a 24-hour grid.
- On open it scrolls so the current time sits about a third of the way down. For other weeks it starts at 07:00. Today's column is tinted and carries a now-line.
- Events take their calendar's colour from `config.yaml`. Overlapping events sit side by side. Multi-day events span the all-day row.
- Swipe left or right by more than 80 px, or a fast flick, moves one week with a 200 ms slide. Vertical drag scrolls the hours. The arrows do the same for taps.
- Tapping a day's header opens a single-day view. A Week chip returns, and swiping there moves one day.
- Tapping an event opens a read-only sheet with title, time, place, calendar and the first 300 characters of the description. Tapping outside closes it.
- After 60 seconds without touch on any week other than this one, it returns to the current week.
- The client caches the visible week plus one either side and drops the rest. Each `calendar.changed` message refetches only those weeks.
- If the last successful contact with the server is more than 5 minutes old, a small "Not updated since HH:MM" note appears. The cached events stay visible.

Week start, time zone and 12 or 24 hour clock are config values. Defaults: Sunday, America/Halifax, 12 hour.

## 6. Cameras screen

The grid shows four refreshing still images. Tapping one opens a live stream of that camera alone.

**Server: the `cameras` provider and go2rtc**

- go2rtc runs as a sidecar container with one stream per camera, fed from that camera's Protect RTSPS address. The server generates go2rtc's config from `config.yaml` (camera id, name, stream address, which one is the doorbell).
- Grid stills: `GET /api/cameras/:id/still.jpg` returns the latest cached JPEG, at most 640 px wide. The server refreshes a camera's frame every 2 seconds while a client is subscribed to `cameras.grid`.
- Warm stills: while the tablet is Active or Idle and nobody is on the grid, the server refreshes one still per camera every 30 seconds. A tile therefore has an image the moment the screen opens, and entering the grid speeds the refresh up to every 2 seconds. Refreshing stops while the tablet is Off.
- Still source is decided by a spike in milestone 2: either the Protect snapshot endpoint or a frame from go2rtc's low-resolution stream. Pick whichever uses less server CPU at one frame per 2 seconds. Hide it behind a `StillSource` interface so the other can be swapped in.
- Live view: `POST /api/cameras/:id/webrtc` takes the browser's WebRTC offer, passes it to go2rtc, and returns the answer. Use the camera's main stream if the tablet holds 15 frames per second or better in the milestone 2 test, otherwise its medium stream.
- If WebRTC has not connected after 5 seconds, fall back to a still refreshed every second and show "Live view unavailable".

**Client: the `cameras` screen**

- A 2x2 grid. Each tile shows the still, the camera name, and a "stale" mark if the image is more than 10 seconds old, shown only once the screen has been open for 3 seconds. Tiles use contain-fit on a dark background, because the doorbell and the other cameras will not share an aspect ratio.
- Stills load by fetching the image as a blob, decoding it, swapping it in, then revoking the previous object URL. Two stacked images per tile avoid flicker.
- Tapping a tile stops the stills and opens full view: one video element, the camera name, a close button, and previous and next arrows. Horizontal swipe also moves to the previous or next camera. Tapping the video shows or hides the controls.
- Audio stays muted. Only one live stream exists at any time.
- On leaving full view the client closes the peer connection, stops the tracks, clears `srcObject` and calls `load()` on the video, so the decoder is released.
- After 120 seconds without touch in full view it returns to the grid. The wider idle rules are in section 9.

## 7. Doorbell takeover

A ring wakes the tablet and puts the doorbell camera over whatever is on screen within about 3 seconds, then puts the tablet back where it was.

**Detecting the ring: the `doorbell` provider**

The provider depends on one interface, `DoorbellSource`, which emits `ring { cameraId, at }`. Two implementations, tried in this order in milestone 3:

1. **Protect Alarm Manager webhook.** A rule on the doorbell with the ring trigger and a webhook action pointing at `POST /api/hooks/doorbell`, with a shared secret in a header. This is the supported route, so build it first. Your Protect version offers both the ring trigger and the webhook action, but the rule has not been created yet. Creating it is the first task in milestone 3.
2. **Protect event stream.** The `unifi-protect` npm library connects to the UDM Pro with the local view-only user and the provider turns its doorbell-ring updates into `ring`. This is an unofficial interface and may change with Protect updates, which is why it sits behind `DoorbellSource`.

**When a ring arrives (server)**

1. Ignore any further ring for 10 seconds.
2. Set `doorbell.activeUntil` to 45 seconds from now.
3. Call Fully Kiosk's Remote Admin to turn the screen on and bring the app to the front. Retry twice, 1 second apart, and log any failure.
4. Publish `doorbell.ring` on the event stream.

`doorbell.activeUntil` is also part of the state sent to every client when it connects. A page that was asleep or reconnecting when the event fired still shows the popup when it comes back. The popup follows state, not just the event.

**The popup (client overlay)**

- A large panel over a dimmed screen. The screen beneath stays mounted and keeps its place.
- It shows the newest doorbell still straight away, then switches to live video as soon as WebRTC connects.
- Controls: a close button, and an Open cameras button that closes the popup and goes to the cameras screen.
- It closes at `activeUntil`. A touch on the panel resets it to 30 seconds from that touch, up to 3 minutes in total. A second ring while it is open extends it.
- On close the shell restores the previous screen, or the calendar if the tablet had been asleep, and restarts the idle clock so the screen does not go straight back to sleep.
- The tablet plays no sound in v1. The existing chime is unchanged.

**Proposed targets.** Ring to popup is 3 seconds or less with the screen off and 1.5 seconds or less with it on. Measured in milestone 3.

## 8. Idle behaviour

The tablet has three states: Active, Idle (photos) and Off. Touch moves it to Active, quiet time moves it down, and Fully Kiosk's motion detection brings it back from Off.

&#91;embedded content: idle states · 3 states, timers down, wake up\]

Each step down is a timer. Each step up is a touch, motion, or a ring.

**Timings (proposed, all in `config.yaml`)**

- Active to Idle after 3 minutes with no touch.
- Idle to Off after 20 more minutes.
- Wake from Off, by motion or touch, lands on the calendar. A ring lands on the doorbell popup (section 7).
- Quiet hours, 22:00 to 06:30: Idle is skipped and the screen goes Off after 1 minute. The server switches Fully Kiosk's motion detection off at the start and on at the end, using its settings command, so a person walking past at night does not light up the room. A ring and a touch still wake it.

**Who does what**

- The client owns the idle clock. A passive, capture-phase listener on the whole page resets it on any touch.
- When the client enters Off it unmounts the current screen to free memory, then tells the server with `POST /api/state`. The server calls Fully Kiosk's `screenOff`.
- Screen on comes from three places: Fully Kiosk's motion detection, a touch, or the server on a ring. The client treats the page becoming visible as "wake". If the visibility event proves unreliable in the milestone 0 spike, use Fully Kiosk's JavaScript interface events (`screenOn`, `screenOff`, `onMotion`) as the second signal.
- The first touch after Idle or Off is swallowed. It wakes the tablet and never also presses whatever was under the finger. All touches are ignored for 400 ms after a wake.

**The photos screen (Idle only)**

- Server: the `photos` provider reads from a `PhotoSource`. v1 uses the `folder` source: image files in a mounted directory, rescanned every 30 minutes. It serves `GET /api/photos/next` with the next image in shuffled order, resized to the tablet's screen and cached on disk (last 20 images). An `immich` source, using album ids and a read-only API key, drops in later.
- Seeding: a one-time script run by hand downloads about 150 public-domain landscape paintings from the Google Art Project category on Wikimedia Commons into the folder. It keeps only images at least 1,920 px wide and wider than tall, sends a proper User-Agent, and records each file's licence tag. Google's own Arts & Culture site does not allow downloads, and I did not find a public API for its art feed.
- Client: two stacked images that cross-fade every 30 seconds. The next image is fetched and decoded before the fade, the old blob URL is revoked after it. Landscape photos fill the screen, portrait photos sit centred on black.
- A small clock and date sit in one corner.
- It is mounted only in Idle. Leaving Idle unmounts it.

## 9. Navigation and gestures

Screens are chosen from a left rail with large icons. The shell owns no swipes, so each screen can use horizontal swipe for its own content, and the calendar gets week navigation without a gesture conflict.

**Rail.** 88 px wide, always visible, one icon per registered screen (Calendar and Cameras to start). Tap only, with targets of at least 56 px. New screens appear in the order given by `screens:` in `config.yaml`.

**Gestures and return-to-home.** Each screen drops back to its home state after a stretch with no touch.

| Screen and state | Horizontal swipe | Vertical drag | Tap | Returns after |
| --- | --- | --- | --- | --- |
| Calendar, week | Previous or next week | Scroll hours | Day header opens day view, event opens sheet | 60 s on any other week, back to this week |
| Calendar, day | Previous or next day | Scroll hours | Week chip returns to week | 60 s, back to this week |
| Cameras, grid | None | None | Tile opens full view | 90 s, back to the calendar |
| Cameras, full view | Previous or next camera | None | Shows or hides controls | 120 s, back to the grid |
| Photos (Idle) | None | None | Any touch wakes to the calendar | Not applicable |
| Doorbell popup | None | None | Close, or Open cameras | Section 7 |

**Page hardening, applied once in the shell**

- `overscroll-behavior: none`, `user-select: none`, no context menu, no pinch zoom, no pull-to-refresh.
- `touch-action: pan-y` on the calendar grid so horizontal swipes reach the screen's own handler, and `none` on live video.
- Landscape only.

**Layout and type.** Design for a landscape viewport. Confirm the real CSS pixel size in milestone 0 (expect roughly 1280 by 800). Size everything in `rem`, with the root size set from viewport height. Event titles are at least 18 CSS px so they read from across the room.

**Theme.** The approved look is in the [Wall Display Mockups](https://claude.ai/artifact/3Rgm25nsQfVG7dVETJDQat): calendar week, cameras grid, doorbell popup and idle art, each at 1280 by 800. It is dark, with one yellow accent for "now" and "today". All colour, type, spacing and radius live in one `theme.css` as variables, so screen code never holds a literal colour. Where the mockups and this section differ, the mockups win.

```css
:root {
  --bg: #0F1318;          --rail: #141920;       --card: #131820;
  --today: #19202A;       --control: #1A2028;
  --line: #232A33;        --line-soft: #1F262E;  --control-line: #2A323C;
  --text: #F2F4F7;        --text-2: #A3ACB9;
  --accent: #FFD166;      --on-accent: #1B1400;  --on-event: #0E1217;
  --live: #FF6B6B;
  --cal-me: #7DB3FF;        /* circle */
  --cal-kid-1: #FF9D8A;     /* rounded square */
  --cal-kid-2: #86D9AA;     /* diamond */
  --cal-holidays: #C4B5FD;  /* triangle */
  --font-display: 'Bricolage Grotesque', sans-serif;
  --font-body: 'Figtree', sans-serif;
  --radius-card: 20px;  --radius-event: 10px;  --radius-pill: 28px;
}
```

- **Calendar colours** come from `config.yaml` per calendar. Each calendar also has its own shape beside the title (circle, rounded square, diamond, triangle), so they stay distinguishable without colour.
- **Type.** Display face for the page title (36 px), clock (38 px) and day numbers (26 px), all bold. Body face for everything else. Event titles are 18 px bold, event times 14 px, small labels 13 px at the smallest. Event text is dark on the calendar colours.
- **Layout constants.** Rail 88 px, time gutter 56 px, one hour is 45 px, screen padding 24 px.
- **Fonts are bundled with the client**, not loaded from Google Fonts, so the wall display works with no internet.
- **Placeholders in the mockups** are not final: sample events, "Kid 1" and "Kid 2", camera names, camera images and the art caption.

## 10. Server, configuration and security

One Node service and one go2rtc sidecar, configured from a single file and reachable only from the home network.

**Repo layout**

```
wall/
  docker-compose.yml          # wall-server, go2rtc
  config.yaml                 # screens, calendars, cameras, timings (no secrets)
  .env                        # secrets, git-ignored
  server/src/
    index.ts                  # Fastify, SSE hub, serves the built client
    providers/                # calendar, cameras, doorbell, photos, kiosk
    providers/index.ts        # one line per provider
  client/src/
    shell/                    # rail, idle clock, event-stream client, overlay layer
    screens/                  # registry.ts, calendar/, cameras/, photos/, example-clock/
    theme.css
```

**Config sketch.** Placeholders only. Real addresses and ids go in the real file.

```yaml
server: { port: 9600 }
timezone: America/Halifax
weekStart: 0              # 0 = Sunday
clock: 12h
screens: [calendar, cameras]
idle: { toIdleSec: 180, toOffMin: 20, quietHours: { from: "22:00", to: "06:30" } }
calendars:
  - { id: me, googleId: "<calendar id>", color: "#4f8cff" }
  - { id: kid-1, googleId: "<calendar id>", color: "#f5a524" }   # one entry per child
  - { id: kid-2, googleId: "<calendar id>", color: "#2ecc71" }
  - { id: holidays-ca, googleId: "en.canadian#holiday@group.calendar.google.com", color: "#9aa0a6" }   # Google's public holiday calendar
cameras:
  - { id: front-door, name: Front door, rtsps: "<rtsps url>", doorbell: true }
  - { id: camera-2, name: "<name>", rtsps: "<rtsps url>" }
  - { id: camera-3, name: "<name>", rtsps: "<rtsps url>" }
  - { id: camera-4, name: "<name>", rtsps: "<rtsps url>" }
kiosk: { host: "<tablet ip>", port: 2323 }
photos: { source: folder, path: /data/photos, intervalSec: 30 }
```

**HTTP surface**

| Route | Purpose |
| --- | --- |
| `GET /api/state` | Snapshot on connect: doorbell `activeUntil`, calendar freshness, and the config the client needs |
| `GET /api/events` | Server-sent event stream: `calendar.changed`, `doorbell.ring`, `state` |
| `GET /api/calendar/events?from&to` | Normalized events for a date range |
| `GET /api/cameras` | Camera list from config |
| `GET /api/cameras/:id/still.jpg` | Cached still, at most 2 s old |
| `POST /api/cameras/:id/webrtc` | Relays a WebRTC offer to go2rtc and returns the answer |
| `GET /api/photos/next` | Next resized photo |
| `POST /api/state` | Client reports `active`, `idle` or `off` |
| `POST /api/telemetry` | Client heartbeat (section 11) |
| `POST /api/hooks/doorbell` | Alarm Manager webhook, secret required |
| `GET /healthz` | Liveness for Docker |

**Kiosk controller.** A small wrapper over Fully Kiosk's Remote Admin: `screenOn`, `screenOff`, `toForeground`, `loadStartURL`, `restartApp` and the settings commands. Every call has a 3 second timeout. Failures are logged and never block the rest of the server.

**Secrets** live in `.env`: the Google service account file path, the Protect credentials, the Immich key (once that source is used), the Fully Kiosk password and the doorbell webhook secret. They are never logged and never sent to the client.

**Security rules**

- Bind to the LAN interface only. No port forwarding.
- Publish go2rtc's WebRTC media port to the LAN and keep its admin API port internal to Docker.
- The Protect user is view-only. The Immich key, once used, is read-only. The Google service account has read access to the shared calendars only.
- The Fully Kiosk Remote Admin port accepts connections from the server's address only, enforced at the firewall.
- Logs are structured JSON with rotation. They never contain event titles, descriptions or photo names.

## 11. Memory and reliability budget

The main risk is a web page running for weeks without a restart. So the build has a measured budget, a nightly reset and a soak test that starts in milestone 0, not a hope that it will be fine.

**Proposed budget.** These numbers are starting points. Recalibrate them from the first measurements on the real tablet.

| Measure | Target | Measured in |
| --- | --- | --- |
| JS heap, calendar showing, steady state | 60 MB or less | Milestone 1 |
| JS heap, live video open | 120 MB or less | Milestone 2 |
| JS heap growth over a 72 hour soak, after the nightly reload | 10% or less above the first-hour value | Milestone 0, repeated in 5 |
| DOM nodes, one calendar week | 1,500 or less | Milestone 1 |
| Screens mounted at once | 1, plus at most 1 overlay | Always |
| Live video streams at once | 1 | Always |
| Decoded photos held | 2 | Milestone 4 |
| Switch to calendar, time to first paint | 300 ms or less | Milestone 1 |
| Switch to cameras, tiles showing images | 500 ms or less with warm stills, 2 s or less cold | Milestone 2 |
| Cameras full view, tap to live video | 3 s or less | Milestone 2 |

**Switching speed.** The three switching rows are targets taken from the design, not measurements. They hold because the calendar paints from data the shell already has, the camera tiles start from stills the server keeps warm (section 6), and each screen's code is cached after its first load (section 4). Full view waits on the WebRTC connection, which the 3 second target allows for.

**Measuring.** The client posts a heartbeat to `POST /api/telemetry` every 60 seconds: current screen, state, uptime, JS heap in MB (`performance.memory` where WebView provides it), DOM node count, and the shell's counts of live subscriptions and timers. JS heap does not include video and image decoder memory, so during soak tests the server also asks Fully Kiosk for its device info every 5 minutes and logs whatever RAM figures it reports.

**Safeguards**

- **Nightly reload.** At 03:30 the server calls `loadStartURL`, waiting up to an hour if the tablet is in use. On Sundays at 03:45 it calls `restartApp` instead.
- **Heap watchdog.** If the heap stays above 1.5 times the budget for three heartbeats in a row, the client reloads itself at the next quiet moment. Never during a doorbell popup, and never within 10 seconds of a touch.
- **Heartbeat watchdog.** No heartbeat for 5 minutes while the screen should be on: `loadStartURL`. Still silent after 2 more minutes: `restartApp`. After 3 attempts stop and log, so it cannot loop.
- **Reconnects.** The event stream reconnects with backoff of 1, 2, 5, 10 and 30 seconds with jitter, and refetches `/api/state` each time.
- **Never blank.** If the server is unreachable the client keeps showing the last data with a stale note.
- **Server.** Docker `restart: unless-stopped`, a healthcheck on `/healthz`, and a memory limit on the wall-server container (start at 512 MB).

**Soak harness.** Milestone 0 ships a debug mode that mounts and unmounts every registered screen on a 60 second loop overnight. A leak in any screen shows up as heap growth the next morning.

**If the soak fails.** If the web client cannot meet the budget after the leaks are fixed, wrap the same client in Capacitor to get a native shell. The server and the screens do not change. This is a named deferral (section 13).

## 12. Build order and definition of done

Six milestones for v1, each ending on the real tablet, then a seventh for the home screen after it. The soak test starts in milestone 0 so memory problems show up before the features pile on.

| Milestone | Builds | Gate |
| --- | --- | --- |
| 0. Shell and soak | Server skeleton, event stream, `/api/state`, telemetry, kiosk controller. Client shell with rail, idle clock, overlay layer, screen registry and `example-clock`. Fully Kiosk configured on the tablet. Soak harness. Spikes: real CSS viewport size, whether `screenOff` stays off and motion wakes it, how reliably the page sees wake, the settings command for motion detection. | Shell runs on the tablet for 24 hours with a flat heap. Spike answers are in the report. |
| 1. Calendar | Google provider, week and day views, swipe, stale note | A new Google event shows within 90 s. Heap 60 MB or less. Calendar paints within 300 ms of a screen switch. |
| 2. Cameras | go2rtc sidecar, stills, grid, full view. Spikes: still source, stream choice. | Four tiles refresh. Tap to live video in 3 s or less. Leaving full view returns memory to baseline. Heap 120 MB or less with video. Tiles show images within 500 ms of a switch with warm stills. |
| 3. Doorbell | `DoorbellSource` (webhook first), screen-on, popup, state on reconnect | Ring to popup within the section 7 targets. A page that reconnects mid-ring still shows the popup. A double ring is debounced. |
| 4. Idle and photos | State machine, photos provider with the folder source and the art seed script, photos screen, quiet hours, motion wake | Timings match section 8. Two decoded photos at most. Wake from Off lands on the calendar. |
| 5. Hardening | Nightly reload, watchdogs, offline behaviour, log hygiene | 72 hour soak within budget. Watchdogs verified by killing the server and the app. |
| 6. Home screen (after v1) | DeviceHub, Home Assistant implementation, command allowlist, home screen | As in section 14 |

**Rules for the implementer**

- Stop and flag instead of silently changing any contract in sections 4, 7 or 10.
- The Fully Kiosk command names and setting keys in this spec are written from general knowledge of its API. Confirm each against the documentation for the installed version in milestone 0 and list any difference in the report.
- Each milestone ends with a short implementation report: what shipped, measured numbers against the budget, spike results, and any deviation. A report outranks this spec for anything already shipped.
- Judgment calls made along the way are flagged for ratification, not buried in code.

**Definition of done**

- [ ] An event added in Google Calendar or Google Home appears on the tablet within 90 seconds.
- [ ] Week swipe, Today and day view work; the calendar returns to this week on its own.
- [ ] Four camera tiles refresh. A tap opens live video within 3 seconds. Close returns to the grid.
- [ ] A ring with the screen off wakes it and shows the doorbell within the section 7 targets.
- [ ] Active, Idle and Off follow the section 8 timings. Motion wakes the screen. Quiet hours are honoured.
- [ ] A 72 hour soak stays inside the section 11 budget and the nightly reload ran.
- [ ] A new screen, made by copying `example-clock` and following section 4 only, appears in the rail with no edit to the shell.
- [ ] With the server stopped and restarted, the tablet shows the stale note and recovers without a touch.
- [ ] No secret appears in the repo or in any log.

## 13. Named deferrals and open questions

Nothing below is in v1. Each item has a reason and a point to revisit it.

| Deferred | Why | Revisit when |
| --- | --- | --- |
| Month view | Week and day cover the wall use | After v1, if missed |
| Creating or editing events on the tablet | Google Calendar and Google Home already do it | If typing on the wall is wanted |
| Two-way audio, door lock control | Needs audio permissions and its own security thinking | Separate spec |
| Treadmill mode | The tablet works as a normal tablet after the kiosk PIN exit, with no special layout | If it leaves the wall often |
| Capacitor native shell | Only needed if the soak test fails | After milestone 5 |
| Protect-driven wake (a camera sees a person) | Fully Kiosk motion detection comes first | If front-camera motion is unreliable |
| Brightness schedule | Polish | After v1 |
| Outlook or Microsoft 365 calendar provider | The `Provider` interface allows it | If needed |
| More screens (weather, chores, etc.) | The module model exists for this | The first screen after v1 |
| More than one tablet | Not needed | Not planned |
| Immich photo source | No albums are set up yet | When albums exist |

**Settled**

- Week starts on Sunday with a 12 hour clock.
- Calendars: yours, each child's, and the Canadian holidays calendar. The holidays calendar is Google's public one and needs no sharing.
- Photos: no Immich albums exist yet, so v1 shows public-domain art from a folder (section 8). Immich comes later.
- Idle: 3 minutes to photos, 20 more to Off. Quiet hours run 22:00 to 06:30.
- The doorbell is the Front door camera. Protect has the ring trigger and the webhook action.
- Server: the media server, port 9600.
- Home screen scope: anything synced to Google Home is available, with a confirmation step for locks, garage doors and alarms (section 14). The screen is parked until we come back to it.

**Still to do**

- [ ] Turn on RTSPS for all four cameras in Protect, before milestone 2.
- [ ] Create the Alarm Manager rule for the front door ring, as the first task of milestone 3.
- [ ] Share your calendar and each child's calendar with the service account, and confirm in milestone 1 that the children's calendars allow it.
- [ ] Give the media server a fixed address or DNS name for the tablet's start URL.
- [ ] Before the home screen: list every device in Google Home, how it connects, and whether Home Assistant supports it (section 14).

## 14. Home screen (planned, after v1)

This screen is a room-by-room grid of tiles that shows device state and controls devices with one tap. Google Home cannot be driven directly from a home server, so the server reaches devices through a `DeviceHub` interface, and the first implementation is Home Assistant.

**Why not Google Home directly** (checked 8 October 2026)

- Google's Home APIs are Android and iOS SDKs, not a server API. The Nest Device Access API covers Nest hardware only, not third-party devices such as Matter plugs and lights ([library notes](https://pkg.go.dev/github.com/shotah/go-google-home-mcp)).
- Google started early access to a Google Home MCP server on 16 September 2026, for subscribers to the US$20 per month Premium Advanced tier in the U.S. It said nothing about other markets ([TechCrunch](https://techcrunch.com/2026/09/16/your-ai-agents-can-now-control-your-google-home-devices/)). Do not plan around it.
- Using the Android Home APIs would mean a native app, which gives up the thin web client in section 3.

**Ruling.** Control devices where they actually live, through Home Assistant. A Matter device can be paired with more than one controller, so it can stay in Google Home for voice control and also appear in Home Assistant. A device that only works through Google's cloud, with no Matter and no Home Assistant integration, cannot be reached. Check each device against Home Assistant's integration list before committing. `DeviceHub` keeps the door open for direct vendor providers (Hue, Kasa and so on) later.

**Server: the `home` provider**

```ts
interface DeviceHub {
  list(): Promise<Device[]>;                          // pinned devices only
  subscribe(fn: (change: DeviceState) => void): () => void;
  command(id: string, cmd: Command): Promise<void>;
}
type Command =
  | { type: 'on' } | { type: 'off' } | { type: 'toggle' }
  | { type: 'brightness'; pct: number } | { type: 'scene' };
```

- Routes: `GET /api/home/devices`, `POST /api/home/devices/:id/command`, and a `home.changed` event carrying only the devices that changed.
- The Home Assistant implementation sends commands over its REST API and listens for state changes on its WebSocket, filtered to the pinned devices. It reconnects with the same backoff as section 11.
- It authenticates as a dedicated non-admin Home Assistant user with a long-lived token in `.env`.
- **Allowed domains.** The server accepts commands only for pinned devices in an explicit list of domains: `light`, `switch`, `scene`, `climate`, `fan`, `cover`, `media_player`, `lock` and `alarm_control_panel`, whatever the client asks for. Everything else is read-only. The list lives in config, so adding a domain is a deliberate change.
- **Confirmation for risky devices.** Tiles for `lock`, garage `cover` and `alarm_control_panel` devices need a deliberate second step: press and hold for 1 second, then tap Confirm. This stops a stray touch or a child from opening a door. It is not security. The server logs every lock, garage and alarm command with its time. A PIN is a later option.
- **Updates.** An update service on the media server checks for new Home Assistant and go2rtc images every night at 03:00, pulls them and restarts the containers. It copies Home Assistant's config folder first and keeps the last 7 copies, and it keeps the previous image tag so a rollback is one command. While Home Assistant restarts, tiles show as unavailable and recover on their own. Pick an updater that is still maintained.

```yaml
home:
  hub: homeassistant
  url: "<home assistant url>"
  rooms:
    - name: Kitchen
      devices:
        - { id: light.kitchen_main, name: Main, type: light }
        - { id: switch.coffee, name: Coffee, type: switch }
    - name: Scenes
      devices:
        - { id: scene.movie_night, name: Movie night, type: scene }
```

**Client: the `home` screen**

- Room chips along the top, a grid of tiles below. Each tile has an icon, a name and its state. The list of rooms and devices comes from `config.yaml`, with a hard cap of 60 tiles. Nothing is auto-discovered, which keeps the screen small and the memory bounded.
- Tap a light or plug to toggle it. The tile changes at once, and reverts with an error mark if the real state has not confirmed within 2 seconds. Tap a scene tile to run it.
- Press and hold a light for 500 ms to open a brightness slider.
- Thermostats show the current and target temperature with plus and minus buttons. Plain sensors show as read-only tiles.
- Horizontal swipe moves to the next or previous room. The screen returns to the calendar after 60 seconds without touch.
- It uses the section 4 contract and adds one rail icon. Nothing in the shell changes.

**Gate (milestone 6).** A tap changes the real device and the tile confirms within 2 seconds. A change made in Google Home or at the wall switch shows on the tablet within 2 seconds. Heap is 60 MB or less. The screen was added using only the section 4 steps.

**Decided**

- Home Assistant on the media server is accepted, with automatic update checks and patching.
- Anything synced to Google Home is available on the screen. Locks, garage doors and alarms get a confirmation step instead of being left out.

**When we come back to this screen**

- [ ] List every device in Google Home (its Devices page), how each connects, and whether Home Assistant supports it. A first screenshot covered the Nash Room, the Basement and part of the Bedroom; the rest still needs capturing.
- [ ] Decide whether the hold-then-confirm step is enough for locks, garage doors and alarms, or whether to add a PIN.
