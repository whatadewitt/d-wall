# Milestone 2 report: Cameras

Oct 10, 2026

Status: code complete. It was tested against a **real go2rtc 1.9.9** (as a binary and as the pinned Docker image), fake cameras (ffmpeg test patterns served over RTSP), and a fake UniFi Protect served over HTTPS with a self-signed certificate. The client was tested in headless Chromium at 1280 × 800.

**Not tested here:** live video actually playing. This Chromium build can't decode H.264, and go2rtc's WebRTC output only carries H.264/H.265, so every live view in testing ended in the fallback. Everything up to go2rtc's answer is verified, as is the fallback. Playback, the fps numbers and releasing the decoder need the tablet. Nothing ran against your real cameras or Protect.

## 1. What shipped

| Item | Where | Notes |
| --- | --- | --- |
| Protect client | `server/src/protect.ts` | Logs in as the local view-only user with a cookie, then fetches the camera list and snapshots. After a failed login it waits 60 s before trying again, because the UDM locks accounts after repeated failures. Certificate checks are off for the UDM host only (L6). |
| go2rtc client | `server/src/go2rtc.ts` | Adds streams at runtime and confirms them against go2rtc's stream list. Also fetches frames (`frame.jpeg?width=640`) and relays the WebRTC offer and answer. go2rtc's error text goes into the log with any addresses removed. |
| Cameras provider | `server/src/providers/cameras.ts` | Each configured `rtsps` address is the camera's main stream. The provider finds the camera in Protect by that address (L1) to learn its medium and low streams and its Protect id. It registers `<id>`, `<id>_medium` and `<id>_low` in go2rtc and re-checks every 60 s, which also covers a go2rtc restart. |
| Still refresh | same | Every 1 s while full view has fallen back to stills, every 2 s while the grid is open (L4), and every 30 s while the tablet is Active or Idle with the grid closed. Stops while Off. A cold request waits up to 4 s for its first frame. Responses carry `ETag` and `X-Frame-At`, and an unchanged frame returns 304. Anything that isn't a JPEG counts as a failure. |
| StillSource | same | Two implementations, `protect` (snapshot API) and `go2rtc` (a frame from the low stream), chosen by `cameraOptions.stills` (L2). A `still stats` log line every 5 minutes gives grab count, failures, average time, average size and the widths seen: the spike numbers. |
| Routes | same | `GET /api/cameras`, `GET /api/cameras/:id/still.jpg`, `POST /api/cameras/:id/webrtc`, as in section 10. |
| go2rtc sidecar | `docker-compose.yml` | Pinned `alexxit/go2rtc:1.9.9`. The config is passed inline, so go2rtc has no file to write stream addresses into (L3). The API (1984) stays on the Docker network; only WebRTC (8555 TCP and UDP) is published, on `WALL_BIND_ADDR`. Memory limit 512 MB. |
| Cameras screen | `client/src/screens/cameras/` | Built from the mockup (detail below). 8 KB bundle. Follows the section 4 contract and passes the lint rule. |
| Shell | `shell/index.tsx`, `shell/icons.tsx` | Preloads every rail screen's code 30 s after boot (L14). Adds the camera rail icon. |
| Config | `config.yaml`, `.env.example` | `screens: [calendar, cameras]`, `cameraOptions: { stills: protect, live: main }`, `PROTECT_USERNAME` and `PROTECT_PASSWORD`. |

**Cameras screen behaviour** (all tested headless except live playback):

- The 2 × 2 grid has the "Cameras" title, the "Tap a camera for live view" subtitle and the clock.
- Each tile shows its still contain-fit on black, an age label ("1 s"), and the camera name; the doorbell tile has the bell icon. A striped placeholder shows until the first image.
- "Stale · N s" appears in accent colour when an image is more than 10 s old, and only once the screen has been open for 3 s. Tested by stopping Protect: both tiles showed "Stale · 14 s", and the label went back to normal when Protect returned.
- Stills are fetched as blobs, decoded into the hidden of two stacked images, swapped in, and the old blob URL revoked. At most 2 blob URLs per tile, and 0 left after unmount.
- Tapping a tile stops the grid stills and opens full view: one video, the name, close, and previous/next arrows. A horizontal swipe changes camera. Tapping the video shows or hides the controls.
- Only video is requested, so there's no audio. One live stream at a time.
- Leaving full view, or switching camera, closes the peer connection, stops the tracks, clears `srcObject` and calls `load()`.
- If there's no live video after 5 s, or the offer fails (L11), full view shows "Live view unavailable" over a still refreshed every second.
- The grid returns to the calendar after 90 s without touch, and full view returns to the grid after 120 s. Both tested with a fake clock.
- While live, and on close, the screen posts live-view numbers to `/api/telemetry` (L13): camera, stream, connect time, current and average fps, dropped frames, resolution, and whether it fell back.

## 2. Measured (headless, not the tablet)

| Measure | Target | Result |
| --- | --- | --- |
| Switch to cameras, first tile image (warm stills) | 500 ms or less | 98–252 ms |
| JS heap, grid showing | none set | 3.3–3.5 MB |
| Leaks over 30 simulated soak cycles (calendar, cameras, clock) | 0 | 0. Subscription and timer counts back to baseline; 0 blob URLs left. |
| Still from go2rtc at `width=640`, from a 1080p source | ≤ 640 px | 640 × 360. About 0.9 s per frame, because go2rtc starts ffmpeg for each one. |
| Tap to live video | 3 s or less | **Not measurable here** (no H.264 in this Chromium). The offer now leaves within 1 s. |
| JS heap with live video | 120 MB or less | **Tablet only** |

## 3. Deviations and judgment calls to ratify

**contract** marks an addition to a section 4, 7 or 10 surface.

| # | Call | Why |
| --- | --- | --- |
| L1 | Stream addresses come from a Protect API lookup: the camera is matched by the stream alias in its `rtsps` address, and its medium and low aliases and Protect id are read from the same record. If the lookup fails, every quality falls back to the main stream. **Ratified by you, Oct 10.** | It keeps the section 10 config shape. |
| L2 | **contract** `config.yaml` gains `cameraOptions: { stills: protect \| go2rtc, live: main \| medium }`. You approved the stills switch; `live` is the same idea for the stream spike. | Section 6 makes both spike decisions. |
| L3 | go2rtc's config is inline in `docker-compose.yml`, and wall-server adds the streams through go2rtc's API, rather than "generating go2rtc's config" (section 6). | Found in testing: go2rtc writes streams added through its API back into its config file whenever it has one. Protect's RTSPS addresses carry access tokens, and a file inside the repo folder is one `git add` away from being committed. With an inline config nothing is written. Checked in the container: `/config` stays empty. |
| L4 | "While a client is subscribed to `cameras.grid`" is implemented as a lease: each still request keeps its camera on the 2 s refresh for 5 s (`?fast=1`: 1 s). There's no `cameras.grid` topic and no new route. | `cameras.grid` isn't in the section 10 event list, and the server otherwise can't know what a screen subscribed to. |
| L5 | go2rtc stops a relay as soon as its last viewer leaves; there's no 10 s linger (section 4 memory rules). | go2rtc has no setting for it. Effect: flicking between cameras reconnects each time (about 1 s). |
| L6 | Protect API calls skip certificate checks for the UDM host only, and go2rtc reads RTSPS through `rtspx://`, which also skips the check. | The UDM Pro's certificate is self-signed. **Option:** pin the UDM's certificate fingerprint in `.env`. |
| L7 | The Protect host is taken from the cameras' `rtsps` addresses. | No new config key. |
| L8 | `/api/cameras` lists only cameras with a usable address. Placeholders are skipped with a log line. | Avoids dead tiles. |
| L9 | Live view requests no audio track. | "Audio stays muted", and it saves decoding. |
| L10 | The ICE gathering wait in `screens/cameras/live.ts` is capped at 1 s with a `setTimeout`. That's allowed by the lint rule, and it only settles a promise. | Found in testing: gathering can stall indefinitely, which would leave the offer unsent. Related to J17 (no one-shot timer in `ScreenContext`). |
| L11 | A failed offer falls back to stills at once instead of waiting out the 5 s. | Nothing is coming. |
| L12 | "Back to the calendar" after 90 s goes to the first entry in `screens:`. | Same rule as J12. |
| L13 | **contract** `/api/telemetry` also accepts `{ video: {...} }` from the cameras screen, logged as `live view`. | It provides the stream spike and gate numbers. Screens can't add fields to the shell's heartbeat. |
| L14 | The shell preloads every rail screen's code, not only cameras. | Generic, and the shell doesn't need to know screen ids. |
| L15 | Warm stills (30 s) continue while the server thinks the tablet is Active or Idle. If the tablet disappears without reporting Off, they continue until the heartbeat watchdog (milestone 5). | Cheap: one snapshot per camera every 30 s. |
| L16 | **Full view isn't in the mockups.** It's black letterboxing, the name top-left, close top-right and arrows centred on each side, using the grid's label and round-button styles. Please review it on the tablet. | |
| L17 | Stills that aren't JPEGs are rejected. | Found in testing: go2rtc answered 200 with an empty body for a codec it can't snapshot. |
| L18 | go2rtc is pinned to `alexxit/go2rtc:1.9.9`. The container's entrypoint is set to `go2rtc` directly (to pass the inline config), with compose `init: true` reaping its ffmpeg children. | |

## 4. Before deploying

1. **In Protect:**
   - Enable RTSPS on each camera for **all three qualities** (High, Medium and Low). Medium is the live-view fallback, and Low feeds the go2rtc still source.
   - Make sure the local view-only user exists.
2. **In `config.yaml`:** for each camera, set `rtsps` to its **High** RTSPS address from Protect, in quotes, and set a `name`. The `id`s are yours to choose (for example `driveway`).
3. **In `.env`:** set `PROTECT_USERNAME` and `PROTECT_PASSWORD` to the view-only user.
4. **Firewall:** the tablet must reach `WALL_BIND_ADDR:8555` on both TCP and UDP (section 2, network).

## 5. Deploy

In `~/code/d-wall`:

```sh
git stash && git pull && git stash pop        # merges cleanly with your config.yaml edits (checked)
cd wall && docker compose up -d --build       # also pulls go2rtc
docker compose logs wall-server | grep -E "cameras:|still stats"
```

Each camera should log `cameras: found in Protect` with `medium: true, low: true`. If you see `not found in Protect by its RTSPS address`, the `rtsps` value isn't the High address from Protect. `Protect lookup failed` gives the reason, such as a wrong password or an unreachable host.

## 6. Spikes (on the server and tablet)

**S6. Still source: which uses less server CPU at one frame per 2 s?**

1. With `stills: protect`, keep the grid open on the tablet for 15 minutes. Sample the containers' CPU every 30 s with `docker stats --no-stream wall-wall-server-1 wall-go2rtc-1`, and note the `still stats` lines.
2. Set `stills: go2rtc`, run `docker compose restart wall-server`, and repeat.

| Source | wall-server CPU (avg) | go2rtc CPU (avg) | avg ms per still | avg KB | widths | failures |
| --- | --- | --- | --- | --- | --- | --- |
| protect | | | | | | |
| go2rtc | | | | | | |

Keep whichever has the lower total CPU. Also check that `widths` shows 640. If Protect ignores `w=640`, its stills arrive full size: the client still fits them in the tile, but they'd break the "at most 640 px" rule.

**S7. Live stream: does the tablet hold 15 fps on the main stream?**

With `live: main`, open each camera in full view for 60 s. Then:

```sh
docker compose logs --no-log-prefix wall-server | grep '"live view"' | jq -c .video
```

| Camera | stream | connectMs | avgFps | dropped | resolution |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

If any camera stays under 15 fps, set `live: medium`, restart, and repeat.

## 7. Gate checks (on the tablet)

- **Four tiles refresh** (age labels stay around 1–2 s).
- **Tap to live in 3 s or less** (`connectMs`).
- **Leaving full view returns memory to baseline:** compare the heartbeat `heapMB` on the grid before and after a few live views, and Fully's RAM figures in soak mode.
- **Heap 120 MB or less with video.**
- **Tiles show images within 500 ms of a switch with warm stills** (by eye; this is the warm path measured at 98–252 ms here).

## 8. Spike: one tiled stream instead of four stills (asked Oct 10)

**Question:** would a single ffmpeg 2 × 2 tiled video for the grid be better than four refreshing stills?

**Setup:** four fake 640 × 360, 15 fps H.264 cameras over RTSP. go2rtc 1.9.9 ran an `exec:ffmpeg` stream using `xstack` to tile them into 1280 × 720 at 10 fps, re-encoded with libx264 `ultrafast`. Measured on this environment's 4-vCPU 2.1 GHz Xeon. Your media server's numbers will differ, and Intel Quick Sync, if present, would cut the encode cost.

| Measure | Tiled stream | Stills today |
| --- | --- | --- |
| Time to first image, from cold | about 10 s with ffmpeg defaults; about 5 s with fast input probing (`-fflags nobuffer -probesize 65536 -analyzeduration 500000`). WebRTC setup on the tablet comes on top. | 98–252 ms (warm stills) |
| Server CPU while the grid is open | about 20% of one core (the tiling ffmpeg alone) | go2rtc stills: about 16% of one core. Protect stills: close to 0 (the server only passes the image along). |
| One camera missing when the grid opens | **No video at all.** ffmpeg won't start if any input is missing, so all four tiles stay blank. | That one tile shows "Stale"; the other three keep refreshing. |
| One camera dies while playing | Inconclusive. The fake camera server restarted the dead source by itself. With real cameras, expect either a frozen tile or ffmpeg exiting, which blanks all four. | Same as above: one stale tile. |
| Other | Needs go2rtc's internal RTSP server turned back on, since `exec` sources return video over it (Docker network only). Labels and stale marks become harder because the picture is one image. | |

**Recommendation: don't adopt it.** It trades a 250 ms grid for a roughly 5 s one, costs at least as much CPU as the most expensive still source, and turns one camera's outage into four blank tiles. Its only gain is real motion in the grid. If 2 s stills feel too choppy on the wall, use 1 s refresh with Protect stills (a one-line change) first.

