# Milestone 3 report: Doorbell

Oct 11, 2026

Status: code complete. Tested end to end in headless Chromium at 1280 × 800 against the real server, a fake go2rtc (stills only; it refuses WebRTC), and a fake Fully Kiosk Remote Admin and JavaScript interface. **Nothing has run against your real Protect, the Alarm Manager rule, or the tablet yet.** The section 7 targets with the screen off need the tablet.

## 1. What shipped

| Item | Where | Notes |
| --- | --- | --- |
| `DoorbellSource` | `server/src/providers/doorbell.ts` | The interface from section 7: a source with optional routes, `start(emit)` and `stop()`, emitting `ring { cameraId, at }`. |
| Webhook source | same | `POST /api/hooks/doorbell`. The secret goes in an `X-Doorbell-Secret` header (or `Authorization: Bearer …`) and is compared in constant time. Without `DOORBELL_WEBHOOK_SECRET` in `.env` every call gets 503. The body is accepted whatever its content type, up to 2 MB (Protect can attach a thumbnail, which is ignored). Only the alarm's trigger keys are logged, never the body. The ring is for the camera marked `doorbell: true`. |
| Doorbell provider | same | Section 7's four steps: rings within 10 s of the last are ignored (and logged); `doorbell.activeUntil` is set to 45 s from now; Fully `screenOn` and `toForeground` are called, retrying twice 1 s apart with any failure logged; `doorbell.ring` and then `state` are published. |
| Fresh still on a ring | `server/src/providers/cameras.ts` | A ring grabs a new doorbell still at once and keeps the 1 s refresh going for 5 s. While the tablet is Off there are no warm stills, so without this the popup would open on an old picture. |
| Popup lifecycle | `client/src/shell/doorbell.ts` | The shell owns opening and closing. A live `doorbell.ring` opens it; a `state` with a future `activeUntil` opens it too (asleep or reconnecting), silently. Closes at `activeUntil`. A touch on the panel keeps it open 30 s from the touch, up to 3 minutes. A second ring extends it. A ring that was shown or dismissed is never reopened by a later `state`. The idle clock is held while it is open and restarted when it closes. |
| Wake | `client/src/shell/index.tsx` | A ring while Idle or Off wakes the page (`via: ring`) and mounts home under the popup, as section 7 says. When it was awake, the screen underneath stays mounted and keeps its place. |
| Popup view | `client/src/overlays/doorbell/` | Built from the mockup: dimmed screen, 880 × 660 panel, bell badge, "Someone's at the front door", "Rang at 10:31 PM", close button, the camera view with the LIVE pill once video plays, Open cameras, Dismiss, and "Closes in N s" with its bar. The newest still shows at once (two stacked images, blob URLs revoked) and is replaced by live video as soon as WebRTC plays. No live video after 5 s, or a failed offer: "Live view unavailable" over a still refreshed every second. Its own 4 KB bundle; it reuses the cameras screen's `live.ts`. |
| One live stream | `client/src/screens/cameras/index.tsx` | While the popup is open, the cameras screen closes its own stream (full view, or the grid-live experiment) and reopens it when the popup closes. It also never leaves for the calendar from under the popup. |
| Ding | `client/src/shell/sound.ts`, `client/src/sounds/ding.wav` | Off unless `doorbell: { sound: true }` (D1). Plays only for a ring received live, never in quiet hours, never for a popup opened from `state`. Through Fully's JavaScript interface: media volume to 100, `playSound`, then the volume goes back to what it was after 4 s. A plain `Audio` element outside Fully. The ding is a 1.5 s two-note chime (E6 then C6), synthesized for this repo, 66 KB WAV. |
| Lint | `eslint.config.js` | The section 4 rule now also covers `client/src/overlays/**`. Checked with a throwaway file. |
| Timings | heartbeat route | Each popup posts `{ doorbell: { at, via, from, receivedMs, popupMs, stillMs, liveMs, sound } }` to `/api/telemetry`, logged as `doorbell popup`. All are ms after the ring by the server's clock (D6). |

## 2. Verified here (headless, fakes)

| Check | Result |
| --- | --- |
| Wrong or missing secret | 401, logged as `bad secret`. |
| Ring with Protect-style JSON, then two more at once | First accepted (`triggers: ["ring"]`), the next two logged as debounced. Fully got `screenOn` then `toForeground`. |
| 3 MB body | 413. |
| Page loaded 1.5 s after a ring | Popup shown from `state`, no sound, `receivedMs` 1757. |
| Dismiss, then a `state` publish | Stays closed. |
| Live ring over the cameras grid | Popup in 27 ms (webhook POST to popup on screen, same machine). Fully calls: `setAudioVolume(100, 3)`, `playSound(ding.wav, false, 3)`. |
| Touch on the panel at "Closes in 27 s" | "Closes in 30 s". |
| Second ring with 34 s left | Back to 45 s, and it dinged again. |
| Close, Dismiss, Open cameras | Close and Dismiss keep the screen beneath; Open cameras goes to cameras. |
| Left alone | Closed after 45 s. Overlay layer empty, `leaks: 0` in the heartbeat. |
| Ring while Off (3 s idle timings) | Woke (`tablet state active via ring`), calendar mounted beneath, popup, `from: "off"`. The idle clock stayed held for the 8 s the popup was open, and went Idle → Off on schedule after Dismiss. |
| Ring over full view | Full view's peer connection closed when the popup opened (one open in total), no fallback while paused, reopened on close. |

## 3. Measured against the targets

| Measure | Target | Here | Tablet |
| --- | --- | --- | --- |
| Ring to popup, screen on | 1.5 s or less | about 30 ms from the webhook arriving (`popupMs` 3–29) | pending |
| Ring to popup, screen off | 3 s or less | not measurable here | pending |
| Reconnect mid-ring shows the popup | yes | yes | pending |
| Double ring debounced | yes | yes | pending |

Protect's own delay (button press to webhook) comes on top and isn't in `popupMs`. Time it once by hand: press the button and count, or watch the server log time against a phone stopwatch.

## 4. Deviations and judgment calls to ratify

**contract** marks a change or addition to a section 4, 7 or 10 surface.

| # | Call | Why |
| --- | --- | --- |
| D1 | **contract, needs your yes:** the doorbell ding. Section 7 says the tablet plays no sound. It is built as you decided on Oct 11 (silent in quiet hours, full volume, missed rings silent), behind a new `config.yaml` switch, `doorbell: { sound: true \| false }`, **off when the key is missing**. Your real config doesn't have the key, so nothing changes until you add it. Proposed wording for section 7, replacing the last bullet: *"The tablet plays a short ding through Fully Kiosk at full volume when a ring arrives live, unless it is quiet hours. A popup opened from state after sleep or a reconnect is silent. `doorbell.sound` in `config.yaml` turns it off. The existing chime is unchanged."* | The milestone 2 report promised the wording before the build. You were away, so it is built but off. |
| D2 | **contract:** `/api/state`'s `doorbell` gains `at` and `cameraId` next to `activeUntil`. | A page needs to tell a ring it already showed or dismissed from a new one, or a dismissed popup reopens on the next `state`. `at` also gives "Rang at". |
| D3 | **contract:** the webhook secret header is named `X-Doorbell-Secret`. `Authorization: Bearer <secret>` also works. | Section 7 doesn't name it. If your Protect version can't send a custom header at all, tell me: the fallback would be the secret in the URL, which changes section 7. |
| D4 | Any authenticated POST counts as a ring of the doorbell camera; the alarm's trigger keys are only logged. | Protect's payload format isn't documented. Being strict about it could drop real rings. Keep the hook's secret to the one rule. |
| D5 | The server publishes `doorbell.ring` straight away, while the Fully calls run, instead of after them (section 7 lists the Fully call as step 3 and the publish as step 4). | Fully's calls can take up to 3 s each with retries. A page that is awake, or asleep with its event stream still open, can draw the popup meanwhile. |
| D6 | **contract:** the heartbeat route accepts `{ doorbell: {...} }` from the popup, logged as `doorbell popup`. The page estimates the server's clock from the `/api/state` round trip; the numbers can be off by about half that round trip (about 20 ms seen here). | Measures the section 7 targets, like L13 did for live video. |
| D7 | A touch on the panel never shortens the popup: it becomes 30 s from the touch or what was left, whichever is later, capped at 3 minutes from the latest ring. | "Resets it to 30 seconds" read literally would cut a fresh 45 s window short. |
| D8 | The popup has both the mockup's close button and its Dismiss button; both do the same. Tapping the dimmed area does nothing. | Mockup. |
| D9 | The overlay lives in `client/src/overlays/doorbell/` and is loaded by the shell, not listed in `screens/registry.ts`. It uses the section 4 `Mount` and `ScreenContext` unchanged. To close, it calls `ctx.go()` with the screen beneath; the shell treats "go to the screen already beneath the popup" as close-only, so that screen keeps its place. The shell sends it the ring details on a local `doorbell.popup` topic through the same `subscribe`. | Keeps the contract as it is. The registry is the rail's list. |
| D10 | The popup takes live video from the main stream (`cameraOptions.live`), like full view. | One stream at a time, so it can afford the best one. |
| D11 | Not built: the Protect event-stream source (`unifi-protect`). | Section 7 says to try the webhook first. If the webhook fails on your Protect, that source is next; it slots in behind `DoorbellSource` with no other change. |
| D12 | `doorbell.activeUntil` lives in memory, so a server restart in the middle of a ring forgets it. | It lasts 45 s. |
| D13 | The ding volume uses Android's media stream (3). | Fully's `playSound` plays there. If the ding is quiet, the tablet's media volume limit or Do Not Disturb is the place to look. |

## 5. Set up (in the morning)

1. **Secret.** On the media server: `openssl rand -hex 32`, and put it in `wall/.env` as `DOORBELL_WEBHOOK_SECRET=<value>`.
2. **Pull and restart** in `~/code/d-wall/wall`:
   ```sh
   git pull
   docker compose up -d --build
   docker compose logs wall-server | grep doorbell   # "doorbell: source started", cameraId "front-door"
   ```
3. **Test the hook by hand** before touching Protect (from the media server):
   ```sh
   curl -i -X POST -H "X-Doorbell-Secret: <value>" http://<WALL_BIND_ADDR>:9600/api/hooks/doorbell
   ```
   `200 {"ok":true}`, the tablet wakes and shows the popup. A second curl within 10 s logs `ring ignored`.
4. **Create the Alarm Manager rule** in Protect (the first task of this milestone in section 13). Names below are from memory of Protect's UI, so they may differ slightly:
   - Alarm Manager → Create alarm. Trigger: **Ring** (doorbell), scope: the front door camera only.
   - Action: **Webhook** → custom. URL `http://<WALL_BIND_ADDR>:9600/api/hooks/doorbell`, method **POST**.
   - Under the advanced options, add a header `X-Doorbell-Secret` with the secret. Thumbnail on or off doesn't matter.
   - Save, then press the doorbell. `docker compose logs wall-server | grep doorbell` should show `webhook received` with `triggers: ["ring"]` (or whatever key Protect uses; please tell me what it shows).
   - The UDM must reach the media server on port 9600. If the tablet or server sit on their own VLAN, allow UDM → server:9600.
   - If Protect has **no header field**, stop and tell me (D3).
5. **Turn on the ding** if you approve D1's wording: add `doorbell: { sound: true }` to `wall/config/config.yaml`, then `docker compose restart wall-server` and reload the page (`docker compose exec wall-server node dist/kiosk-cli.js loadStartURL`). Fully needs **Enable JavaScript Interface** on (already needed for the milestone 0 spikes).

## 6. Gate checks (on the tablet)

Read the timings after each ring:

```sh
docker compose logs --no-log-prefix wall-server | grep '"doorbell popup"' | jq -c .doorbell
```

| Case | `from` | `receivedMs` | `popupMs` | `stillMs` | `liveMs` | Target |
| --- | --- | --- | --- | --- | --- | --- |
| Screen on (Active) | active | | | | | `popupMs` ≤ 1500 |
| Idle (once milestone 4 is in) | idle | | | | | ≤ 3000 |
| Screen off | off | | | | | `popupMs` ≤ 3000 |
| Page reloaded mid-ring (`loadStartURL` within 45 s of a ring) | | | | | | popup appears, `via: "state"`, no ding |
| Two presses within 10 s | | | | | | one popup, `ring ignored` in the log |

Also check:
- `doorbell: tablet woken` with `attempt: 1` in the log. `could not wake the tablet` means Fully's Remote Admin isn't answering.
- With the screen off, whether the ding plays **before** the screen comes on, with it, or not at all. That says whether the page's event stream stays connected while the screen is off.
- Live video in the popup within a few seconds (`liveMs`), and the LIVE pill.
- After the popup closes, the screen stays on for the full idle time (3 minutes).
