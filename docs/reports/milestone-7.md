# Milestone 7 report: Spotify controller

Oct 11, 2026

Started at your request. This is the backlog item "Spotify controller, playing on the Google Nest Hub" (`docs/backlog.md`); it isn't in spec sections 1-14. The home screen (milestone 6) is parked on the branch `claude/home-assistant-parked` and isn't part of this work.

Status: code complete. Tested against a fake Spotify (its sign-in, Web API player endpoints and image host) in headless Chromium at 1280 × 800. **Not run against real Spotify, your Hub or the tablet.** The spike that decides whether this works day to day, whether Spotify lists an idle Hub, needs your account (section 4).

## 1. What shipped

| Item | Where | Notes |
| --- | --- | --- |
| Spotify client | `server/src/spotify.ts` | Holds the refresh token from `.env` and swaps it for short-lived access tokens, refreshing a minute before expiry and again on any 401. Timeouts of 8 s. Tokens never reach a log or the tablet. |
| One-time sign-in | `server/src/spotify-auth.ts` | Prints a Spotify sign-in link. You approve it in any browser, paste back the address Spotify sends you to, and it prints `SPOTIFY_REFRESH_TOKEN=…` for `.env`. Checks the `state` value, so an address from an old attempt is refused. Asks only for the three playback scopes (read state, control playback, read what's playing). |
| Spotify provider | `server/src/providers/spotify.ts` | Routes in section 2. Shares one Spotify read per second between callers. Honours Spotify's `Retry-After` on a 429. After a refused sign-in it waits 60 s before asking Spotify again, so polling can't hammer the token endpoint. Each kind of failure is logged once, not on every poll. Track names never reach the log. |
| Spotify screen | `client/src/screens/spotify/` | Detail below. Its own 8 KB bundle (3 KB gzipped). Follows the section 4 contract and the lint rule. |
| Rail icon | `client/src/shell/icons.tsx` | A music note, in the same style as the others. |
| Config | `config.example.yaml`, `.env.example` | `spotify: { device: "Kitchen display" }`: the speaker "Play on" sends music to. Three secrets in `.env`. |

**Screen behaviour**
- **Layout:** the same header as the cameras screen ("Spotify", "Playing on Kitchen display", clock). Below it, album art on the left. On the right: title, artist, album, a progress bar, previous / play-pause / next, a volume slider, and the Speakers and Play on buttons.
- **Play and pause** change at once. Spotify's answer replaces the guess within 2.5 s.
- **Volume** is sent when you let go of the slider.
- **Play on Kitchen display** appears whenever music isn't already on that speaker. It moves playback there and starts it, resuming what was playing last.
- **Speakers** opens a list of every device Spotify can see. Tap one to move the music there. If the Hub isn't in the list, the sheet explains how to bring it back.
- **Nothing playing:** a placeholder and "Start something in the Spotify app, or play on Kitchen display."
- **Problems** show as a yellow note: not set up, sign-in expired, Premium needed, Spotify not responding, speaker not listed.
- **Polling:** every 3 s, only while the screen is showing. The progress bar moves locally in between. The last state is kept, so coming back to the screen paints at once.
- **Return:** back to the first rail screen after 90 s without a touch, the same as the cameras grid.

## 2. Contract additions (section 10's HTTP surface)

Section 10's HTTP surface is a protected contract, so these additions need your OK:

| Route | Purpose |
| --- | --- |
| `GET /api/spotify/player` | What's playing, progress, the current speaker and its volume, the configured speaker. Always 200; a problem comes back as `ok: false, problem`. |
| `GET /api/spotify/devices` | Every speaker Spotify can see, and whether the configured one is among them. This is also the spike check. |
| `POST /api/spotify/command` | `{ type: play \| pause \| next \| previous \| volume, value? }`. 409 when nothing is playing anywhere, 403 without Premium, 503 for sign-in or rate-limit problems. |
| `POST /api/spotify/transfer` | `{ deviceId? }`. Moves playback and starts it. With no `deviceId` it uses the configured speaker, or answers 409 `target-missing` if Spotify can't see it. |
| `GET /api/spotify/art/:id` | Album art through the server, so the tablet only ever talks to the server. The last 4 are kept in memory; long cache headers. |

`ClientConfig` and `/api/state` are unchanged, and nothing touches sections 4 or 7.

## 3. Judgment calls to ratify

| # | Call | Why |
| --- | --- | --- |
| S1 | Called milestone 7. Number 6 stays with the parked home screen. | Its report and branch already use 6. |
| S2 | The screen polls every 3 s while it's showing. The server has no background work and no event-stream topic for Spotify. | The Spotify Web API has no push for playback, and section 4 says no background work while a screen is unmounted. Three seconds is well inside Spotify's rate limits for one tablet. |
| S3 | Album art isn't resized. | Spotify's largest image is 640 px, already smaller than the art panel's 896 device pixels. The art goes through the server so the tablet only ever talks to the server. |
| S4 | "Play on" finds the speaker by the name in `config.yaml`. | Spotify's device ids can change; the name you see in the Spotify app doesn't. |
| S5 | **The doorbell doesn't touch the music.** It keeps playing during a ring. | The backlog left this open. Pausing on a ring is a small change if you want it; tell me. |
| S6 | No quiet-hours limits. | The backlog left this open too. |
| S7 | Controls are play/pause, previous/next, volume and choosing a speaker. No search, playlists, shuffle or seeking. | The backlog asked for a controller. You pick music in the Spotify app or by voice on the Hub, and the wall controls it. |
| S8 | Spotify may hand back a new refresh token when the server refreshes. The server can't write `.env`, so it logs a warning; if the old token later stops working, the screen says the sign-in has expired and the fix is to run the sign-in again. | Spotify keeps old refresh tokens working today. Saving tokens would need a writable data folder, which nothing else uses yet. |
| S9 | Speaker ids reach the tablet, so tapping one in the list moves the music. | They're Spotify's opaque ids and not secrets. |
| S10 | The backlog's fallback for an unlisted Hub, starting the cast through Home Assistant, isn't available while Home Assistant is parked. The fallback for now: cast to the Hub once from the Spotify app, or say "Hey Google, play Spotify on Kitchen display". | See section 4. |

## 4. Spike: does Spotify list an idle Hub?

This decides whether "Play on Kitchen display" works day to day. Spotify lists a Cast speaker such as the Nest Hub only after something has recently cast Spotify to it. I can't measure this without your account.

Once it's set up (section 6), check it from any computer on the LAN:

```
curl -s http://<media server>:9600/api/spotify/devices
```

- **Right after** you cast from your phone, `targetFound` should be `true`.
- **Check again at a few points**: an hour later, the next morning, and after the Hub has been unplugged and plugged back in. Each check is also logged as `devices listed` with `targetFound`.
- On the tablet, try **Play on Kitchen display** at those same times.

| Result | What it means |
| --- | --- |
| Always listed | Done. |
| Listed for a few hours after a cast | Workable: the sheet tells you to cast once from your phone. We could also add "Hey Google, play Spotify" to the hint. |
| Rarely listed | "Play on" mostly fails. The options are casting directly from the server (an unofficial Cast protocol path that has broken before), or Home Assistant, which is parked. I'd pause here and talk it through with you. |

## 5. Verified here (fake Spotify)

| Check | Result |
| --- | --- |
| Nothing playing | Placeholder and "Play on Kitchen display"; play gives 409 `no-device` and the matching note |
| Play on the Hub | Transfer with `play: true`; the screen showed the track, art and "Playing on Kitchen display" within 2 s |
| Progress bar | Moves locally between polls (0:02 → 0:04 in 2 s) |
| Pause | Button flipped in under 60 ms; still paused after the next poll |
| Next | New track shown within 2 s |
| Volume | Slider at 70 sent `volume_percent=70`; Spotify's answer matched |
| Speakers sheet | Listed both devices with the active one ticked; tapping the phone moved playback there, and "Play on Kitchen display" came back |
| Hub not listed | Transfer gave 409 `target-missing`; the note and the sheet hint explain how to bring it back |
| Album art | Proxied as `image/jpeg` with long cache headers; a malformed id gets 404 |
| Bad input | Volume 150, volume with no value, and an unknown command get 400 |
| Access token expired | 401, one refresh, the command retried and succeeded |
| 429 | Screen shows "slow down"; the server honours `Retry-After` and recovers |
| Revoked refresh token | "Sign-in has expired"; one token attempt per 60 s, not one per poll |
| Not set up | "Spotify isn't set up yet"; one warning at start-up, only if `spotify` is in `screens:` |
| Leaving the screen | No Spotify requests while it's unmounted; coming back painted the last track in 69 ms |
| Sign-in script | Refuses an address from another attempt (state mismatch); a good one prints the refresh token |
| Secrets in the log | None: no client secret, refresh or access token |
| Lint, typecheck, build | Clean |

## 6. Setting it up

You need **Spotify Premium**: Spotify allows playback control through its Web API only on Premium accounts.

1. **Create a Spotify app.** Sign in at developer.spotify.com/dashboard and choose Create app. Give it any name and description. Under **Redirect URIs**, add exactly `http://127.0.0.1:8888/callback`. Under APIs used, tick **Web API**. Save.
2. **Allow your account.** In the app's settings, under **User Management**, add the email address of the Spotify account that plays on the Hub (if it isn't the account that owns the app).
3. **Secrets.** From the app's settings, copy the Client ID and Client secret into `wall/.env`:
   ```
   SPOTIFY_CLIENT_ID=...
   SPOTIFY_CLIENT_SECRET=...
   ```
4. **Get the code.** Run `git pull` on the branch, then `docker compose up -d --build` from `wall/`.
5. **Sign in once.** From `wall/`, run:
   ```
   docker compose run --rm --no-deps wall-server node dist/spotify-auth.js
   ```
   Open the link it prints, approve, and paste back the `127.0.0.1` address the browser lands on. The page itself won't load; that's expected. Add the `SPOTIFY_REFRESH_TOKEN=...` line it prints to `.env`.
6. **Config.** In `wall/config/config.yaml`, add `spotify: { device: "Kitchen display" }`, using the Hub's name exactly as the Spotify app shows it under Devices. Add `spotify` to `screens:`.
7. Run `docker compose up -d --force-recreate wall-server`.

To check it, run `docker compose logs wall-server | grep spotify`. If the log is quiet, it's working. Otherwise you'll see a `Spotify call failed` line with the problem (`auth`, `premium` and so on).

## 7. Budget

| Check | Target | Here | Real |
| --- | --- | --- | --- |
| Screen bundle | No target | 8 KB (3 KB gzipped) | |
| Requests while unmounted | 0 (section 4) | 0 | |
| Tap to the speaker changing | No target; Spotify takes about 0.5-1 s | ≤ 2 s (fake) | pending |
| JS heap | 60 MB or less | not measured headless | pending |
| Added using only the section 4 steps | yes | yes: `screens/spotify/`, one registry line, `providers/spotify.ts`, one provider line, `spotify` in `screens:`. Plus one rail icon. | |
