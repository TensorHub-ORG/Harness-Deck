#!/usr/bin/env bash
set -euo pipefail

# Harness-Deck Remote Linux VPS Idempotent Bootstrap Script
# Usage: ./setup-vps.sh [--profile k1]

PROFILE_ARGS=("$@")

echo "[Harness-Deck VPS] Checking Docker & Compose..."
command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is not installed."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: docker compose plugin is not installed."; exit 1; }

if [ ! -f .env ]; then
  echo "ERROR: .env file not found in $(pwd). Upload your generated .env first."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

mkdir -p ./data/mailroom ./data/napcat-o1/ntqq ./napcat-o1/config ./data/napcat-k1/ntqq ./napcat-k1/config

if [ -f onebot11.template.json ]; then
  if [ ! -f ./napcat-o1/config/onebot11.json ]; then
    sed "s/{{ACCESS_TOKEN}}/${NAPCAT_O1_TOKEN:-}/g; s/{{PORT}}/3001/g" onebot11.template.json > ./napcat-o1/config/onebot11.json
  fi
  if [ ! -f ./napcat-k1/config/onebot11.json ]; then
    sed "s/{{ACCESS_TOKEN}}/${NAPCAT_K1_TOKEN:-}/g; s/{{PORT}}/3001/g" onebot11.template.json > ./napcat-k1/config/onebot11.json
  fi
fi

echo "[Harness-Deck VPS] Starting Harness-Deck services..."
docker compose -f docker-compose.vps.yml --env-file .env "${PROFILE_ARGS[@]}" up -d --build

echo ""
echo "=== Harness-Deck VPS Deployment Started ==="
echo "Relay Health:     http://127.0.0.1:${DECK_RELAY_PORT:-8787}/health"
echo "NapCat O1 WebUI:  http://127.0.0.1:${NAPCAT_O1_WEBUI_PORT:-6099}/webui"
echo "Fetch O1 token:   docker logs harness-deck-napcat-o1 2>&1 | grep -i token"
echo "Tip: Use SSH port forwarding from your laptop to scan QR safely without opening WebUI publicly:"
echo "  ssh -N -L 6099:127.0.0.1:${NAPCAT_O1_WEBUI_PORT:-6099} -L 8787:127.0.0.1:${DECK_RELAY_PORT:-8787} <user>@<host>"
