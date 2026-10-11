#!/usr/bin/env bash
# Nightly Home Assistant update (spec section 14). Run as root from the host's crontab at 03:00:
#   0 3 * * * /home/you/code/d-wall/wall/scripts/nightly-update.sh >> /home/you/code/d-wall/wall/backups/update.log 2>&1
# 1. Copies Home Assistant's config folder to backups/ and keeps the last 7 copies.
# 2. Tags the running image as home-assistant:rollback, so scripts/rollback.sh can return to it.
# 3. Pulls the newest stable image and restarts Home Assistant only if it changed.
# go2rtc stays pinned in docker-compose.yml (see the milestone 6 report).
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=ghcr.io/home-assistant/home-assistant:stable
HA_DIR=$( { sed -n 's/^HA_CONFIG_DIR=//p' .env 2>/dev/null || true; } | tail -1)
HA_DIR=${HA_DIR:-./homeassistant}
STAMP=$(date +%Y%m%d-%H%M)

echo "== $(date -Is) nightly update"
mkdir -p backups
if [ -d "$HA_DIR" ]; then
  tar -czf "backups/homeassistant-$STAMP.tgz" -C "$HA_DIR" .
  echo "backed up $HA_DIR to backups/homeassistant-$STAMP.tgz"
  ls -1t backups/homeassistant-*.tgz | tail -n +8 | xargs -r rm --
fi

before=$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || echo none)
if [ "$before" != none ]; then
  docker tag "$IMAGE" home-assistant:rollback
fi
docker compose pull --quiet homeassistant
after=$(docker image inspect -f '{{.Id}}' "$IMAGE")
if [ "$before" = "$after" ]; then
  echo "Home Assistant is up to date"
else
  docker compose up -d homeassistant
  echo "Home Assistant updated; the previous image is tagged home-assistant:rollback"
fi
