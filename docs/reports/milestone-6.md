# Milestone 6 report: Home screen

Oct 11, 2026

Started at your request. Spec section 14 had this screen parked, and `CLAUDE.md` still says not to build it; you may want to update that line.

Status: code complete. Tested against a fake Home Assistant that speaks its WebSocket and REST APIs (sign-in, `get_states`, `state_changed` events, service calls) in headless Chromium at 1280 × 800. **Not run against a real Home Assistant, your devices or the tablet.** Home Assistant itself still needs its first-run setup on the media server (section 5).

Decided by you, Oct 11, before the build:
- Home Assistant is added to this Docker setup.
- Locks, garage doors and the alarm use hold-then-confirm, with no PIN.

## 1. What shipped

| Item | Where | Notes |
| --- | --- | --- |
| `DeviceHub` | `server/src/homeassistant.ts` | Section 14's interface: `list`, `subscribe`, `command`, plus `connected`. |
| Home Assistant hub | same | Signs in over HA's WebSocket with a non-admin user's long-lived token (`HA_TOKEN` in `.env`). It reads `get_states`, subscribes to `state_changed`, and keeps only the pinned entities. Commands go to `POST /api/services/<domain>/<service>`. Reconnects with the section 11 backoff (1, 2, 5, 10, 30 s with jitter); while Home Assistant is down, every tile goes unavailable and recovers on its own. The token is never logged; a rejected token logs Home Assistant's reason only. |
| Home provider | `server/src/providers/home.ts` | `GET /api/home/devices` returns the rooms from `config.yaml` with each device's state, plus `connected`. `POST /api/home/devices/:id/command` accepts commands only for pinned devices in allowed domains (default: section 14's list). Sensors are read-only. Commands not valid for a device's domain get 400. Every lock, garage and alarm command is logged with its time. `home.changed` carries only the devices that changed. |
| Config | `server/src/config.ts`, `config.example.yaml` | `home: { hub, url, allowedDomains?, rooms }`. Device ids must be entity ids, types are checked, and the 60-tile cap is enforced when the config loads. |
| Home screen | `client/src/screens/home/` | Detail below. Its own 10 KB bundle; follows the section 4 contract and the lint rule. |
| Home Assistant container | `docker-compose.yml` | `ghcr.io/home-assistant/home-assistant:stable`, host networking (H6), config in `wall/homeassistant/` (git-ignored; `HA_CONFIG_DIR` moves it), 1 GB memory limit. |
| Nightly update | `scripts/nightly-update.sh`, `scripts/rollback.sh` | Run by the host's root crontab at 03:00. It backs up Home Assistant's config folder to `wall/backups/` and keeps the last 7. It tags the running image `home-assistant:rollback`, pulls `stable`, and restarts Home Assistant only if the image changed. `rollback.sh` returns to the tagged image in one command; `--restore-config` also restores the newest backup. |

**Home screen behaviour:**
- **Layout:** title, room chips, then a 4-column tile grid. Each tile has an icon, a name and its state. "On" tiles get the accent tint, and unavailable tiles are dimmed.
- **Lights, plugs, fans, media players:** a tap toggles. The tile changes at once and reverts with a red "Didn't respond" mark if Home Assistant hasn't confirmed within 2 s.
- **Lights:** hold 500 ms for a brightness slider; the new value is sent when you let go.
- **Scenes:** a tap runs the scene.
- **Thermostats:** room temperature, the set point, and − / + in 0.5° steps.
- **Sensors:** value and unit, read-only.
- **Blinds (`cover`):** a tap opens or closes.
- **Locks, garage doors, alarm:** hold 1 s (a bar fills across the bottom), then a "Unlock Front door?" sheet with Cancel and a confirm button. A short tap only shows "Press and hold to unlock, open or disarm".
- **Rooms:** a horizontal swipe moves to the next or previous room.
- **Return:** back to the first rail screen after 60 s without touch.
- **Disconnected:** the header shows "Home Assistant unavailable" when it's down.

## 2. Verified here (fake Home Assistant)

| Check | Result |
| --- | --- |
| Commands map to the right services | light toggle, light `turn_on` with `brightness_pct: 35`, `climate.set_temperature 21.5`, `lock.unlock`, `scene.turn_on` |
| Refusals | sensor 403, unpinned entity 404, `on` sent to a scene 400, set point 99 rejected 400 |
| Pinned device missing in Home Assistant | Shown as Unavailable; logged once as `pinned devices not found` |
| Optimistic tap | Tile flipped in under 150 ms. With Home Assistant confirming 3 s late it reverted at 2 s with "Didn't respond", then showed the real state when the confirmation arrived. |
| Hold to confirm | A short tap gave only the hint. A 1.1 s hold opened "Unlock Front door?". Confirm called `lock.unlock`, and the server logged `risky command` with the time. |
| Home Assistant stopped and restarted | Tiles unavailable within about 1 s; commands got 503; reconnected and all states back within 12 s. |
| Bug found and fixed | Node's built-in WebSocket fires only `error`, never `close`, when the connection is refused, so the first version never retried. Either event now ends an attempt, and a connection that doesn't finish signing in within 10 s is dropped. |
| Bad token | Rejected and retried with backoff; the token appears nowhere in the log. |
| Update scripts (with a stand-in `docker`) | Backup made and trimmed to 7; image tagged before the pull; restart only when the image changed; rollback retags and restarts. Also fixed: with no `.env`, `pipefail` made the script exit silently. |
| Lint, typecheck, build | Clean |

## 3. Deviations and judgment calls to ratify

**contract** marks an addition to a protected surface. Section 14 isn't one of them, but its interface reads like a contract, so I've marked these the same way.

| # | Call | Why |
| --- | --- | --- |
| H1 | **contract:** `Command` gains `{ type: 'temperature'; value }` for thermostats. | Section 14's command set has no way to change a set point. |
| H2 | On and off map per domain: lock on = lock, off = unlock; cover and garage on = open, off = close; alarm on = arm away, off = disarm. An alarm that needs a code to disarm will be refused by Home Assistant, and the tile shows "Didn't respond". | Section 14 doesn't define these. Arm *away* is the safe default; arm home could be added as its own tile type. |
| H3 | A tile's behaviour comes from its `type` in `config.yaml`. `garage` and `alarm` are types of their own, rather than read from Home Assistant's `device_class`. | It's explicit, and you can see it in the config. |
| H4 | **contract:** `GET /api/home/devices` returns `{ connected, rooms: [{ name, devices: [{ id, name, type, state }] }] }`. | Section 14 doesn't give the shape; the screen needs the rooms. |
| H5 | The 2 s confirm window applies to lights, plugs, fans, media players, brightness and set points. Locks, garage doors and blinds get 15 s and are confirmed by any change from Home Assistant. Scenes are confirmed by any change. | A garage door or lock can take longer than 2 s to report. |
| H6 | Home Assistant uses host networking, so it can find devices (mDNS, Matter, casting). Its web page therefore listens on every interface of the media server, port 8123. To keep it on the LAN only (section 10's rule), add `http: server_host: <LAN address>` to `wall/homeassistant/configuration.yaml`, or block 8123 at the firewall. | Bridge networking breaks device discovery. |
| H7 | The updater is a small script run from the host's crontab, not a third-party updater container. It updates Home Assistant only; **go2rtc stays pinned at 1.9.9** (section 14 says both). | No updater container needs the Docker socket, so there's nothing third-party to keep maintained (Watchtower is no longer maintained). wall-server depends on go2rtc details tested in milestone 2 (inline config, runtime streams), so go2rtc updates should be deliberate. |
| H8 | No Matter server container yet. If your devices are Matter, Home Assistant needs `python-matter-server` beside it. | The device list (section 14's open item) will tell. |
| H9 | There's no mockup for this screen. It follows the other screens: the same header, pills, cards and accent. | |
| H10 | "Back to the calendar after 60 s" goes to the first rail screen, as in J12 and L12. | |
| H11 | Media players only toggle on and off; there are no transport controls. | Section 14 lists only on, off and toggle. |

## 4. Budget and gate

| Check | Target | Here | Real |
| --- | --- | --- | --- |
| Tap changes the real device; tile confirms | 2 s | about 150 ms (fake) | pending |
| Change made in Google Home or at the wall switch shows on the tablet | 2 s | about 50 ms push (fake) | pending |
| JS heap | 60 MB or less | not measured headless | pending |
| Added using only the section 4 steps | yes | yes: `screens/home/`, one registry line, `providers/home.ts`, one provider line, `home` in `screens:` | |

## 5. Setting it up (on the media server)

1. **Get the code.** After merging, run `git checkout main && git pull`, then `docker compose up -d --build` from `wall/`. This starts Home Assistant.
2. **First run.** Open `http://<media server>:8123` and create your owner account.
3. **Add your devices** through Home Assistant's integrations (Settings, Devices & services). This is section 14's open item: check each Google Home device. Matter devices can be paired to Home Assistant as well as Google Home. Tell me if any are Matter (H8).
4. **The wall's own user.** Go to Settings, People, Add person, turn on "Allow person to login", and leave it **not** an administrator. Log in as that user, then Profile, Security, Long-lived access tokens, Create. Put the token in `wall/.env` as `HA_TOKEN=...`.
5. **Pin the devices.** In `wall/config/config.yaml`, add a `home:` block (the example file shows it). Entity ids are listed under Settings, Entities. Add `home` to `screens:` to put it in the rail, then run `docker compose up -d --force-recreate wall-server`.
6. **Nightly update.** Run `sudo crontab -e` and add:
   `0 3 * * * /home/<you>/code/d-wall/wall/scripts/nightly-update.sh >> /home/<you>/code/d-wall/wall/backups/update.log 2>&1`
7. **Optional, LAN-only** (H6): add `http: server_host: <LAN address>` to `wall/homeassistant/configuration.yaml`, then run `docker compose restart homeassistant`.

Check it with `docker compose logs wall-server | grep '"home"'`. You should see `connected to Home Assistant`, and a `missing entities` line naming any id that's wrong or not visible to the wall's user.
