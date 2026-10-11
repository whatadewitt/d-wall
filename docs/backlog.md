# Backlog: features after v1

Requests for later. Nothing here is in v1 (spec sections 1-13) or in a milestone until you name it.

## Spotify controller, playing on the Google Nest Hub (requested Oct 11)

A screen on the wall to control Spotify, with the sound coming out of the attached Google Home Hub rather than the tablet.

**Likely shape**
- A new screen (section 4 contract) and a `spotify` provider on the server. The tablet never plays audio itself; it is a remote control.
- The server uses the Spotify Web API: what's playing, play and pause, skip, volume, and "transfer playback" to the Hub.
- The rail gains one icon; nothing else in the shell changes.

**Things to settle first**
- **Account:** controlling playback through the Spotify Web API needs Spotify Premium, and a one-time sign-in that gives the server a refresh token (kept in `.env`).
- **Reaching the Hub:** the Hub is a Google Cast device. The Spotify Web API only lists a Cast device once Spotify has seen it recently, so an idle Hub may not appear as a target. A spike should check this first. If it's unreliable, the fallback is to start the cast through Home Assistant (its Spotify and Cast integrations). That ties this to the parked home screen (section 14), which already plans Home Assistant as the device hub.
- **Doorbell:** pause or duck the music while the doorbell popup is open?
- **Quiet hours:** any limits at night?
