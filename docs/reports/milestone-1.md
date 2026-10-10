# Milestone 1 report: Calendar

Oct 10, 2026

Status: code complete. It was tested end to end against a fake Google API that checks the signed token and serves sample events, in headless Chromium at 1280 × 800. **It has not yet run against your real Google calendars** (this environment has no key and no route to Google) **or on the tablet.** The milestone 1 gate numbers still need the tablet.

Milestone 1 was started before the milestone 0 soak gate passed, at your request (K1).

## 1. What shipped

| Item | Where | Notes |
| --- | --- | --- |
| Google client | `server/src/google.ts` | Logs in as the service account with a signed JWT built with `node:crypto`; there is no Google SDK (K5). Read-only scope. The token is cached for its hour, and parallel calls share one token request. `events.list` runs with `singleEvents=true`, follows every page, asks only for the fields used, and has a 10 s timeout. |
| Calendar provider | `server/src/providers/calendar.ts` | Polls every 60 s, and again at once when a client connects or the tablet wakes (skipped if a poll ran in the last 5 s). Covers last week, this week and 8 weeks ahead (K4). Cancelled and declined events are dropped. Results are normalized, merged and hashed, and `calendar.changed` is published when the hash changes. Each calendar keeps its last good result. When any calendar fails, the provider sets `stale` in `/api/state` and publishes `state`. |
| `GET /api/calendar/events?from&to` | same | Returns a plain array of normalized events in the section 5 shape. `from` and `to` are inclusive dates in the configured time zone (K3). |
| Calendar screen | `client/src/screens/calendar/` | Section 5 and the mockup (detail below). It follows the section 4 contract, passes the lint rule, and is its own 12 KB bundle. |
| Docker | `docker-compose.yml`, `.env.example` | The key file is mounted read-only from `GOOGLE_SA_KEY_FILE` (a path on the server) to `/run/secrets/google-service-account.json`. Compose now refuses to start without it (K22). |
| Heartbeat | `shell/index.tsx`, `server/src/index.ts` | Adds `lastSwitch: {screen, ms}`, the time from a rail tap to the first frame after mount (K16). |

**Calendar screen behaviour** (all tested headless):

- Header: week range, previous/next arrows, Today, and a Week chip in day view. Also the legend with calendar shapes, the clock and date, and the stale note when it applies.
- An all-day row, then 7 day columns over a 24-hour grid. Today's column is tinted and has the now-line, dot and time pill. Events ending before now today are dimmed (K11).
- Overlapping events sit side by side. In the test, three overlapping events packed into three columns.
- Opening the calendar scrolls the current time to about a third of the way down. Other weeks open at 07:00.
- A swipe of more than 80 px, or a flick (over 0.5 px/ms and more than 30 px), moves one week with a 200 ms slide that continues from the finger. Shorter drags spring back. Vertical drags scroll natively (`touch-action: pan-y`). Arrows slide the same way, and a swipe never also counts as a tap.
- Tapping a day header opens day view. Swipes and arrows there move one day, and the Week chip returns.
- Tapping an event opens a read-only sheet: calendar, title, time, place, and the first 300 characters of the description. A tap inside the sheet does nothing; a tap outside closes it.
- After 60 s without touch on any other week, or in day view, it returns to this week's week view. Tested: it returns 60–70 s after the last touch, because the check runs every 10 s.
- The client keeps the visible week plus one either side, and drops the rest. `calendar.changed` refetches only those weeks. The screen also refetches them every 60 s, which is how it proves contact with the server for the stale note (K13).
- The stale note: with the server stopped for 7 simulated minutes it showed "Not updated since 9:58 PM", the events stayed visible, and the note cleared on its own when the server came back.
- The cache survives unmount, so switching back paints at once (K12).

## 2. Measured against the section 11 budget

These are headless desktop Chromium numbers, not the tablet.

| Measure | Target | Headless result | Tablet |
| --- | --- | --- | --- |
| New Google event visible | 90 s or less | 26 s (one poll cycle plus push) | pending |
| JS heap, calendar showing | 60 MB or less | 3.4 MB | pending |
| DOM nodes, one week | 1,500 or less | 150 (about 15 events) | pending |
| Switch to calendar, first paint | 300 ms or less | 62 ms, Clock → Calendar from cache | pending |
| Leaks, mount/unmount | 0 | 0 after 30 simulated soak cycles of calendar plus clock. Subscription, timer and DOM counts returned to the clock's own each time. | pending |

## 3. Deviations and judgment calls to ratify

**contract** marks an addition to a section 4, 7 or 10 surface.

| # | Call | Why | Alternative |
| --- | --- | --- | --- |
| K1 | Milestone 1 started before the milestone 0 24 h soak passed. | You asked to see the calendar before the tablet arrived. The soak now covers the calendar too. | |
| K2 | **contract** Calendar entries in `config.yaml` take an optional `name` for the legend, defaulting to the id. | The mockup legend shows "Me", "Kid 1"; ids like `holidays-ca` don't read well. | Derive labels from ids. |
| K3 | **contract** `/api/calendar/events`: `from` and `to` are both inclusive. The response is a bare array. A range over 70 days, or `to` before `from`, returns 400. | Section 10 doesn't define the range semantics. | `to` exclusive. |
| K4 | The window is last week, this week and 8 weeks ahead (10 weeks, matching the section 1 ruling). The arrows and swipes stop at its edges. | Beyond the window the server holds nothing, so a week there would wrongly look empty. | Fetch from Google on demand outside the window. |
| K5 | Service account login is a signed JWT made with `node:crypto`, not the `googleapis` package. | `googleapis` is a very large dependency for one read-only call. | Use `google-auth-library`. |
| K6 | Google descriptions (which can be HTML) are converted to plain text on the server. | The client never handles HTML. | |
| K7 | All-day events, and timed events of 24 hours or more, go in the all-day row. Shorter timed events that cross midnight are split across the two days in the grid. | Section 5 says "multi-day events span the all-day row" but not where the line is. | |
| K8 | The all-day row shows up to 3 lanes. Anything more becomes a "+N" label under that day, and it isn't tappable. | It keeps the hour grid usable. | Make "+N" open day view. |
| K9 | Each calendar's shape comes from its order in `config.yaml`: circle, rounded square, diamond, triangle. | Section 9 lists the four shapes in that order. | Add a `shape` key per calendar. |
| K10 | **Question:** an event that appears on two shared calendars (say, a meeting both you and a child are invited to) shows once per calendar, in each colour. | Section 5 says "merge" but not whether to dedupe. | Dedupe by Google's `iCalUID` and show it once. |
| K11 | Events that ended earlier today are drawn at 50% opacity. Past days are not dimmed. | That's what the mockup does ("Planning" on today). | |
| K12 | The "shell keeps the last calendar events across unmounts" rule is implemented as module state in `screens/calendar/cache.ts`. The module stays loaded after its first import. It's bounded to the visible week plus one either side. | Keeping it in the shell would mean adding a store to `ScreenContext`, which changes section 4. | Add a cache to the contract. |
| K13 | The stale note shows when the client's last successful fetch is over 5 minutes old, **or** when the server reports Google as stale with its last success over 5 minutes ago. It shows the older of the two times. | Otherwise a Google outage would leave old data with no sign of it. Known gap: if Google has never succeeded since the server started, there's nothing to show and no note. | Only the server-contact rule from section 5. |
| K14 | An event block shows its time line only when it's 75 minutes or longer. Titles are one line with an ellipsis. | That matches the mockup. | |
| K15 | Where the mockup is below the section 9 sizes, the mockup wins: the "all day" label is 12 px (section 9 says 13 at the smallest) and all-day chip titles are 16 px (event titles are 18). | Section 9 says the mockups win. | Use 13 and 18. |
| K16 | **contract** The heartbeat gains `lastSwitch`. | It's the measurement for the 300 ms switch gate. | |
| K17 | My `config.yaml` change in this milestone is only the `screens:` line and two comment lines, kept away from the calendar lines so your pull merges cleanly (checked with a 3-way merge). **Recommendation:** git-ignore the real `config.yaml` and commit a `config.example.yaml`, so future pulls never touch your values. | `config.yaml` holds real ids and addresses that differ per install. | Changes the section 10 layout, so it's your call. |
| K18 | The event sheet has no close button; only tapping outside closes it. | That's what section 5 says. | |
| K19 | The server polls every 60 s even while the tablet is Off. | Section 5 doesn't say to pause, and it's cheap. | Pause while Off, and rely on the wake poll. |
| K20 | Calendar times are shown in the `config.yaml` time zone, not the device's. | Single tablet, single home. | |
| K21 | `screens: [calendar]`, so the template clock is no longer in the rail. It's still registered, and the soak still mounts it. | Section 10 sketch. | |
| K22 | `GOOGLE_SA_KEY_FILE` is required by compose now. | The calendar doesn't work without it. | |

## 4. Deploy

On the media server, in `~/d-wall/wall`:

```sh
git stash && git pull && git stash pop    # keeps your config.yaml edits; verified to merge cleanly
```

Then:

1. In `.env`, add `GOOGLE_SA_KEY_FILE=/full/path/to/google-service-account.json`.
2. Make the key readable by uid 1000, the container user, without opening it to everyone. Check the owner with `ls -n <file>`. If it isn't 1000, run `sudo chown 1000 <file> && chmod 600 <file>`.
3. Optionally, add `name: "…"` to each calendar line in `config.yaml` for the legend.
4. Run `docker compose up -d --build`.
5. Check the first poll: `docker compose logs wall-server | grep calendar`.
   - `"calendar changed"` with `failed: 0` means it's working.
   - `calendar poll failed` with `http: 404` means the calendar isn't shared with the service account, or the id is wrong.
   - `http: 403` means the Calendar API isn't enabled.
   - `reason: ENOTFOUND` means the server has no DNS or internet.
6. Reload the page on the laptop.

## 5. Gate checks on the tablet

- **New event within 90 s.** Create an event in Google Calendar and time how long it takes to appear.
- **Heap 60 MB or less.** Read `heapMB` from heartbeats while the calendar is showing:
  ```sh
  docker compose logs --no-log-prefix wall-server | grep '"heartbeat"' | jq '.telemetry | {screen, heapMB, domNodes}'
  ```
- **Switch 300 ms or less.** There's only one rail screen now, so set `screens: [calendar, example-clock]` temporarily. Tap Clock, then Calendar, and read `lastSwitch` from the next heartbeat. Set it back afterwards.
- **Open item from the spec:** confirm each child's calendar could be shared with the service account. Family Link accounts may block it.
