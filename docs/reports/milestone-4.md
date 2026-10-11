# Milestone 4 report: Idle and photos

Oct 11, 2026

Status: code complete. Tested in headless Chromium at 1280 × 800 (dpr 2) against the real server with sharp, a folder of test images, a fake Fully Kiosk, and a fake Wikimedia Commons API. The Docker image builds, and sharp resizes inside it as user `node`. **Not run on the tablet, and the seed script has not run against the real Commons** (this environment's network blocks it).

## 1. What shipped

| Item | Where | Notes |
| --- | --- | --- |
| Idle state machine | `client/src/shell/idle.ts`, `shell/index.tsx` | Active → Idle after `toIdleSec`, Idle → Off after `toOffMin` more, as before. **New:** in quiet hours Idle is skipped and the screen goes Off 1 minute after the last touch (logged `via: quiet`). Entering Idle mounts the photos screen in place of the current one and hides the rail. Any touch while Idle or Off only wakes, and lands on the calendar. |
| Quiet hours on the server | `server/src/providers/kiosk.ts` | Checks every 30 s. At the start of quiet hours it calls `setBooleanSetting motionDetection false`, at the end `true`, and once at start-up to match the clock. A failed call is retried on the next check. A ring and a touch still wake the tablet. |
| Photos provider | `server/src/providers/photos.ts` | `PhotoSource` interface with the `folder` source: image files (jpg, png, webp, tiff) anywhere under `photos.path`, rescanned every 30 minutes. `GET /api/photos/next?w=&h=` returns the next photo in shuffled order (reshuffled when the round ends, never the same photo twice in a row), resized with sharp to the screen size the client sends. Landscape images are cropped to fill the screen; portrait ones keep their shape. Each result is cached on disk (the last 20), and the photo after it is resized in the background, so most requests are answered from disk in a few ms. A file that can't be decoded is skipped until it changes. Photos are logged by a hash id only, never by name. |
| Captions | same | If the folder has a `credits.json` (the seed script writes one), the response carries `X-Photo-Title` and `X-Photo-Credit`. |
| Photos screen | `client/src/screens/photos/` | From the "Idle, art" mockup: full screen, clock and date bottom right, title and artist bottom left. Two stacked images cross-fade (1.5 s) every `photos.intervalSec`. The next image is fetched as a blob and decoded before the fade; the old one is dropped (blob URL revoked) after it. Landscape fills the screen, portrait sits centred on black. With no photos it shows the clock on black. Follows the section 4 contract and the lint rule; its own 1.9 KB bundle. |
| Art seed script | `server/src/seed-art.ts` (built into the image as `dist/seed-art.js`) | Searches Commons for bitmap files in "Google Art Project works" matching "landscape" (directly in the category first, then its subcategories). Keeps only public-domain files (licence tag or Commons' copyright flag), at least 1,920 px wide and wider than tall. Downloads Commons' 3,840 px rendering rather than the originals, which can be hundreds of MB. One download a second, with a proper User-Agent, backing off on 429. Writes `credits.json` with title, artist, date, licence tag and Commons page for each file. Re-running skips what is there and tops up to `--count`. |
| Compose | `docker-compose.yml`, `.env.example` | `PHOTOS_DIR` (default `wall/photos`, git-ignored) mounted read-only at `/data/photos`. |
| Dependency | `server/package.json` | `sharp` 0.34.5 for resizing. Prebuilt for the image's platform; nothing to install on the host. |

## 2. Verified here

| Check | Result |
| --- | --- |
| Idle with 4 s / 15 s timings | Idle at 4 s: rail hidden, photos mounted, first photo in about 1.5 s. Cross-fade every 6 s (test interval). Off 15 s after Idle, `screenOff` sent to Fully. |
| Touch while Idle | Woke to the calendar, the touch was swallowed, rail back. |
| Touch while Off | Woke to the calendar. |
| Decoded photos held | At most 2 at any moment (sampled every 50 ms across several fades), 1 between fades. |
| Photo size requested | `w=2560&h=1600` from a 1280 × 800 viewport at dpr 2. |
| Resize results | 4000 × 2500 landscape → 2560 × 1600 (171 KB); 1500 × 2400 portrait → 1000 × 1600 (62 KB); 3000 × 1600 PNG → 2560 × 1600. First request 110–310 ms, cached ones 3 ms. A broken file was skipped and logged by id. |
| Quiet hours (22:00–06:30, real clock) | No Idle; Off 60 s after the last touch (`via: quiet`). Server sent `motionDetection false` at start-up. |
| Ring during quiet hours while Off | Woke to the calendar with the popup, `sound: "quiet"` (no ding). |
| Seed script against a fake Commons | 12 of 12 images: small, portrait and CC BY-SA files skipped; fell back to subcategories; waited out a 429; HTML stripped from artist and title; a re-run topped up to 14 without duplicates. |
| Docker image | Builds with lint. sharp resizes inside the container as user `node`. |
| Server memory | about 160 MB RSS after a run of 2560 × 1600 resizes (container limit 512 MB). |

## 3. Budget (section 11)

| Measure | Target | Here | Tablet |
| --- | --- | --- | --- |
| Decoded photos held | 2 | 2 at most | pending |
| Leaks across soak cycles (calendar, cameras, photos, clock) | 0 | 0 over a short headless soak (2 cycles). Subscriptions 3 and timers 4 with the clock mounted, the same after each cycle. | pending |
| JS heap over the same soak | none set | 9.5 MB at boot and after each cycle (headless; says nothing about the long-run trend) | pending |

## 4. Deviations and judgment calls to ratify

**contract** marks a change or addition to a section 4, 7 or 10 surface.

| # | Call | Why |
| --- | --- | --- |
| P1 | **contract:** `GET /api/photos/next` takes `w` and `h`, the screen in device pixels (clamped to 320–3840 × 240–3840, default 2560 × 1600). | Section 8 says "resized to the tablet's screen"; the server otherwise doesn't know the screen. The Pixel Tablet asks for 2560 × 1600. |
| P2 | **contract:** the response carries `X-Photo-Title` and `X-Photo-Credit` (URL-encoded) when `credits.json` has the file. | The mockup has a caption. Section 9 says its text is a placeholder, not that it goes. Delete `credits.json` to drop captions. |
| P3 | The rail is hidden while Idle, so the photos fill the screen. | The "Idle, art" mockup is full screen. |
| P4 | Landscape photos are cropped to fill (cover) by the server; portrait ones are scaled to fit and the client centres them on black. A very wide panorama loses its sides. | "Landscape photos fill the screen." |
| P5 | Quiet hours: if the tablet is Idle when quiet hours start, it goes Off within a minute (it has been untouched for longer than that). Waking in quiet hours gives 1 minute before Off again. | Section 8 says Idle is skipped in quiet hours. |
| P6 | Motion detection is set at start-up and at each boundary, and not re-asserted in between. If you turn it on by hand in Fully at night, it stays on until 06:30. | Keeps Fully calls to two a day. |
| P7 | The disk cache lives in the container (`/tmp/wall-photos`, `PHOTOS_CACHE_DIR`), emptied at start-up. | It is only a speed-up; a recreate costs one slow first photo. |
| P8 | Originals over 120 megapixels are skipped (logged by id). | Decoding them could blow the 512 MB container limit. The seed script never downloads such files. |
| P9 | The seed script searches `"landscape"` within "Google Art Project works". Section 8 says "landscape paintings from the Google Art Project category", and Commons has no category for that intersection, so it relies on Commons search. `--search` and `--category` change it. | Untested against the real Commons from here. |
| P10 | The seed script's User-Agent names the GitHub repo as contact. Wikimedia asks for a contact; set `SEED_CONTACT=<email or URL>` to use yours. | |
| P11 | The `photos` screen is in `screens/registry.ts` but not in `screens:`, so it never appears in the rail. The shell mounts it by the id `photos` when Idle. If it is missing, Idle leaves the current screen up, as in milestone 0. | Section 4 registry, section 8 "mounted only in Idle". |
| P12 | The first photo after entering Idle takes up to about 0.3 s (it fades in from black). | The next one is always ready on disk. |

## 5. Set up (in the morning)

1. **Pull and rebuild** (this also brings milestone 3):
   ```sh
   cd ~/code/d-wall/wall
   git pull
   docker compose up -d --build
   ```
2. **Photos folder.** Either keep the default `wall/photos`, or set `PHOTOS_DIR=/path` in `.env`. The container user (uid 1000) must be able to write to it for the seed and read it afterwards:
   ```sh
   mkdir -p photos && sudo chown 1000 photos     # or your PHOTOS_DIR
   ```
3. **Seed the art** (about 150 images, 2–5 minutes, roughly 300–600 MB):
   ```sh
   docker compose run --rm --no-deps -v "$PWD/photos:/seed" wall-server node dist/seed-art.js /seed
   ```
   Use your `PHOTOS_DIR` in place of `$PWD/photos` if you set one. Add `-e SEED_CONTACT=you@example.com` after `--rm` to put your contact in the User-Agent (P10). If it prints "Ran out of search results", re-run with `--search river` or `--search sea` to top up.
4. **Restart** so the server scans the folder: `docker compose restart wall-server`, then `docker compose logs wall-server | grep photos` should show `photos: folder scanned` with `photos: 150`.
5. **Optional:** add your own photos to the same folder at any time; they are picked up within 30 minutes (or on restart). Captions only show for files in `credits.json`.

## 6. Gate checks (on the tablet)

- **Timings match section 8.** With the real config (3 minutes, then 20): leave it alone and watch the log:
  ```sh
  docker compose logs -f --no-log-prefix wall-server | grep '"tablet state"' | jq -c '{tablet, via, time: (.time/1000|todate)}'
  ```
  `idle` 3 minutes after the last touch, `off` 20 minutes later. After 22:00, `off` 1 minute after the last touch (`via: quiet`) and no `idle`.
- **Motion wake.** In the daytime, from Off, walk past: the screen comes on and the calendar shows. At night (after 22:00) walk past: it must stay off. Check `kiosk: quiet hours, motion detection off` in the log, and that the switch shows in Fully's settings. **This depends on the milestone 0 spike S4** (whether `motionDetection` is the right key). If the screen still wakes at night, export Fully's settings, search for "motion", and tell me the key.
- **Wake from Off lands on the calendar**, by touch and by motion.
- **Two decoded photos at most:** compare the heartbeat `heapMB` and Fully's RAM figures on photos against the calendar; they should not climb across many fades.
- **Photos look right:** landscape fills the screen, portrait sits on black, the clock and caption read from across the room.
- **Doorbell during Idle:** ring while photos are showing. The popup should appear over the calendar (`from: "idle"` in `doorbell popup`), inside 3 s.
