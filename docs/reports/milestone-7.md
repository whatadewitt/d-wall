# Milestone 7 report: Spotify now playing, island and Google Home link

Oct 11, 2026

Started at your request. It reshapes the backlog item "Spotify controller" (`docs/backlog.md`) after your Oct 11 decisions:

- **Device control stays in Google Home.** The wall gets a rail icon that opens the Google Home app, so nothing is managed in two places. The home screen (milestone 6) stays parked on `claude/home-assistant-parked`.
- **Spotify is display only.** It shows what's playing and on which speaker. The kids start music on the kitchen Hub or their tablets; the wall never controls it.
- **Now playing everywhere:** a Spotify page in the rail, a card on the lock screen, and a floating "island" at the bottom of the other pages.

The first version of this milestone (a full remote control: play/pause, skip, volume, choosing a speaker) was replaced the same day and never merged.

Status: code complete. Tested against a fake Spotify with two accounts in headless Chromium at 1280 × 800. **Not run against real Spotify, the Hub, Fully Kiosk or the tablet.**

## 1. What shipped

| Item | Where | Notes |
| --- | --- | --- |
| Spotify provider | `server/src/providers/spotify.ts` | Polls each signed-in account every 5 s while something plays and every 10 s otherwise, **only while the tablet is Active or Idle**. Nothing is polled while it's Off. Publishes `spotify.now` when the track, speaker, art or play state changes, or the position jumps (a seek). New clients get the current state when they connect. |
| Choosing between accounts | same | An account playing on the kitchen speaker wins, then any account that's playing, then one paused in the last 10 minutes. After 10 minutes paused, it disappears from the wall. |
| Spotify client | `server/src/spotify.ts` | Unchanged from the first version: refresh-token handling, retry on 401, honours `Retry-After`. After a refused sign-in it waits 60 s before asking again. |
| One-time sign-in | `server/src/spotify-auth.ts` | Run once per Spotify account. Asks only to **read** playback, nothing else. Always shows Spotify's account dialog, so you can switch accounts between runs. |
| Spotify page | `client/src/screens/spotify/` | Album art, title, artist, album, a progress bar, and a card naming the speaker and its kind ("Kitchen display · Google Cast speaker"). Paused dims the art. With nothing playing: "Start Spotify on the kitchen Hub or a tablet, and it shows up here." Back to the first rail screen after 90 s without a touch. |
| Island | `client/src/shell/island.tsx`, `theme.css` | A pill floating at the bottom centre of every rail page except the Spotify page: art, title, artist and speaker, with small moving bars (still when paused). A tap opens the Spotify page. Hidden on the lock screen, over the doorbell popup, and when nothing is playing. Shown only if `spotify` is in `screens:`. |
| Lock screen card | `client/src/screens/photos/` | Above the clock: art, title, artist, "on Kitchen display". |
| Google Home link | `client/src/shell/links.ts`, `rail.tsx`, `fully.ts` | A rail item called **Home**. A tap asks Fully Kiosk to open the Google Home app (`fully.startApplication`). It's placed by putting `google-home` in `screens:`, like a screen. |

## 2. Contract changes to ratify

| # | Section | Change |
| --- | --- | --- |
| C1 | 10, HTTP surface | `GET /api/spotify/now` returns `{ now, problem }`, where `now` holds the track, art, progress and speaker, or `null` when nothing is playing. `GET /api/spotify/art/:id` serves album art through the server, with the last 8 kept in memory. |
| C2 | 10, event stream | New event: `spotify.now`, with the same body as C1. |
| C3 | 9, rail | The rail can hold **links** as well as screens. A link opens another app instead of mounting a screen. The `Screen` type and the section 4 contract are unchanged; the rail takes a plain `{ id, title, icon }` item. |
| C4 | 4 and 11, what's on screen | The island is shell UI drawn above the stage, like the rail. It isn't a screen or an overlay, so "one screen plus at most one overlay" still holds. It adds one small image (the album thumbnail) while something plays. The lock screen card adds one more next to the two decoded photos (section 11 counts photos, not thumbnails). |

`ClientConfig` and `/api/state` are unchanged, and nothing touches section 7.

## 3. Judgment calls to ratify

| # | Call | Why |
| --- | --- | --- |
| S1 | Called milestone 7. Number 6 stays with the parked home screen. | Its report and branch already use 6. |
| S2 | **Several Spotify accounts.** You said the Hub plays your account and you'd prefer your wife's, so the wall signs in as each account once (`SPOTIFY_REFRESH_TOKENS`, comma-separated) and shows whichever is playing. | Spotify only tells an account about its own playback. To make the Hub use your wife's account instead, change the Spotify account linked in the Google Home app (Settings, Music). With both accounts signed in, the wall works either way. |
| S3 | When two accounts play at once, the one on the kitchen speaker (`spotify.device` in `config.yaml`) wins. | The kitchen is what's heard in the room with the wall. |
| S4 | A paused track stays shown for 10 minutes, then the wall goes back to showing nothing. | Spotify keeps reporting a paused session for a long time; a track paused hours ago isn't useful on the lock screen. |
| S5 | The server polls, not the tablet, and only while the screen is lit. | The island and the lock screen need the state on every page; one poller on the server serves them all. Spotify has no push for playback. |
| S6 | The island floats over the page; screens don't shrink for it. | Your choice. It covers part of the calendar's last visible hour, near the centre. |
| S7 | The rail label is **Home**, with a house icon. | "Google Home" doesn't fit under an icon in the 88 px rail. |
| S8 | `google-home` shouldn't be first in `screens:`, because the first item is the screen the wall returns to. | The shell already skips links when picking home, but screens use the first entry for their return timeouts. |
| S9 | Spotify may hand back a new refresh token. The server can't write `.env`, so it logs a warning; if the old token stops working, the wall shows "sign-in has expired" until the sign-in is run again. | Spotify keeps old refresh tokens working today. |
| S10 | Track names never reach the log. | The same rule section 10 sets for event titles. |

## 4. Spikes on the tablet

**Google Home link**
1. In Fully Kiosk, the Google Home app must be allowed to open from kiosk mode: Settings, Kiosk Mode, the app whitelist, add `com.google.android.apps.chromecast.app`. The exact menu names vary by Fully version, so tell me what you find.
2. Tap Home on the rail: does Google Home open?
3. **Getting back:** with kiosk mode on, the Android Home or Back button should return to Fully Kiosk. A doorbell ring already brings Fully to the front (milestone 3). Check what happens if someone leaves Google Home open and walks away. If the wall stays hidden, I can have the server bring Fully back after a few minutes with no touch.
4. **Locks and the alarm:** the Google Home app on the tablet is signed in as you, so anyone at the wall gets your full Google Home. Check whether unlocking needs a PIN there (Google Home asks for one for some locks).

**Spotify**
- Start music on the Hub, then on a kid's tablet, and check the island, the Spotify page and the lock screen pick it up within about 5 s.
- Check the speaker name shown matches what's playing.

## 5. Verified here (fake Spotify, two accounts)

| Check | Result |
| --- | --- |
| Nothing playing | `now: null`; no island; the Spotify page shows the hint |
| Only a tablet playing | Shown within one poll (track, art, "Emma's tablet · Tablet") |
| Kitchen and tablet both playing | Kitchen shown |
| Kitchen paused, tablet playing | Switched to the tablet |
| Both paused | Most recent paused track shown as "Paused"; the island's bars stop |
| Kitchen plays again | Back to the kitchen |
| Island | On the calendar and cameras pages; not on the Spotify page; a tap opened the Spotify page |
| Lock screen | Card above the clock: title, artist, "on Kitchen display"; no island |
| Google Home rail item | Called `fully.startApplication("com.google.android.apps.chromecast.app")`; the current page stayed put |
| Tablet Off | 0 Spotify calls in 15 s while Off; polling resumed on wake |
| Secrets and track names in the log | None |
| Lint, typecheck, build | Clean |

The 10-minute cut-off for paused tracks (S4) wasn't timed here.

## 6. Setting it up

Reading what's playing works on any Spotify account. Spotify may require the account that creates the developer app to have Premium.

1. **Create a Spotify app.** Sign in at developer.spotify.com/dashboard and choose Create app. Give it any name. Under **Redirect URIs**, add exactly `http://127.0.0.1:8888/callback`. Tick **Web API**, then save.
2. **Allow the accounts.** In the app's settings, under **User Management**, add each Spotify account in the house that you want shown (yours and your wife's).
3. **Secrets.** Copy the Client ID and Client secret into `wall/.env` as `SPOTIFY_CLIENT_ID=` and `SPOTIFY_CLIENT_SECRET=`.
4. **Get the code.** Run `git pull` on the branch, then `docker compose up -d --build` from `wall/`.
5. **Sign in once per account.** From `wall/`, run:
   ```
   docker compose run --rm --no-deps wall-server node dist/spotify-auth.js
   ```
   Open the link, sign in as the first account and approve. Paste back the `127.0.0.1` address the browser lands on; the page itself won't load, which is expected. Run it again for the second account; Spotify offers "Not you?" to switch. Put both tokens in `.env`:
   `SPOTIFY_REFRESH_TOKENS=<first>,<second>`
6. **Config.** In `wall/config/config.yaml`:
   - `spotify: { device: "Kitchen display" }`, using the Hub's name exactly as the Spotify app shows it.
   - `screens: [calendar, cameras, spotify, google-home]`.
7. Run `docker compose up -d --force-recreate wall-server`.
8. Set up the Fully Kiosk app whitelist (section 4).

To check it, run `docker compose logs wall-server | grep spotify`. You should see `Spotify started` with `accounts: 2`; a `Spotify call failed` line names the problem and which account.

## 7. Budget

| Check | Target | Here | Real |
| --- | --- | --- | --- |
| Spotify calls while the tablet is Off | 0 | 0 | |
| Change on Spotify to the wall | about 5 s (one poll) | up to 5 s playing, 10 s idle (fake) | pending |
| Spotify page bundle | No target | about 4 KB | |
| JS heap | 60 MB or less | not measured headless | pending |
