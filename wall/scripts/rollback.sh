#!/usr/bin/env bash
# Return Home Assistant to the image it ran before the last nightly update (spec section 14).
#   scripts/rollback.sh                 previous image, current config
#   scripts/rollback.sh --restore-config   also restore the newest config backup (Home Assistant is stopped first)
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=ghcr.io/home-assistant/home-assistant:stable
HA_DIR=$( { sed -n 's/^HA_CONFIG_DIR=//p' .env 2>/dev/null || true; } | tail -1)
HA_DIR=${HA_DIR:-./homeassistant}

docker image inspect home-assistant:rollback >/dev/null 2>&1 || { echo "no home-assistant:rollback image yet"; exit 1; }
docker tag home-assistant:rollback "$IMAGE"
if [ "${1:-}" = "--restore-config" ]; then
  latest=$(ls -1t backups/homeassistant-*.tgz | head -1)
  docker compose stop homeassistant
  echo "restoring $latest into $HA_DIR"
  find "$HA_DIR" -mindepth 1 -delete
  tar -xzf "$latest" -C "$HA_DIR"
fi
docker compose up -d homeassistant
echo "Home Assistant is back on the previous image"
